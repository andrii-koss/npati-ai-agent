import type { AuthContext, CodeSession, CodeSessionInput, CodeSessionStatus, CodeToolchain, DataClassification, Project, ProjectCodeSettings, RetentionClass, WorkspaceStore } from "@npati/workspace";
import { DATA_CLASSIFICATIONS, DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS, RETENTION_CLASSES, isClassificationAtLeast } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import type { ProjectWorkspace } from "./project-workspace";
import { TOOLCHAIN_MANIFEST_FILES, detectToolchain } from "./code-toolchain-detector";
import { resolveCodeAgentLimits, type CodeAgentLimits } from "./code-agent-config";
import { currentToolManifest } from "./code-tool-registry";
import { hasAdminPermission } from "./code-rbac";
import { redactTerminalText } from "./terminal-command-policy";
import { CODE_AGENT_MASTER_FLAG, FeatureDisabledError } from "./feature-flags";

/** Structured error so every code entry point fails predictably (rule 9). */
export class CodeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryable = false,
  ) { super(message); }
}

export interface CreateCodeProjectInput {
  name: string;
  description?: string;
  repositoryUrl?: string;
  branch?: string;
  credentialId?: string;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
}

export interface UpdateCodeProjectInput {
  expectedRevision: number;
  toolchain?: CodeToolchain;
  verifyCommands?: CodeToolchain["verifyCommands"];
  defaultBranch?: string;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
}

export interface CodeSessionWithProject extends CodeSession { projectName?: string; }

/**
 * C1: code project and code session lifecycle.
 *
 * Deliberately contains no tools and no agent loop: it prepares the project (type, toolchain,
 * classification), imports a repository through the existing Website Builder import path, and manages
 * CodeSession records that the runner will drive in C6. Every method re-checks ownership on the
 * server (never trusting ids coming from the client).
 */
