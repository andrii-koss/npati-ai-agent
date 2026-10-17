import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AuthContext,
  CodeSession,
  Project,
  WorkspaceStore,
} from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import type { CodeAuditPort } from "./code-project-trust";
import type { ProjectLifecycleService } from "./project-lifecycle-service";

/**
 * C7 — the server side of the code project lifecycle the UI needs: list, create, rename, archive,
 * unarchive and delete.
 *
 * The design rule for this module is that it owns **no lifecycle logic of its own**. Creating a project
 * goes through the existing `ProjectService` (and the existing import service for repository imports),
 * renaming/archiving/deleting go through `ProjectService` too — including its `beforeRemove` hook, which is
 * already wired to destroy the sandbox and detach DataBackend artifacts. Re-implementing any of that here
 * would create a second, divergent lifecycle.
 *
 * Three properties are deliberate:
 *
 * 1. **Archived projects cannot start work.** That is not enforced here: `CodeService.createSession` already
 *    refuses an archived project with `project_archived`. This module therefore never needs a second archiving
 *    rule, and the test asserts the existing refusal rather than a copy of it.
 * 2. **A partial cleanup is never reported as success.** Deleting a project removes the record and (through the
 *    existing hook) the sandbox; the on-disk workspace has no existing removal mechanism, so the route reports
 *    `partial` with the exact target that was not removed, plus `retryable: true`. Claiming a clean delete
 *    would leave bytes on disk behind a success message.
 * 3. **Deleting twice is safe and does not leak.** A second delete of an already-removed project answers
 *    `already_deleted` with HTTP 200 and an identical body for a project that never existed or belongs to
 *    another tenant — the route is not an existence oracle.
 *
 * Refusal codes are part of the contract because the UI explains them:
 *   unauthorized · invalid_arguments · project_not_found · project_archived · project_revision_conflict
 *   permission_denied · agent_cannot_change_policy · action_not_mapped · permission_action_mismatch
 *   project_import_unavailable · project_create_failed · project_lifecycle_request_failed
 *   audit_unavailable · project_delete_confirmation_required
 */
export class CodeProjectRouteError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeProjectRouteError";
    this.retryable = retryable;
  }
}

/** Actions this surface authorizes. Named actions keep the permission derived from the action. */
export const CODE_PROJECT_ACTIONS = Object.freeze({
  list: "code.project.list",
  create: "code.project.create",
  rename: "code.project.rename",
  archive: "code.project.archive",
  unarchive: "code.project.unarchive",
  delete: "code.project.delete",
  deletePlan: "code.project.delete_plan",
  softDelete: "code.project.soft_delete",
  restore: "code.project.restore",
  hardPurge: "code.project.hard_purge",
});

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  project_delete_confirmation_required: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  agent_cannot_change_policy: 403,
  project_not_found: 404,
  project_archived: 409,
  project_revision_conflict: 409,
  project_import_unavailable: 503,
  project_unarchive_unavailable: 503,
  audit_unavailable: 503,
  project_create_failed: 500,
  project_lifecycle_request_failed: 500,
};

/** Creation kinds the UI offers; each maps to an existing creation path, never to a new one. */
export const CODE_PROJECT_CREATE_KINDS = Object.freeze(["import_repository", "upload", "empty"] as const);
export type CodeProjectCreateKind = (typeof CODE_PROJECT_CREATE_KINDS)[number];

interface CompanyParams { companyId: string }
interface ProjectParams extends CompanyParams { projectId: string }

