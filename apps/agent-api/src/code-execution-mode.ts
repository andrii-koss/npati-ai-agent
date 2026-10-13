import path from "node:path";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import { isAdminPrincipal } from "./code-rbac";
import type { AuditLogService } from "./audit-log";

export type CodeExecutionMode = "global" | "company" | "sandbox";
export const CODE_EXECUTION_MODES = ["global", "company", "sandbox"] as const;
interface StoredMode { mode: CodeExecutionMode; creatorProjectId?: string; creatorSessionId?: string }
export interface CodeExecutionModeView extends StoredMode {
  revision: number;
  canSelectGlobal: boolean;
  sourceAccessGranted: boolean;
  creatorConfigured: boolean;
}
export class CodeExecutionModeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 403) { super(message); }
}

/** Execution scope is independent of feature-flag rollout scope. Company is the default. */
export class CodeExecutionModeService {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly canManageCompany: (ctx: AuthContext, companyId: string) => Promise<boolean>,
    private readonly audit?: AuditLogService,
    readonly creatorSourceRoot = process.env.NPATI_CREATOR_SOURCE_ROOT?.trim() || undefined,
  ) {}

  private async setting(ctx: AuthContext, companyId: string) {
    const company = await this.store.getCompany(ctx, companyId);
    // Company configuration belongs to its recorded creator, even when another member reads it.
    const ownerContext = { ...ctx, userId: company.userId };
    const key = `coding-agent.execution-mode:${companyId}`;
    const row = await this.store.getUserSetting(ownerContext, key);
    const value = row?.value as Partial<StoredMode> | undefined;
    const mode = CODE_EXECUTION_MODES.includes(value?.mode as CodeExecutionMode) ? value!.mode! : "company";
    return { ownerContext, key, row, value: { ...value, mode } as StoredMode };
  }

  async get(ctx: AuthContext, companyId: string): Promise<CodeExecutionModeView> {
    const setting = await this.setting(ctx, companyId);
    return { ...setting.value, revision: setting.row?.revision ?? 0,
      canSelectGlobal: await this.canManageCompany(ctx, companyId),
      sourceAccessGranted: !ctx.companyId
        && !ctx.externalSubject?.startsWith("npati:apikey:") && !ctx.externalSubject?.startsWith("npati:remote:")
        && (isAdminPrincipal(ctx) || (ctx.externalSubject?.startsWith("npati:") === true
          && (process.env.NPATI_CREATOR_OWNER_USER_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean).includes(ctx.userId))),
      creatorConfigured: !!this.creatorSourceRoot };
  }

  private async save(ctx: AuthContext, companyId: string, value: StoredMode, expectedRevision: number) {
    const setting = await this.setting(ctx, companyId);
    if (!this.audit) throw new CodeExecutionModeError("audit_unavailable", "Execution mode changes require the audit journal", 503);
    await this.audit.record(ctx, { companyId, actor: ctx.userId, actorRole: "owner",
      action: "code.execution_mode.change", resourceType: "code_execution_mode", resourceId: companyId,
      decision: "allowed", payload: { previous: setting.value, next: value, expectedRevision } });
    const saved = await this.store.setUserSetting(setting.ownerContext, setting.key, value, expectedRevision);
    if (!saved) throw new CodeExecutionModeError("mode_revision_conflict", "The execution mode changed. Refresh and retry.", 409);
    return this.get(ctx, companyId);
  }

  async set(ctx: AuthContext, companyId: string, mode: CodeExecutionMode, expectedRevision: number) {
    if (!CODE_EXECUTION_MODES.includes(mode)) throw new CodeExecutionModeError("invalid_execution_mode", "Unknown execution mode", 400);
    if (!(await this.canManageCompany(ctx, companyId))) throw new CodeExecutionModeError("flag_admin_required", "Only a company owner/admin can change execution mode");
    const view = await this.get(ctx, companyId);
    if (mode === "global" && !view.canSelectGlobal) throw new CodeExecutionModeError("creator_admin_required", "Global requires the installation owner or an administrator");
    return this.save(ctx, companyId, { mode, creatorProjectId: view.creatorProjectId, creatorSessionId: view.creatorSessionId }, expectedRevision);
  }

  async bindCreator(ctx: AuthContext, companyId: string, projectId: string, sessionId: string) {
    const view = await this.get(ctx, companyId);
    if (!view.sourceAccessGranted) throw new CodeExecutionModeError("creator_admin_required", "Global requires the installation owner or an administrator");
    if (!this.creatorSourceRoot) throw new CodeExecutionModeError("creator_source_unconfigured", "The NPATI source repository is not mounted", 503);
    await this.store.getProject(ctx, companyId, projectId);
    return this.save(ctx, companyId, { mode: "global", creatorProjectId: projectId, creatorSessionId: sessionId }, view.revision);
  }

  /** Checked at the actual tool boundary, including direct calls and delegated agents. */
  async assertToolAllowed(ctx: AuthContext, companyId: string, projectId: string | undefined, tool: string, args: Record<string, unknown> = {}) {
    const view = await this.get(ctx, companyId);
    const mount = projectId ? await this.store.getProjectMountedFolder(ctx, companyId, projectId) : null;
    const mounted = !!mount?.confirmedAt && !mount.revokedAt;
    const sourceMount = mounted && !!this.creatorSourceRoot && path.resolve(mount!.path) === path.resolve(this.creatorSourceRoot);
    if (view.mode === "global") {
      if (!view.sourceAccessGranted) throw new CodeExecutionModeError("creator_admin_required", "Global requires the installation owner or an administrator");
      if (!sourceMount || view.creatorProjectId !== projectId || mount?.mode !== "rw") {
        throw new CodeExecutionModeError("creator_workspace_required", "Open the mounted NPATI Creator Workspace to work in Global mode");
      }
      return;
    }
    if (projectId && (projectId === view.creatorProjectId || sourceMount)) {
      throw new CodeExecutionModeError("execution_scope_denied", "NPATI source files are available only in Global mode");
    }
    if (view.mode === "sandbox") {
      if (!projectId || mounted || tool.startsWith("code.agent.") || !tool.startsWith("code.")
          || tool.startsWith("code.mcp.") || tool === "code.data.backend.attach"
          || tool === "code.data.rows.transfer"
          || (typeof args.targetProjectId === "string" && args.targetProjectId !== projectId)) {
        throw new CodeExecutionModeError("execution_scope_denied", "Sandbox / Data Studio is limited to the selected project's sandbox and data");
      }
    }
  }
}