export class CodeService {
  private readonly limits: CodeAgentLimits;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly projects: ProjectService,
    private readonly workspace: ProjectWorkspace,
    private readonly importer?: { importRepository(ctx: AuthContext, companyId: string, projectId: string, input: { url: string; branch?: string; credentialId?: string }): Promise<unknown> },
    limits?: Partial<CodeAgentLimits>,
    /**
     * C1c: privileged code actions are audited. The journal is written *before* the action, so an
     * audit outage refuses the action instead of performing it unaudited (fail closed).
     */
    private readonly audit?: { record(ctx: AuthContext, input: { companyId: string; actor: string; actorRole: string; action: string; resourceType: string; resourceId?: string; projectId?: string; decision: "allowed" | "denied" | "approved" | "rejected"; payload?: unknown; metadata?: Record<string, unknown> }): Promise<unknown> },
    /**
     * C1a: every mutation additionally passes the feature-flag gate. When the flag service is missing
     * the service denies instead of allowing: an unconfigured deployment is a dark deployment.
     */
    private readonly flags?: { assertEnabled(ctx: AuthContext, flagKey: string, options?: { companyId?: string; userId?: string }): Promise<true> },
  ) {
    this.limits = { ...resolveCodeAgentLimits(), ...limits };
  }

  /** Deny-by-default gate applied by every state-changing code action. */
  private async assertWriteEnabled(ctx: AuthContext, companyId: string, subFlag: "code.write" | "code.read") {
    if (!this.flags) throw new FeatureDisabledError(CODE_AGENT_MASTER_FLAG, "Coding Agent is disabled: feature flags are not configured");
    await this.flags.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId });
    await this.flags.assertEnabled(ctx, subFlag, { companyId });
  }

  private async auditCodeAction(ctx: AuthContext, companyId: string, action: string, resourceType: string, resourceId: string | undefined, projectId: string | undefined, payload: unknown, metadata: Record<string, unknown> = {}) {
    if (!this.audit) return;
    await this.audit.record(ctx, {
      companyId, actor: ctx.userId, actorRole: this.canLowerClassification(ctx) ? "admin" : "user",
      action, resourceType, resourceId, projectId, decision: "allowed", payload, metadata,
    });
  }

  /** Exposed for the UI so the configured limits are visible, never hardcoded in the client. */
  getLimits(): CodeAgentLimits { return { ...this.limits }; }

  private canWrite(ctx: AuthContext): boolean {
    return ctx.permissions.some((permission) => ["*", "owner", "admin:all", "business:manage", "workspace:write"].includes(permission));
  }

  /** Lowering the classification of a project or session needs an administrative role (C5a refines this). */
  private canLowerClassification(ctx: AuthContext): boolean {
    return hasAdminPermission(ctx.permissions);
  }

  private assertWrite(ctx: AuthContext) {
    if (!this.canWrite(ctx)) throw new CodeError("code_write_denied", "Coding Agent write permission denied", 403);
  }

  private assertClassification(value: unknown): DataClassification {
    if (typeof value !== "string" || !DATA_CLASSIFICATIONS.includes(value as DataClassification)) {
      throw new CodeError("invalid_data_classification", `Data classification must be one of: ${DATA_CLASSIFICATIONS.join(", ")}`, 400);
    }
    return value as DataClassification;
  }

  private assertRetention(value: unknown): RetentionClass {
    if (typeof value !== "string" || !RETENTION_CLASSES.includes(value as RetentionClass)) {
      throw new CodeError("invalid_retention_class", `Retention class must be one of: ${RETENTION_CLASSES.join(", ")}`, 400);
    }
    return value as RetentionClass;
  }

  /** Reads the manifest files the detector needs, ignoring files that do not exist. */
  private async readManifests(ctx: AuthContext, companyId: string, projectId: string): Promise<Record<string, string | undefined>> {
    const files: Record<string, string | undefined> = {};
    // One tree walk instead of one failed access/read per manifest: the detector's 24-path list made a static
    // project pay for 22 guaranteed ENOENT round trips before its first model call.
    const present = typeof this.workspace.listFiles === "function"
      ? new Set((await this.workspace.listFiles(ctx, companyId, projectId)).filter(entry => entry.type === "file").map(entry => entry.path))
      : undefined;
    for (const path of TOOLCHAIN_MANIFEST_FILES) {
      if (present && !present.has(path)) continue;
      try {
        const file = await this.workspace.readFile(ctx, companyId, projectId, path);
        files[path] = file.content;
      } catch (error) {
        const failure = error as { code?: string; status?: number; message?: string } | null;
        if (failure?.code === "ENOENT" || failure?.code === "file_not_found" || failure?.status === 404
          || (error instanceof Error && /^(?:not found|ENOENT)$/i.test(error.message))) continue;
        throw new CodeError("toolchain_detection_failed", "Cannot read project manifests. Check workspace access and retry detection.", 503, true);
      }
    }
    return files;
  }

  /** Detects the toolchain of a workspace and persists it as project metadata. */
  async detectAndPersist(ctx: AuthContext, companyId: string, projectId: string): Promise<Project> {
    const project = await this.projects.get(ctx, companyId, projectId);
    const files = await this.readManifests(ctx, companyId, projectId);
    const detection = detectToolchain({ files });
    const toolchain: CodeToolchain = { ...detection, source: "detected", detectedAt: new Date().toISOString() };
    return this.projects.updateCodeSettings(ctx, companyId, projectId, project.revision, { toolchain, defaultBranch: project.defaultBranch ?? undefined });
  }

  /**
   * Creates a code project. When a repository URL is supplied the existing import path clones it
   * (private repositories go through the Company vault credential), then the toolchain is detected
   * from the resulting workspace.
   */
  async createProject(ctx: AuthContext, companyId: string, input: CreateCodeProjectInput, idempotencyKey?: string): Promise<Project> {
    this.assertWrite(ctx);
    await this.assertWriteEnabled(ctx, companyId, "code.write");
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 200) throw new CodeError("invalid_name", "Project name must be between 1 and 200 characters", 400);
    const dataClassification = input.dataClassification === undefined ? DEFAULT_DATA_CLASSIFICATION : this.assertClassification(input.dataClassification);
    const retentionClass = input.retentionClass === undefined ? DEFAULT_RETENTION_CLASS : this.assertRetention(input.retentionClass);
    const repositoryUrl = typeof input.repositoryUrl === "string" ? input.repositoryUrl.trim() : "";
    if (repositoryUrl && !/^(https:\/\/|git@)[^\s]+$/.test(repositoryUrl)) {
      throw new CodeError("invalid_repository_url", "Repository URL must be an https:// or git@ URL", 400);
    }

    // Authorize the Company and persist the audit decision before creating project/backend state.
    await this.store.getCompany(ctx, companyId);
    await this.auditCodeAction(ctx, companyId, "code.project.create", "code_project", undefined, undefined,
      { name, type: "code_project", repositoryUrl: repositoryUrl || null, branch: input.branch?.trim() || null, dataClassification, retentionClass },
      { phase: "before_create" });

    const created = await this.projects.create(ctx, companyId, {
      name, type: "code_project", description: input.description?.trim() || undefined,
      dataClassification, retentionClass, defaultBranch: input.branch?.trim() || undefined,
    }, idempotencyKey ?? `code-${ctx.userId}-${name}-${repositoryUrl || "empty"}`);

    if (repositoryUrl) {
      if (!this.importer) throw new CodeError("project_import_unavailable", "Repository import is unavailable", 503, true);
      try {
        await this.importer.importRepository(ctx, companyId, created.project.id, {
          url: repositoryUrl, branch: input.branch?.trim() || undefined, credentialId: input.credentialId,
        });
      } catch (error) {
        // The project stays (the owner can retry the import), but the failure is structured and
        // never carries credentials: import services already redact git output.
        throw new CodeError("repository_import_failed", error instanceof Error ? redactTerminalText(error.message) : "Repository import failed", 502, true);
      }
    }

    return this.detectAndPersist(ctx, companyId, created.project.id);
  }

  async listProjects(ctx: AuthContext, companyId: string, includeArchived = false): Promise<Project[]> {
    const projects = await this.projects.list(ctx, companyId, includeArchived);
    return projects.filter((project) => project.type === "code_project");
  }

  /** User edits: toolchain/verify commands, default branch, classification and retention. */
  async updateProject(ctx: AuthContext, companyId: string, projectId: string, input: UpdateCodeProjectInput): Promise<Project> {
    this.assertWrite(ctx);
    await this.assertWriteEnabled(ctx, companyId, "code.write");
    const project = await this.projects.get(ctx, companyId, projectId);
    if (!Number.isInteger(input?.expectedRevision) || input.expectedRevision < 1) throw new CodeError("invalid_revision", "expectedRevision is required", 400);
    const code: ProjectCodeSettings = {};
    if (input.toolchain) {
      code.toolchain = {
        languages: Array.isArray(input.toolchain.languages) ? input.toolchain.languages.filter((value) => typeof value === "string").slice(0, 20) : [],
        packageManagers: Array.isArray(input.toolchain.packageManagers) ? input.toolchain.packageManagers.filter((value) => typeof value === "string").slice(0, 20) : [],
        verifyCommands: sanitizeVerifyCommands(input.verifyCommands ?? input.toolchain.verifyCommands),
        source: "manual",
        detectedAt: new Date().toISOString(),
        evidence: Array.isArray(input.toolchain.evidence) ? input.toolchain.evidence.filter((value) => typeof value === "string").slice(0, 40) : [],
      };
    } else if (input.verifyCommands && project.toolchain) {
      code.toolchain = { ...project.toolchain, verifyCommands: sanitizeVerifyCommands(input.verifyCommands), source: "manual", detectedAt: new Date().toISOString() };
    }
    if (typeof input.defaultBranch === "string") {
      const branch = input.defaultBranch.trim();
      if (branch.length > 200) throw new CodeError("invalid_branch", "Branch name is too long", 400);
      code.defaultBranch = branch;
    }
    if (input.dataClassification) {
      const next = this.assertClassification(input.dataClassification);
      if (!isClassificationAtLeast(next, project.dataClassification) && !this.canLowerClassification(ctx)) {
        throw new CodeError("classification_downgrade_denied", "Lowering data classification requires an administrative role", 403);
      }
      code.dataClassification = next;
    }
    if (input.retentionClass) {
      const next = this.assertRetention(input.retentionClass);
      if (!this.canLowerClassification(ctx) && retentionRank(next) < retentionRank(project.retentionClass)) {
        throw new CodeError("retention_downgrade_denied", "Shortening retention requires an administrative role", 403);
      }
      code.retentionClass = next;
    }
    await this.auditCodeAction(ctx, companyId, "code.project.update", "code_project", projectId, projectId,
      { expectedRevision: input.expectedRevision, defaultBranch: code.defaultBranch ?? null, dataClassification: code.dataClassification ?? null, retentionClass: code.retentionClass ?? null, verifyCommands: code.toolchain?.verifyCommands ?? null },
      { toolchainSource: code.toolchain?.source ?? null, languages: code.toolchain?.languages ?? [] });
    return this.projects.updateCodeSettings(ctx, companyId, projectId, input.expectedRevision, code);
  }

  // --- sessions ----------------------------------------------------------------------------

  async createSession(ctx: AuthContext, companyId: string, projectId: string, input: CodeSessionInput = {}): Promise<CodeSession> {
    this.assertWrite(ctx);
    await this.assertWriteEnabled(ctx, companyId, "code.write");
    const project = await this.projects.get(ctx, companyId, projectId);
    if (project.status === "archived") throw new CodeError("project_archived", "Cannot start a session in an archived project", 409);
    if (input.dataClassification !== undefined) this.assertClassification(input.dataClassification);
    await this.auditCodeAction(ctx, companyId, "code.session.create", "code_session", undefined, projectId,
      { projectId, mode: input.mode ?? "edit", modelProfile: input.modelProfile ?? null, dataClassification: input.dataClassification ?? project.dataClassification });
    // Pin in the original insert: an independent failed update must never expose an unpinned session.
    return this.store.createCodeSession(ctx, companyId, projectId, {
      ...input, toolManifestVersion: currentToolManifest().version,
    });
  }

  async getSession(ctx: AuthContext, companyId: string, sessionId: string): Promise<CodeSession> {
    return this.store.getCodeSession(ctx, companyId, sessionId);
  }

  async listSessions(ctx: AuthContext, companyId: string, projectId?: string, options: { includeArchived?: boolean; limit?: number } = {}): Promise<CodeSession[]> {
    return this.store.listCodeSessions(ctx, companyId, projectId, options);
  }

  async listSessionsWithProjects(ctx: AuthContext, companyId: string, projectId?: string): Promise<CodeSessionWithProject[]> {
    const [sessions, projects] = await Promise.all([
      this.store.listCodeSessions(ctx, companyId, projectId, { includeArchived: true }),
      this.projects.list(ctx, companyId, true),
    ]);
    const names = new Map(projects.map((project) => [project.id, project.name]));
    return sessions.map((session) => ({ ...session, projectName: names.get(session.projectId) }));
  }

  async updateSessionStatus(ctx: AuthContext, companyId: string, sessionId: string, status: CodeSessionStatus, summary?: string): Promise<CodeSession> {
    this.assertWrite(ctx);
    // Status transitions of a running session belong to the agent loop (C6); archiving stays a
    // History-management action and is therefore allowed while the feature is dark.
    if (status !== "archived") await this.assertWriteEnabled(ctx, companyId, "code.write");
    const session = await this.store.getCodeSession(ctx, companyId, sessionId);
    if (session.status === "archived" && status !== "archived") throw new CodeError("session_archived", "Archived sessions cannot be reactivated in C1", 409);
    await this.auditCodeAction(ctx, companyId, `code.session.${status === "archived" ? "archive" : "status"}`, "code_session", sessionId, session.projectId,
      { sessionId, from: session.status, to: status });
    return this.store.updateCodeSession(ctx, companyId, sessionId, { status, summary });
  }

  /** Archive keeps the record (and its classification/retention) but hides it from active lists. */
  async archiveSession(ctx: AuthContext, companyId: string, sessionId: string): Promise<CodeSession> {
    return this.updateSessionStatus(ctx, companyId, sessionId, "archived");
  }
}

function sanitizeVerifyCommands(input: CodeToolchain["verifyCommands"] | undefined): CodeToolchain["verifyCommands"] {
  const result: CodeToolchain["verifyCommands"] = {};
  if (!input || typeof input !== "object") return result;
  for (const key of ["test", "lint", "typecheck", "build"] as const) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() && value.length <= 300) result[key] = value.trim();
  }
  return result;
}

const RETENTION_RANK: Record<RetentionClass, number> = { ephemeral: 0, short: 1, standard: 2, extended: 3, until_deleted: 4 };
function retentionRank(value: RetentionClass): number { return RETENTION_RANK[value] ?? 0; }