export interface CodeProjectLifecycleDeps {
  projects: {
    list(ctx: AuthContext, companyId: string, includeArchived?: boolean): Promise<Project[]>;
    get(ctx: AuthContext, companyId: string, projectId: string): Promise<Project>;
    rename(ctx: AuthContext, companyId: string, projectId: string, name: string, expectedRevision: number): Promise<Project>;
    archive(ctx: AuthContext, companyId: string, projectId: string, expectedRevision: number): Promise<Project>;
    delete(ctx: AuthContext, companyId: string, projectId: string): Promise<void>;
  };
  /** The newest code session per project, used by `toProjectSummary` callers such as the existing list route. */
  sessions?: { list(ctx: AuthContext, companyId: string, projectId?: string, options?: { includeArchived?: boolean; limit?: number }): Promise<CodeSession[]> };
  /** Optional: unarchive has no `ProjectService` method today, so the store write is injected explicitly. */
  unarchive?: (ctx: AuthContext, companyId: string, projectId: string, expectedRevision: number) => Promise<Project>;
  /**
   * Optional: removing the on-disk workspace. No existing mechanism does this (the sandbox hook only destroys
   * containers and detaches DataBackend artifacts), so when it is unwired the delete reports `partial` with
   * `workspace_removal_not_configured` instead of pretending the bytes are gone.
   *
   * `alreadyAbsent` is additive: it lets the caller tell an idempotent repeat ("was already gone") from a removal
   * that just happened, without changing the meaning of `removed`.
   */
  removeWorkspace?: (ctx: AuthContext, companyId: string, projectId: string) => Promise<{ removed: boolean; reason?: string; alreadyAbsent?: boolean; outstanding?: string[] }>;
  lifecycleService?: ProjectLifecycleService;
  audit?: CodeAuditPort;
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeProjectRouteError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  if (error instanceof WorkspaceNotFoundError) return "project_not_found";
  if (error instanceof WorkspaceAccessError) {
    // The store raises the same error for "not yours" and "does not exist", and uses the revision-conflict
    // wording for a stale optimistic token; both must stay distinguishable in the answer.
    return /revision|changed by another request/i.test(error.message) ? "project_revision_conflict" : "project_not_found";
  }
  return "project_lifecycle_request_failed";
}

function resolveErrorStatus(error: unknown, code: string): number {
  const fromCode = ROUTE_ERROR_STATUS[code];
  if (fromCode !== undefined) return fromCode;
  const shaped = error as { httpStatus?: unknown; status?: unknown } | null;
  const explicit = Number(shaped?.httpStatus ?? shaped?.status ?? Number.NaN);
  if (Number.isFinite(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  return 500;
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) {
    return reply.code(error.status ?? 401).send({
      ...withApiVersion({}),
      error: { code: error.code ?? "unauthorized", message: error.message, retryable: false },
    });
  }
  const code = resolveErrorCode(error);
  const status = resolveErrorStatus(error, code);
  const details = (error as { details?: unknown } | null)?.details;
  const message = code === "project_lifecycle_request_failed"
    ? "Code project request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Code project request failed");
  return reply.code(status).send({
    ...withApiVersion({}),
    error: {
      code,
      message,
      retryable: (error as { retryable?: unknown } | null)?.retryable === true,
      ...(details === undefined ? {} : { details }),
    },
  });
}

function badRequest(message: string, details: Record<string, unknown> = {}): CodeProjectRouteError {
  return new CodeProjectRouteError("invalid_arguments", message, 400, details);
}

function revisionOf(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw badRequest("expectedRevision must be a positive integer", { field: "expectedRevision" });
  return parsed;
}

/** The create kinds, validated before anything is created. An unknown kind is a client mistake. */
export function resolveCreateKind(value: unknown): CodeProjectCreateKind {
  const kind = String(value ?? "").trim();
  if (!(CODE_PROJECT_CREATE_KINDS as readonly string[]).includes(kind)) {
    throw badRequest("kind must be one of import_repository, upload, empty", { field: "kind", allowed: [...CODE_PROJECT_CREATE_KINDS] });
  }
  return kind as CodeProjectCreateKind;
}

/** The confirmation required for the irreversible action, as an explicit boolean. */
export function assertDeleteConfirmed(body: unknown): void {
  const confirm = (body as { confirm?: unknown } | null)?.confirm;
  if (confirm !== true) {
    throw new CodeProjectRouteError(
      "project_delete_confirmation_required",
      "Deleting a code project requires { confirm: true }",
      400,
      { field: "confirm" },
    );
  }
}

