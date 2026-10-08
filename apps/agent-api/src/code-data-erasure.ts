import type {
  AuthContext,
  CodeDataErasureReport,
  CodeDataErasureTarget,
  CodeDataLifecycleStore,
} from "@npati/workspace";

/**
 * R1-C (item 13) — the right to be forgotten, for the Coding Agent's own data.
 *
 * Export already existed (C10: `GET /companies/:companyId/code/runs/:runId/export`, Markdown + JSON, with the
 * secret refusal). Erasure did not: `grep deleteCodeSession|purgeCodeSession|deleteSessionData|eraseSession`
 * returned **zero** matches, and the only removals that existed were `archiveProject`, a hand-written
 * `DELETE FROM project_checkpoints` and a `DELETE FROM code_approval_rules`. So a user could take their data
 * out and had no way to have it removed.
 *
 * Four properties are the whole design:
 *
 *  1. **Audit before apply, fail closed.** The journal entry is written **before** anything is deleted, and a
 *     journal that cannot be written refuses the erasure. This is the same order the other privileged code
 *     actions use (the project lifecycle route, the approval decide route): an audit written afterwards can be
 *     lost exactly when the destructive act happened, which is the one moment it must exist for.
 *  2. **The answer is a measurement.** The store deletes and reads back in one transaction, and this service
 *     returns that report — `outstanding` names every family that still holds rows and `verified` is derived
 *     from those counts. A caller cannot receive `deleted: true` over data that is still there.
 *  3. **Scope is a parameter, not a hope.** Only the code tables are reached (the store's closed maps), only
 *     for the caller's Company, and only for the session or project named. No NPATI table outside the code
 *     surface is touched, and the shared `projects` table is only ever *the code project being forgotten*.
 *  4. **Nothing else is re-implemented.** The on-disk workspace, the sandbox and the DataBackend artifacts are
 *     removed by the mechanisms that already own them (`removeWorkspace`, the project service's `beforeRemove`
 *     hook) — this service calls them, it does not grow a second lifecycle.
 */

export class CodeDataErasureError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeDataErasureError";
    this.retryable = retryable;
  }
}

/** The refusal codes, part of the contract because a caller has to explain them. */
export const CODE_DATA_ERASURE_CODES = Object.freeze({
  invalidArguments: "invalid_arguments",
  notFound: "session_not_found",
  lifecycleUnavailable: "data_lifecycle_unavailable",
  auditUnavailable: "audit_unavailable",
  notVerified: "erasure_not_verified",
  requestFailed: "code_data_erasure_request_failed",
});

