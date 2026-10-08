import type { AuthContext, MountedFolderMode, ProjectMountedFolder, WorkspaceStore } from "@npati/workspace";
import { ProjectMountError, validateMountedFolder, type MountValidationInput } from "./project-mount-policy";
import type { CodeAuditPort } from "./code-project-trust";

/**
 * C15 — the administration surface of the **mounted local folder allowlist**.
 *
 * This is the only way a host directory becomes a project's canonical workspace, and it is deliberately shaped
 * like project trust (`code-project-trust.ts`), because the two are the same kind of decision: an owner/admin
 * states a fact about one project, the statement is journalled **before** it applies, and it carries an
 * optimistic `revision` so a decision cannot silently overwrite a newer one.
 *
 * What is different, and why the extra care: trust decides whether repository *content* may guide the work,
 * while a mount hands the sandbox a directory on the operator's own filesystem. So:
 *
 *  - the path is validated (`realpath` + `lstat` on every component, protected locations, operator allowlist)
 *    **before** anything is journalled or stored, so a refused path leaves no record to clean up;
 *  - `confirm: true` is required explicitly. A path alone is not a decision: an API that accepted the path and
 *    confirmed it in the same breath on a caller's behalf would make "who pointed this project at that folder"
 *    unanswerable, which is the question the record exists to answer;
 *  - the server-side `code.mounted_folder` flag is asserted **here**, on the real path, and never only in the
 *    UI: with the flag off neither a confirmation nor a revocation is possible, and the resolver ignores an
 *    already-confirmed record, so mounted projects behave exactly as they did before this step;
 *  - a store that is unavailable, a journal that is unavailable and a flag service that is unavailable each
 *    refuse the change (fail closed) rather than applying it unrecorded.
 *
 * The service holds no path logic of its own: it calls the same `validateMountedFolder` the sandbox runner
 * calls, so "what the API accepted" and "what the runner will accept" cannot be two different policies.
 */

export const CODE_MOUNTED_FOLDER_ROLES = ["owner", "admin"] as const;

export type CodeMountedFolderAction = "code.project.mount" | "code.project.unmount";

export class CodeMountedFolderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeMountedFolderError";
  }
}

export interface CodeMountedFolderFlagPort {
  isEnabled(ctx: AuthContext, flagKey: string, options?: { companyId?: string; userId?: string }): Promise<boolean>;
}

export interface CodeMountedFolderDeps {
  store: Pick<WorkspaceStore, "getProjectMountedFolder" | "setProjectMountedFolder">;
  audit?: CodeAuditPort;
  /** Server-side feature flag reader; absent means the surface is closed. */
  flags?: CodeMountedFolderFlagPort;
  /** Operator allowlist. Empty allows nothing. */
  roots: readonly string[];
  protectedRoots?: readonly string[];
  /** The managed workspace root, refused as a mount target (a mount inside it would be a loop). */
  projectWorkspacesRoot: string;
  /** Test seam for the filesystem checks; production uses `validateMountedFolder`. */
  validate?: (input: MountValidationInput) => Promise<{ canonicalPath: string; matchedRoot: string }>;
}

function roleOf(context: AuthContext): string {
  return String((context as unknown as { role?: string }).role ?? "member");
}

export class CodeMountedFolderService {
  constructor(private readonly deps: CodeMountedFolderDeps) {}

  static readonly FLAG = "code.mounted_folder";

  /** The flag is read on the server for every mutation; an unavailable flag service is a refusal, not a yes. */
  private async assertEnabled(ctx: AuthContext, companyId: string): Promise<void> {
    const flags = this.deps.flags;
    if (!flags) {
      throw new CodeMountedFolderError("feature_unavailable", "The mounted-folder feature flag service is not configured", 503, { flagKey: CodeMountedFolderService.FLAG });
    }
    const enabled = await flags.isEnabled(ctx, CodeMountedFolderService.FLAG, { companyId }).catch(() => false);
    if (!enabled) {
      throw new CodeMountedFolderError("feature_disabled", `Feature "${CodeMountedFolderService.FLAG}" is disabled`, 403, { flagKey: CodeMountedFolderService.FLAG });
    }
  }

  private async assertOwnerOrAdmin(ctx: AuthContext, companyId: string, projectId: string, action: CodeMountedFolderAction): Promise<void> {
    if (!CODE_MOUNTED_FOLDER_ROLES.includes(roleOf(ctx) as (typeof CODE_MOUNTED_FOLDER_ROLES)[number])) {
      await this.audit(action, ctx, companyId, projectId, { decision: "deny", metadata: { reason: "code_mounted_folder_admin_required" } });
      throw new CodeMountedFolderError("code_mounted_folder_admin_required", "Only an owner or admin can change a project's mounted folder", 403, {
        reason: "code_mounted_folder_admin_required",
      });
    }
  }