/** A project summary shaped for the list view; the session is only the newest one, never a full history. */
export function toProjectSummary(project: Project, session: CodeSession | undefined) {
  return {
    projectId: project.id,
    name: project.name,
    type: project.type,
    status: project.status,
    revision: project.revision,
    dataClassification: project.dataClassification,
    retentionClass: project.retentionClass,
    sandboxId: project.sandboxId ?? null,
    defaultBranch: project.repositoryBranch ?? null,
    hasSandbox: Boolean(project.sandboxId),
    lastSession: session
      ? { sessionId: session.id, mode: session.mode, status: session.status, updatedAt: session.updatedAt }
      : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export async function registerCodeProjectLifecycleRoutes(instance: FastifyInstance, deps: CodeProjectLifecycleDeps) {
  const contextOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    return context;
  };

  const authorizeAction = async (request: unknown, companyId: string, action: string): Promise<AuthContext> => {
    const ctx = contextOrFail(request);
    // The gate derives the permission from the action and refuses a mismatched pair, so the only correct
    // call shape is to hand it the derived permission itself. An unknown action stays "" and is refused as
    // `action_not_mapped`: deny by default, never a fallback to a convenient label.
    await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });
    return ctx;
  };

  /**
   * Rename. `expectedRevision` is mandatory: rename is a mutation, and a blind overwrite would lose edits.
   *
   * NOTE on what this module deliberately does *not* register: `GET/POST /companies/:companyId/code/projects`
   * already exist in `code-routes.ts` (list and creation through the same `CodeService`), so declaring them here
   * would both duplicate the surface and make Fastify fail at startup with a duplicate route. The helpers above
   * (`toProjectSummary`, `resolveCreateKind`) are exported so that existing route can be enriched in place
   * instead of a second list/create API being invented next to it.
   */
  const auditOrFail = async (input: {
    ctx: AuthContext;
    companyId: string;
    action: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> => {
    if (!deps.audit) {
      throw new CodeProjectRouteError("audit_unavailable", "Audit journal is unavailable", 503, { reason: "audit_not_configured" }, true);
    }
    try {
      await deps.audit.record({
        action: input.action,
        actor: input.ctx.userId,
        workspaceId: input.ctx.workspaceId,
        companyId: input.companyId,
        resourceType: "code_project",
        resourceId: input.resourceId,
        metadata: input.metadata ?? {},
      });
    } catch (error) {
      throw new CodeProjectRouteError(
        "audit_unavailable",
        "Audit journal is unavailable",
        503,
        { reason: (error as Error).message },
        true,
      );
    }
  };

  /**
   * What this module deliberately does NOT register: `GET/POST /companies/:companyId/code/projects` already
   * exist in `code-routes.ts` (list and creation, both through the same `CodeService`). Declaring them here
   * would duplicate the surface *and* make Fastify fail at startup with a duplicate route. The validation and
   * shaping helpers above (`toProjectSummary`, `resolveCreateKind`, `assertDeleteConfirmed`) are exported so
   * that the existing list/create can be enriched in place instead of a second project API being invented.
   */

  /** Rename. `expectedRevision` is mandatory: rename is a mutation, and a blind overwrite would lose edits. */
  instance.patch<{ Params: ProjectParams; Body: { name?: string; expectedRevision?: number } }>(
    "/companies/:companyId/code/projects/:projectId",
    async (request, reply) => {
      try {
        const { companyId, projectId } = request.params;
        const ctx = await authorizeAction(request, companyId, CODE_PROJECT_ACTIONS.rename);
        const expectedRevision = revisionOf(request.body?.expectedRevision);
        const name = String(request.body?.name ?? "").trim();
        if (!name) throw badRequest("name is required", { field: "name" });
        await auditOrFail({ ctx, companyId, action: "code.project.rename", resourceId: projectId, metadata: { expectedRevision, nameLength: name.length } });
        const project = await deps.projects.rename(ctx, companyId, projectId, name, expectedRevision);
        return reply.send(withApiVersion({ status: "renamed", project: toProjectSummary(project, undefined) }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * Archive. `ProjectService.archive` already releases the sandbox through its `beforeRemove` hook, so this
   * route adds only authorization, the journal entry and the revision check the caller must supply.
   */
  instance.post<{ Params: ProjectParams; Body: { expectedRevision?: number } }>(
    "/companies/:companyId/code/projects/:projectId/archive",
    async (request, reply) => {
      try {
        const { companyId, projectId } = request.params;
        const ctx = await authorizeAction(request, companyId, CODE_PROJECT_ACTIONS.archive);
        const expectedRevision = revisionOf(request.body?.expectedRevision);
        await auditOrFail({ ctx, companyId, action: "code.project.archive", resourceId: projectId, metadata: { expectedRevision } });
        const project = await deps.projects.archive(ctx, companyId, projectId, expectedRevision);
        return reply.send(withApiVersion({
          status: "archived",
          project: toProjectSummary(project, undefined),
          // Stated because the UI relies on it: sessions cannot be started in an archived project, and the
          // refusal comes from the existing session service rather than from a second rule here.
          sessionsBlocked: true,
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** Unarchive. No `ProjectService` method exists, so the store write is injected explicitly and is refused when unwired. */
  instance.post<{ Params: ProjectParams; Body: { expectedRevision?: number } }>(
    "/companies/:companyId/code/projects/:projectId/unarchive",
    async (request, reply) => {
      try {
        const { companyId, projectId } = request.params;
        const ctx = await authorizeAction(request, companyId, CODE_PROJECT_ACTIONS.unarchive);
        const expectedRevision = revisionOf(request.body?.expectedRevision);
        if (!deps.unarchive) {
          throw new CodeProjectRouteError(
            // Its own code, so the answer is a 503 (a deployment gap) rather than the generic 500 the code
            // contract assigns to `project_lifecycle_request_failed`.
            "project_unarchive_unavailable",
            "Unarchiving is not available in this deployment",
            503,
            { reason: "unarchive_not_configured" },
            true,
          );
        }
        await auditOrFail({ ctx, companyId, action: "code.project.unarchive", resourceId: projectId, metadata: { expectedRevision } });
        const project = await deps.unarchive(ctx, companyId, projectId, expectedRevision);
        return reply.send(withApiVersion({ status: "unarchived", project: toProjectSummary(project, undefined) }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * One place that answers "what is the state of the on-disk workspace now?".
   *
   * Every outcome is reported as it is: `true` only when the directory is provably gone, `false` when bytes
   * remain, and `"unknown"` only when no removal mechanism is configured (a deployment gap, which is not the same
   * failure as a removal that ran and did not finish). Callers must not read access.
   */
  const attemptWorkspaceRemoval = async (
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<{ workspace: boolean | "unknown"; alreadyAbsent: boolean; failures: Array<{ target: string; reason: string; retryable: boolean }> }> => {
    const failures: Array<{ target: string; reason: string; retryable: boolean }> = [];
    if (!deps.removeWorkspace) {
      failures.push({ target: "workspace", reason: "workspace_removal_not_configured", retryable: true });
      return { workspace: "unknown", alreadyAbsent: false, failures };
    }
    try {
      const removal = await deps.removeWorkspace(ctx, companyId, projectId);
      if (!removal.removed) {
        failures.push({ target: "workspace", reason: removal.reason ?? "workspace_removal_failed", retryable: true });
      }
      return { workspace: removal.removed, alreadyAbsent: removal.alreadyAbsent === true, failures };
    } catch (error) {
      failures.push({ target: "workspace", reason: (error as Error).message, retryable: true });
      return { workspace: false, alreadyAbsent: false, failures };
    }
  };

  /**
   * Delete Plan (Dry Run): Returns exact resource breakdown, shared/dedicated status,
   * retention policy, and planned actions without performing any deletions.
   */
  const handleDeletePlan = async (request: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
    try {
      const { companyId, projectId } = request.params;
      const ctx = await authorizeAction(request, companyId, CODE_PROJECT_ACTIONS.deletePlan);
      if (!deps.lifecycleService) {
        throw new CodeProjectRouteError("lifecycle_unavailable", "Project lifecycle service is not configured", 503);
      }
      const plan = await deps.lifecycleService.getDeletePlan(ctx, companyId, projectId);
      return reply.send(withApiVersion({ ...plan }));
    } catch (error) {
      return fail(reply, error);
    }
  };
  instance.get<{ Params: ProjectParams }>("/companies/:companyId/code/projects/:projectId/delete-plan", handleDeletePlan);
  instance.get<{ Params: ProjectParams }>("/companies/:companyId/projects/:projectId/delete-plan", handleDeletePlan);

  /**
   * Soft Delete: Stops live preview and sandbox processes, revokes CORS, retains files and media for 30 days.
   */
  const handleSoftDelete = async (request: FastifyRequest<{ Params: ProjectParams; Body: { reason?: string; confirm?: boolean } }>, reply: FastifyReply) => {
    try {
      const { companyId, projectId } = request.params;
      const ctx = await authorizeAction(request, companyId, CODE_PROJECT_ACTIONS.softDelete);
      assertDeleteConfirmed(request.body);
      if (!deps.lifecycleService) {
        throw new CodeProjectRouteError("lifecycle_unavailable", "Project lifecycle service is not configured", 503);
      }
      await auditOrFail({ ctx, companyId, action: "code.project.soft_delete", resourceId: projectId, metadata: { reason: request.body?.reason } });
      const result = await deps.lifecycleService.softDelete(ctx, companyId, projectId, { reason: request.body?.reason });
      return reply.send(withApiVersion(result));
    } catch (error) {
      return fail(reply, error);
    }
  };
  instance.post<{ Params: ProjectParams; Body: { reason?: string; confirm?: boolean } }>("/companies/:companyId/code/projects/:projectId/soft-delete", handleSoftDelete);
  instance.post<{ Params: ProjectParams; Body: { reason?: string; confirm?: boolean } }>("/companies/:companyId/projects/:projectId/soft-delete", handleSoftDelete);

  /**
   * Restore: Safely restores soft-deleted project, re-attaches DataBackend, restores status to ready.
   */
  const handleRestore = async (request: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
    try {
      const { companyId, projectId } = request.params;
      const ctx = await authorizeAction(request, companyId, CODE_PROJECT_ACTIONS.restore);
      if (!deps.lifecycleService) {
        throw new CodeProjectRouteError("lifecycle_unavailable", "Project lifecycle service is not configured", 503);
      }
      await auditOrFail({ ctx, companyId, action: "code.project.restore", resourceId: projectId });
      const result = await deps.lifecycleService.restore(ctx, companyId, projectId);
      return reply.send(withApiVersion(result));
    } catch (error) {
      return fail(reply, error);
    }
  };
  instance.post<{ Params: ProjectParams }>("/companies/:companyId/code/projects/:projectId/restore", handleRestore);
  instance.post<{ Params: ProjectParams }>("/companies/:companyId/projects/:projectId/restore", handleRestore);

  /**
   * Hard Purge: Purges dedicated files, media and database records. Enforces retention unless force: true.
   */
  const handleHardPurge = async (request: FastifyRequest<{ Params: ProjectParams; Body: { confirm?: boolean; force?: boolean } }>, reply: FastifyReply) => {
    try {
      const { companyId, projectId } = request.params;
      const ctx = await authorizeAction(request, companyId, CODE_PROJECT_ACTIONS.hardPurge);
      assertDeleteConfirmed(request.body);
      if (!deps.lifecycleService) {
        throw new CodeProjectRouteError("lifecycle_unavailable", "Project lifecycle service is not configured", 503);
      }
      if (request.body?.force === true && ctx.role !== "owner" && ctx.role !== "admin") {
        throw new CodeProjectRouteError(
          "force_purge_not_permitted",
          "Immediate hard purge bypassing retention is restricted to company owners and administrators",
          403,
          { role: ctx.role },
        );
      }
      await auditOrFail({ ctx, companyId, action: "code.project.hard_purge", resourceId: projectId, metadata: { force: request.body?.force } });
      const result = await deps.lifecycleService.hardPurge(ctx, companyId, projectId, { force: request.body?.force });
      return reply.send(withApiVersion(result));
    } catch (error) {
      return fail(reply, error);
    }
  };
  instance.post<{ Params: ProjectParams; Body: { confirm?: boolean; force?: boolean } }>("/companies/:companyId/code/projects/:projectId/hard-purge", handleHardPurge);
  instance.post<{ Params: ProjectParams; Body: { confirm?: boolean; force?: boolean } }>("/companies/:companyId/projects/:projectId/hard-purge", handleHardPurge);

  /**
   * Delete. If lifecycleService is configured, migrates delete to Soft Delete (Requirement 12).
   */
  instance.delete<{ Params: ProjectParams; Body: { confirm?: boolean; force?: boolean } }>(
    "/companies/:companyId/code/projects/:projectId",
    async (request, reply) => {
      try {
        const { companyId, projectId } = request.params;
        const ctx = await authorizeAction(request, companyId, CODE_PROJECT_ACTIONS.delete);
        assertDeleteConfirmed(request.body);
        await auditOrFail({ ctx, companyId, action: "code.project.delete", resourceId: projectId, metadata: { confirmed: true } });

        // If lifecycleService is configured, route delete through the new lifecycle (Requirement 12)
        if (deps.lifecycleService) {
          if (request.body?.force === true) {
            if (ctx.role !== "owner" && ctx.role !== "admin") {
              throw new CodeProjectRouteError(
                "force_purge_not_permitted",
                "Immediate hard purge bypassing retention is restricted to company owners and administrators",
                403,
                { role: ctx.role },
              );
            }
            const purge = await deps.lifecycleService.hardPurge(ctx, companyId, projectId, { force: true });
            return reply.send(withApiVersion({
              status: "deleted",
              purged: purge.purged,
              removed: { project: true, sandbox: purge.purged.sandboxDestroyed, dataBackendArtifacts: true, workspace: purge.purged.workspaceRemoved, workspaceAlreadyAbsent: false },
              failures: [],
            }));
          }
          try {
            const soft = await deps.lifecycleService.softDelete(ctx, companyId, projectId, { reason: "website_delete_api" });
            return reply.send(withApiVersion({
              status: "soft_deleted",
              retentionDays: soft.retentionDays,
              purgeAfter: soft.purgeAfter,
              actions: soft.actions,
              removed: { project: true, sandbox: true, dataBackendArtifacts: true, workspace: "retained_for_soft_delete", workspaceAlreadyAbsent: false },
              failures: [],
            }));
          } catch (error) {
            if (resolveErrorCode(error) === "project_not_found") {
              return reply.send(withApiVersion({
                status: "already_deleted",
                removed: { project: true, sandbox: true, dataBackendArtifacts: true, workspace: true, workspaceAlreadyAbsent: true },
                failures: [],
              }));
            }
            throw error;
          }
        }

        try {
          await deps.projects.delete(ctx, companyId, projectId);
        } catch (error) {
          if (resolveErrorCode(error) === "project_not_found") {
            const repeat = await attemptWorkspaceRemoval(ctx, companyId, projectId);
            return reply.send(withApiVersion({
              status: "already_deleted",
              removed: { project: true, sandbox: true, dataBackendArtifacts: true, workspace: repeat.workspace, workspaceAlreadyAbsent: repeat.alreadyAbsent },
              failures: repeat.failures,
            }));
          }
          throw error;
        }

        const removal = await attemptWorkspaceRemoval(ctx, companyId, projectId);
        const failures = removal.failures;

        const status = failures.length === 0 ? "deleted" : "partial";
        if (failures.length > 0) {
          deps.logger?.warn({ projectId, failures }, "code_project_delete_partial");
        }
        return reply.send(withApiVersion({
          status,
          removed: { project: true, sandbox: true, dataBackendArtifacts: true, workspace: removal.workspace, workspaceAlreadyAbsent: removal.alreadyAbsent },
          failures,
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}

/** Exported for the route tests: the shape the UI receives when a project is not deletable twice. */
export const ALREADY_DELETED_MESSAGE = "The project is already deleted (already_deleted).";

export type CodeProjectLifecycleStore = Pick<WorkspaceStore, "getProject" | "listProjects">;