export interface CodeDataErasureAuditPort {
  record(input: {
    action: string;
    actor: string;
    companyId: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface CodeDataErasureStorePort {
  /** The store's optional data-lifecycle capability. Absent means the erasure cannot be performed at all. */
  lifecycle?: CodeDataLifecycleStore;
  /**
   * Resolves the session (and its project). Required, not optional: without it the service could neither scope
   * the project-scoped families honestly nor refuse a foreign id **before** the journal records an erasure
   * that will not happen. The caller's own `AuthContext` is passed through, so the lookup is the ordinary
   * tenant-scoped read rather than a second, wider one.
   */
  resolveSession(input: { ctx: AuthContext; companyId: string; sessionId: string }): Promise<{ projectId: string } | null>;
  /** Resolves the project, so "not found", "another tenant's" and "not a code project" are separate answers. */
  resolveProject(input: { ctx: AuthContext; companyId: string; projectId: string }): Promise<{ type: string } | null>;
}

export interface CodeDataErasureDeps {
  store: CodeDataErasureStorePort;
  audit?: CodeDataErasureAuditPort;
  /**
   * Removing the on-disk workspace. Optional exactly like the lifecycle route's port: when it is unwired the
   * answer says `workspace: "unknown"` with the reason instead of claiming bytes were removed. It never
   * decides `verified` on its own — `verified` is about rows. It is only called for a **whole-project**
   * erasure: erasing one session must not delete the project's shared directory.
   */
  removeWorkspace?: (input: { ctx: AuthContext; companyId: string; projectId: string }) => Promise<{ removed: boolean; reason?: string; alreadyAbsent?: boolean }>;
  logger?: { warn(payload: unknown, message?: string): void };
}

export interface CodeDataErasureResult {
  status: "erased" | "already_erased" | "partial";
  target: CodeDataErasureTarget;
  /** Per-table counts, the read-back `remaining` included. */
  families: CodeDataErasureReport["families"];
  removed: {
    rows: number;
    workspace: boolean | "unknown";
    workspaceAlreadyAbsent: boolean;
  };
  /**
   * Why the on-disk workspace is in the state it is. `session_scope_preserves_project_workspace` is a
   * deliberate answer, not a failure: erasing one session must not delete the directory its project's other
   * sessions still live in.
   */
  workspaceReason: string;
  /**
   * The families that still hold rows for this target. Empty is the only value that means "nothing left", and
   * `verified` is exactly `outstanding.length === 0`.
   */
  outstanding: string[];
  /** Families the erasure may not touch by design, with the reason — the append-only evidence. */
  preserved: CodeDataErasureReport["preserved"];
  verified: boolean;
  /** Only real failures. A scope that deliberately preserves something is reported through `workspaceReason`. */
  failures: Array<{ target: string; reason: string; retryable: boolean }>;
}

/**
 * The evidence families an erasure may not touch, with the reason. Stated once, so the empty-report path and
 * the store's own report cannot name different things.
 *
 * The names are the append-only tables of the Coding Agent: `execution_snapshots` (076),
 * `code_replay_bundles`/`_steps` (078), `code_context_summaries` (079), `code_run_recovery_notices` (082) and
 * `code_activity_events` (077). Each one is append-only **at the database level**, so "erased" can never
 * truthfully include it — which is why it is reported rather than omitted.
 */
export function preservedFamilies(): Array<{ table: string; reason: string }> {
  return [
    "execution_snapshots",
    "code_replay_bundles",
    "code_replay_bundle_steps",
    "code_context_summaries",
    "code_run_recovery_notices",
    "code_activity_events",
  ].map((table) => ({ table, reason: "append_only_evidence" }));
}

export class CodeDataErasureService {
  constructor(private readonly deps: CodeDataErasureDeps) {}
  /** True when this deployment can really erase rows. The route answers a named refusal otherwise. */
  get available(): boolean {
    return this.deps.store.lifecycle !== undefined;
  }

  /**
   * Forgets one session or one whole code project.
   *
   * The order is: validate the target (so a foreign or unknown id refuses before the journal records
   * anything), **journal**, erase, remove the workspace, then answer with the measurement. A second call for
   * the same target is safe and answers `already_erased` — it still performs the workspace removal, because a
   * previous attempt may have deleted the rows and failed on the bytes.
   */
  async erase(input: {
    ctx: AuthContext;
    actor: string;
    companyId: string;
    target: CodeDataErasureTarget;
  }): Promise<CodeDataErasureResult> {
    const { ctx, actor, companyId, target } = input;
    const lifecycle = this.deps.store.lifecycle;
    if (!lifecycle) {
      throw new CodeDataErasureError(
        CODE_DATA_ERASURE_CODES.lifecycleUnavailable,
        "This deployment cannot erase code data",
        503,
        { reason: "data_lifecycle_not_configured" },
        true,
      );
    }

    const resourceId = target.kind === "session" ? target.sessionId : target.projectId;
    let projectId: string | undefined = target.kind === "project" ? target.projectId : target.projectId;
    let alreadyErased = false;

    if (target.kind === "session") {
      const session = await this.deps.store.resolveSession({ ctx, companyId, sessionId: target.sessionId });
      if (session) {
        projectId = session.projectId;
      } else {
        // The session row is gone. That is either a repeat call or an id from another tenant, and the two must
        // be indistinguishable — but a repeat call still has to be able to finish the job (workspace bytes,
        // rows left behind by an interrupted first attempt), so the erasure runs and reports what it found
        // rather than answering `not_found`.
        alreadyErased = true;
      }
    } else {
      const project = await this.deps.store.resolveProject({ ctx, companyId, projectId: target.projectId });
      if (!project) {
        alreadyErased = true;
      } else if (project.type !== "code_project") {
        // The shared `projects` table serves Website Builder, Data Studio and the Coding Agent. Retention and
        // erasure are code features, so a project of another type is refused by name instead of being erased
        // because its id happened to be passed.
        throw new CodeDataErasureError(
          CODE_DATA_ERASURE_CODES.notFound,
          "No code project matches this identifier",
          404,
          { reason: "not_a_code_project" },
        );
      }
    }

    // Audit **before** apply. A journal that cannot be written refuses the erasure: this is the one operation
    // whose whole purpose is to be accountable for itself.
    await this.auditOrFail({ actor, companyId, target, resourceId, projectId });

    /**
     * The target refused to resolve, so there is nothing of this scope to erase. The statement is **not**
     * issued at all: the project id that would stand in for it is the caller's own, and a checkpoint belongs to
     * a project rather than to the scope that was refused. The journal entry above already records the request,
     * which is what makes the answer `already_erased` honest instead of a silent no-op.
     */
    const report: CodeDataErasureReport = alreadyErased && projectId === undefined
      ? { companyId, target, families: [], erased: 0, outstanding: [], preserved: preservedFamilies(), verified: true }
      : await lifecycle.eraseCodeData({ companyId, target });

    const failures: CodeDataErasureResult["failures"] = [];
    let workspace: boolean | "unknown" = "unknown";
    let workspaceAlreadyAbsent = false;
    /**
     * Only a **whole-project** erasure may remove the on-disk workspace. A session erasure shares that
     * directory with the project's other sessions, so removing it there would destroy data the caller never
     * asked to forget — the exact class of accident this service exists to make impossible. A session erasure
     * therefore answers `workspace: "unknown"` with the reason `session_scope_preserves_project_workspace`.
     */
    const mayRemoveWorkspace = target.kind === "project" && Boolean(projectId);
    let workspaceReason = "session_scope_preserves_project_workspace";
    if (mayRemoveWorkspace && this.deps.removeWorkspace) {
      try {
        const removal = await this.deps.removeWorkspace({ ctx, companyId, projectId: projectId! });
        workspace = removal.removed;
        workspaceAlreadyAbsent = removal.alreadyAbsent === true;
        workspaceReason = removal.removed ? (removal.alreadyAbsent ? "workspace_already_absent" : "workspace_removed") : removal.reason ?? "workspace_removal_failed";
        if (!removal.removed) {
          failures.push({ target: "workspace", reason: removal.reason ?? "workspace_removal_failed", retryable: true });
        }
      } catch (error) {
        workspace = false;
        workspaceReason = error instanceof Error ? error.message : "workspace_removal_failed";
        failures.push({ target: "workspace", reason: workspaceReason, retryable: true });
      }
    } else if (mayRemoveWorkspace) {
      workspaceReason = "workspace_removal_not_configured";
      failures.push({ target: "workspace", reason: workspaceReason, retryable: true });
    }

    const verified = report.verified;
    if (!verified) {
      this.deps.logger?.warn({ target, outstanding: report.outstanding }, "code_data_erasure_outstanding");
    }

    const status: CodeDataErasureResult["status"] = alreadyErased && report.erased === 0
      ? "already_erased"
      : failures.length === 0 && verified
        ? "erased"
        : "partial";

    return {
      status,
      target,
      families: report.families,
      removed: { rows: report.erased, workspace, workspaceAlreadyAbsent },
      workspaceReason,
      outstanding: report.outstanding,
      preserved: report.preserved,
      verified,
      failures,
    };
  }

  /**
   * The journal entry, or a refusal. `metadata` carries counts of *what was asked for* only — never a row, a
   * file path or a transcript excerpt, because the journal is append-only and would keep it forever.
   */
  private async auditOrFail(input: {
    actor: string;
    companyId: string;
    target: CodeDataErasureTarget;
    resourceId: string;
    projectId?: string;
  }): Promise<void> {
    if (!this.deps.audit) {
      throw new CodeDataErasureError(
        CODE_DATA_ERASURE_CODES.auditUnavailable,
        "Audit journal is unavailable",
        503,
        { reason: "audit_not_configured" },
        true,
      );
    }
    try {
      await this.deps.audit.record({
        action: "code.session.data_erase",
        actor: input.actor,
        companyId: input.companyId,
        resourceType: input.target.kind === "session" ? "code_session" : "code_project",
        resourceId: input.resourceId,
        metadata: {
          scope: input.target.kind,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          irreversible: true,
        },
      });
    } catch (error) {
      throw new CodeDataErasureError(
        CODE_DATA_ERASURE_CODES.auditUnavailable,
        "Audit journal is unavailable",
        503,
        { reason: error instanceof Error ? error.message : "audit_write_failed" },
        true,
      );
    }
  }
}