  /**
   * Writes the journal entry and refuses the change when the journal is unavailable. A refusal is journalled
   * best-effort (the refusal already happened, so an unavailable journal must not change it), exactly as trust
   * does — see C5a (D7).
   */
  private async audit(
    action: CodeMountedFolderAction,
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    extra: { decision?: "allow" | "deny"; metadata?: Record<string, unknown> },
    required = false,
  ): Promise<void> {
    const audit = this.deps.audit;
    if (!audit) {
      if (required) throw new CodeMountedFolderError("audit_unavailable", "A mounted folder requires the audit journal", 503, { reason: "audit_unavailable" });
      return;
    }
    try {
      await audit.record({
        action: extra.decision === "deny" ? `${action}.denied` : action,
        actor: ctx.userId,
        companyId,
        resourceType: "code_project_mounted_folder",
        resourceId: projectId,
        ...(extra.decision === "deny" ? { decision: "deny" as const } : {}),
        metadata: extra.metadata ?? {},
      });
    } catch {
      if (required) throw new CodeMountedFolderError("audit_unavailable", "A mounted folder requires the audit journal", 503, { reason: "audit_unavailable" });
    }
  }

  async get(ctx: AuthContext, companyId: string, projectId: string): Promise<ProjectMountedFolder | null> {
    return this.deps.store.getProjectMountedFolder(ctx, companyId, projectId);
  }

  /**
   * Add **and** confirm the mounted folder of a project in one revision-checked change.
   *
   * One call rather than two on purpose: an "added but unconfirmed" record is a row that grants nothing while
   * looking like a decision, and the state every reader would have to interpret. `confirm: true` is the human's
   * statement that they mean *this* canonical path, and it is what `confirmedBy`/`confirmedAt` record.
   */
  async confirm(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { path: string; mode: MountedFolderMode; expectedRevision: number; confirm?: boolean; reason?: string },
  ): Promise<ProjectMountedFolder> {
    await this.assertEnabled(ctx, companyId);
    await this.assertOwnerOrAdmin(ctx, companyId, projectId, "code.project.mount");
    if (input.confirm !== true) {
      throw new CodeMountedFolderError("mounted_folder_confirmation_required", "A mounted folder must be confirmed explicitly (confirm: true)", 400);
    }
    if (input.mode !== "ro" && input.mode !== "rw") {
      throw new CodeMountedFolderError("invalid_mount_mode", "A mounted folder mode must be 'ro' or 'rw'", 400);
    }
    const validate = this.deps.validate;
    let canonicalPath: string;
    let matchedRoot: string;
    try {
      const facts = validate
        ? await validate({ candidate: input.path, roots: this.deps.roots, protectedRoots: this.deps.protectedRoots, projectWorkspacesRoot: this.deps.projectWorkspacesRoot })
        : await this.validateWithRealFilesystem(input.path);
      canonicalPath = facts.canonicalPath;
      matchedRoot = facts.matchedRoot;
    } catch (error) {
      if (error instanceof ProjectMountError) {
        await this.audit("code.project.mount", ctx, companyId, projectId, { decision: "deny", metadata: { reason: error.code } });
        throw new CodeMountedFolderError(error.code, error.message, error.status, error.details);
      }
      throw error;
    }
    // The journal is written before the store, so a deployment whose journal is down cannot point a project at
    // a host folder unaudited (fail closed, rule 23).
    await this.audit("code.project.mount", ctx, companyId, projectId, {
      metadata: { path: canonicalPath, matchedRoot, mode: input.mode, expectedRevision: input.expectedRevision, reason: input.reason ?? null },
    }, true);
    return this.deps.store.setProjectMountedFolder(ctx, companyId, projectId, {
      path: canonicalPath,
      mode: input.mode,
      confirmed: true,
      actor: ctx.userId,
      expectedRevision: input.expectedRevision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  }

  /** Revokes a confirmation. The path stays on the record for the audit trail; it simply stops being a mount. */
  async revoke(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { expectedRevision: number; reason?: string },
  ): Promise<ProjectMountedFolder> {
    await this.assertEnabled(ctx, companyId);
    await this.assertOwnerOrAdmin(ctx, companyId, projectId, "code.project.unmount");
    const existing = await this.get(ctx, companyId, projectId);
    if (!existing) {
      throw new CodeMountedFolderError("mounted_folder_not_found", "This project has no mounted folder", 404);
    }
    await this.audit("code.project.unmount", ctx, companyId, projectId, {
      metadata: { path: existing.path, mode: existing.mode, expectedRevision: input.expectedRevision, reason: input.reason ?? null },
    }, true);
    return this.deps.store.setProjectMountedFolder(ctx, companyId, projectId, {
      path: existing.path,
      mode: existing.mode,
      confirmed: false,
      actor: ctx.userId,
      expectedRevision: input.expectedRevision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  }

  private async validateWithRealFilesystem(candidate: string): Promise<{ canonicalPath: string; matchedRoot: string }> {
    return validateMountedFolder({
      candidate,
      roots: this.deps.roots,
      protectedRoots: this.deps.protectedRoots,
      projectWorkspacesRoot: this.deps.projectWorkspacesRoot,
    });
  }
}
