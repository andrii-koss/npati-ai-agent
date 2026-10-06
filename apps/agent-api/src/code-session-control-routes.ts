import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import type { CodeAuditPort } from "./code-project-trust";
import { assertSafeWorkspacePath } from "./code-tool-runtime";
import type { CodeRunCancellationRegistry, CodeRunCancellationRecord } from "./code-run-cancellation";
import type { StoredCodeActiveContext } from "./code-active-context-store";

/**
 * C7 — session control the UI needs: Stop, usage, Changes/Revert and the active project/session for chat.
 *
 * This module owns no execution and no git logic. Stop records a cancellation in the C7 registry and aborts
 * whichever live controller this process holds, so the loop stops at its next step boundary and releases its
 * own sandbox through the C6 path. Changes come from the existing workspace change reader, and Revert restores
 * through the existing checkpoint service (whose pre-restore safety checkpoint is mandatory).
 *
 * Four properties are deliberate:
 *
 * 1. **Stop never claims more than it did.** The answer says whether a live run was actually aborted and
 *    whether the sandbox was released; a Stop for a run owned by another replica is reported as recorded but
 *    not aborted, because the in-process registry cannot reach it (C6a's lease expiry plus the reconciler cover
 *    that case). A "stopped" message that hides this would be a lie the operator cannot see through.
 * 2. **Usage never invents numbers.** When no accounting source is wired the answer is an explicit
 *    `unavailable` with a reason, not zeros dressed up as measurements.
 * 3. **Revert validates paths with the canonical validator** (`assertSafeWorkspacePath`), so a `..` or an
 *    absolute path is refused before any git call. Reverting a subset of files needs a git operation that does
 *    not exist yet; the route refuses it explicitly (`changes_revert_file_unsupported`) instead of performing an
 *    all-files hard reset and calling it a per-file revert.
 * 4. **The active context is validated, not duplicated.** The existing context resolver decides what a valid
 *    active project is (including "an archived project cannot be the active context"). Persistence reuses the
 *    existing per-user settings store through the `activeContextStore` port — the same mechanism the chat
 *    project cards already use — because the step forbids inventing a second settings/context system. When the
 *    port is not wired the PUT still validates but answers `persisted: false` with a reason, so a deployment
 *    without it degrades honestly instead of pretending to remember.
 *
 * Refusal codes are part of the contract because the UI explains them:
 *   unauthorized · invalid_arguments · session_not_found · project_not_found · session_archived
 *   permission_denied · action_not_mapped · permission_action_mismatch · agent_cannot_change_policy
 *   changes_revert_file_unsupported · changes_unavailable · usage_unavailable
 *   audit_unavailable · session_control_request_failed
 */
export class CodeSessionControlError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeSessionControlError";
    this.retryable = retryable;
  }
}

export const CODE_SESSION_CONTROL_ACTIONS = Object.freeze({
  list: "code.session.list",
  stop: "code.session.stop",
  usageRead: "code.session.usage.read",
  changesRead: "code.changes.read",
  changesRevert: "code.changes.revert",
  activeContextRead: "code.active_context.read",
  activeContextWrite: "code.active_context.write",
});

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  agent_cannot_change_policy: 403,
  session_not_found: 404,
  project_not_found: 404,
  session_archived: 409,
  changes_revert_file_unsupported: 501,
  usage_unavailable: 503,
  changes_unavailable: 503,
  audit_unavailable: 503,
  session_control_request_failed: 500,
};

interface CompanyParams { companyId: string }
interface ProjectParams extends CompanyParams { projectId: string }
interface SessionParams extends CompanyParams { sessionId: string }

export interface CodeSessionUsage {
  /**
   * `input`/`output` are `null` when the source only produced a total: an estimate must not be split into two
   * numbers it never measured. `total` is always present.
   */
  tokens: { input: number | null; output: number | null; total: number };
  /** `null` when the price is unknown. It is never `0`, because `0` reads as "this run was free". */
  costUsd: number | null;
  runs: number;
  source: string;
  /** Additive: `true` when the numbers come from the runner's summary rather than from provider metering. */
  estimated?: boolean;
  /** Additive: how the numbers were combined (e.g. summed per model step for the whole session). */
  aggregation?: string;
  /** Additive: `unavailable` says the tokens are real but the price is not known, with the reason. */
  costStatus?: "ok" | "unavailable";
  costReason?: string;
  /** Additive: present on the estimated path, where the runner's summary is the only record of the run's shape. */
  turns?: number;
  toolCalls?: number;
  filesChanged?: number;
  diffStats?: { files: number; linesAdded: number; linesRemoved: number };
}

export interface CodeChangesView {
  summary: { added: number; modified: number; deleted: number; total: number };
  /**
   * Changed files with **diff statistics only**. The existing workspace reader also returns the diff body; it is
   * deliberately not forwarded here, so this surface cannot become a new content-egress path. A caller that
   * needs the body uses the existing turn-diff route.
   */
  changes: Array<{ path: string; status: string; added: number; removed: number }>;
}

export interface CodeRevertOutcome {
  restored: boolean;
  files: string[];
  /** Additive: paths removed because they did not exist at the checkpoint (created after it). */
  removed?: string[];
  safetyCheckpointId: string | null;
  reason?: string;
}

export interface ActiveContextView {
  contextType: string;
  companyId: string | null;
  projectId: string | null;
  projectStatus?: string | null;
}

export interface CodeSessionControlDeps {
  sessions: {
    get(ctx: AuthContext, companyId: string, sessionId: string): Promise<CodeSession>;
    list(ctx: AuthContext, companyId: string, projectId?: string, options?: { includeArchived?: boolean; limit?: number }): Promise<CodeSession[]>;
  };
  /** The C7 cancellation registry: the only thing that can flip the runner's `cancelRequested` probe. */
  cancellation: CodeRunCancellationRegistry;
  /**
   * Optional: the durable state of a run (C6a run state), keyed by the session's own `runId`. The session
   * already carries that id, so no scan over run states is needed to find "the run of this session".
   */
  runState?: (ctx: AuthContext, companyId: string, runId: string) => Promise<{ status: string; startedAt?: Date | string | null; heartbeatAt?: Date | string | null } | null>;
  /** Optional: releasing the sandbox for a session, through the existing C6 path. */
  releaseSandbox?: (ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string }) => Promise<{ released: boolean; reason?: string }>;
  /**
   * Optional: usage accounting from an existing source. Three answers are distinguishable on purpose: `null` means
   * nothing was ever recorded for the session, `{ unavailable }` means a source exists but could not produce a
   * measurement (with the reason), and a usage object carries real numbers. None of them is ever `0`.
   */
  usage?: (ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string; runId?: string | null }) => Promise<CodeSessionUsage | { unavailable: string } | null>;
  /** Optional: the existing workspace change reader. */
  changes?: (ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string }) => Promise<CodeChangesView>;
  /** Optional: revert through the existing checkpoint service. `files` needs a git-path restore that does not exist yet. */
  revert?: {
    all(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string; expectedRunId?: string }): Promise<CodeRevertOutcome>;
    files?: (ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string; files: string[] }) => Promise<CodeRevertOutcome>;
  };
  /** Optional: the existing active-context resolver (validation only; persistence goes through the port below). */
  activeContext?: {
    resolve(ctx: AuthContext, requested: { contextType?: string; companyId?: string | null; projectId?: string | null; businessId?: string | null }): Promise<ActiveContextView>;
  };
  /**
   * Optional: persistence for the active context on the EXISTING per-user settings store (the one the chat
   * project cards use). Absent means "this deployment does not remember it", which is reported as such.
   */
  activeContextStore?: {
    read(ctx: AuthContext, companyId: string): Promise<StoredCodeActiveContext | null>;
    write(ctx: AuthContext, companyId: string, input: { contextType: string; projectId: string | null; sessionId: string | null }): Promise<StoredCodeActiveContext>;
  };
  audit?: CodeAuditPort;
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeSessionControlError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  if (error instanceof WorkspaceNotFoundError) return "session_not_found";
  if (error instanceof WorkspaceAccessError) return "session_not_found";
  return "session_control_request_failed";
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
  const message = code === "session_control_request_failed"
    ? "Code session request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Code session request failed");
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

function badRequest(message: string, details: Record<string, unknown> = {}): CodeSessionControlError {
  return new CodeSessionControlError("invalid_arguments", message, 400, details);
}

/**
 * Revert request validation. Paths go through the canonical workspace validator, so `..`, absolute paths and
 * empty entries are refused here rather than reaching a git call. `all` and `files` are mutually exclusive
 * because "revert everything and also these three files" has no defined meaning.
 */
export function resolveRevertRequest(body: unknown): { all: boolean; files: string[] } {
  const shaped = (body ?? {}) as { all?: unknown; files?: unknown };
  const all = shaped.all === true;
  if (shaped.files !== undefined && !Array.isArray(shaped.files)) {
    throw badRequest("files must be an array of workspace-relative paths", { field: "files" });
  }
  const files = (shaped.files as unknown[] | undefined ?? []).map((entry) => {
    try {
      return assertSafeWorkspacePath(entry);
    } catch (error) {
      throw badRequest("A file path is not a safe workspace-relative path", {
        field: "files",
        reason: (error as Error).message,
      });
    }
  });
  if (all && files.length > 0) {
    throw badRequest("Provide either all or files, not both", { fields: ["all", "files"] });
  }
  if (!all && files.length === 0) {
    throw badRequest("Provide all: true or a non-empty files list", { fields: ["all", "files"] });
  }
  return { all, files };
}

/**
 * The Stop operation, exported so it can be exercised without a Fastify instance. It records the cancellation
 * first (so a loop that reaches its next boundary stops even if nothing else works), then aborts a live
 * controller when this process holds one. Both facts are reported.
 */
export async function performSessionStop(
  deps: Pick<CodeSessionControlDeps, "cancellation" | "releaseSandbox" | "logger">,
  ctx: AuthContext,
  input: { companyId: string; projectId: string; sessionId: string; runId?: string | null; reason?: string },
): Promise<{
  status: "stop_requested" | "already_stopping";
  cancellation: CodeRunCancellationRecord;
  liveRunAborted: boolean;
  sandboxReleased: boolean | null;
  sandboxReleaseReason?: string;
}> {
  const existing = deps.cancellation.getSessionCancellation(input.sessionId);
  const record = existing ?? deps.cancellation.requestSessionCancel({
    sessionId: input.sessionId,
    companyId: input.companyId,
    projectId: input.projectId,
    requestedBy: ctx.userId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
  const aborted = deps.cancellation.abortLiveRuns(input.sessionId);

  let sandboxReleased: boolean | null = null;
  let sandboxReleaseReason: string | undefined;
  if (deps.releaseSandbox) {
    try {
      const release = await deps.releaseSandbox(ctx, {
        companyId: input.companyId,
        projectId: input.projectId,
        sessionId: input.sessionId,
      });
      sandboxReleased = release.released;
      if (!release.released) sandboxReleaseReason = release.reason ?? "sandbox_release_failed";
    } catch (error) {
      sandboxReleased = false;
      sandboxReleaseReason = (error as Error).message;
    }
  } else {
    // Nothing to release here is a different fact from "release failed", and the caller needs to tell them
    // apart: an unwired release is a deployment gap, a failed release is an incident.
    sandboxReleaseReason = "sandbox_release_not_configured";
  }
  if (sandboxReleaseReason) deps.logger?.warn({ sessionId: input.sessionId, sandboxReleaseReason }, "code_session_stop_sandbox");

  return {
    status: existing ? "already_stopping" : "stop_requested",
    cancellation: record,
    liveRunAborted: aborted > 0,
    sandboxReleased,
    ...(sandboxReleaseReason === undefined ? {} : { sandboxReleaseReason }),
  };
}

export async function registerCodeSessionControlRoutes(instance: FastifyInstance, deps: CodeSessionControlDeps) {
  const contextOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    return context;
  };

  const authorizeAction = async (request: unknown, companyId: string, action: string): Promise<AuthContext> => {
    const ctx = contextOrFail(request);
    await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });
    return ctx;
  };

  const auditOrFail = async (input: { ctx: AuthContext; companyId: string; action: string; resourceId: string; metadata?: Record<string, unknown> }): Promise<void> => {
    if (!deps.audit) {
      throw new CodeSessionControlError("audit_unavailable", "Audit journal is unavailable", 503, { reason: "audit_not_configured" }, true);
    }
    try {
      await deps.audit.record({
        action: input.action,
        actor: input.ctx.userId,
        companyId: input.companyId,
        resourceType: "code_session",
        resourceId: input.resourceId,
        metadata: input.metadata ?? {},
      });
    } catch (error) {
      throw new CodeSessionControlError("audit_unavailable", "Audit journal is unavailable", 503, { reason: (error as Error).message }, true);
    }
  };

  /**
   * Sessions of one project with their newest durable run. The path mirrors the existing session-creation
   * route (`POST /companies/:companyId/projects/:projectId/code/sessions`), so the UI has one prefix for a
   * project's sessions instead of two competing conventions.
   */
  instance.get<{ Params: ProjectParams; Querystring: { includeArchived?: string; limit?: string } }>(
    "/companies/:companyId/projects/:projectId/code/sessions",
    async (request, reply) => {
      try {
        const { companyId, projectId } = request.params;
        const ctx = await authorizeAction(request, companyId, CODE_SESSION_CONTROL_ACTIONS.list);
        const includeArchived = String(request.query?.includeArchived ?? "") === "true";
        const limitRaw = Number(request.query?.limit ?? 50);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
        const sessions = await deps.sessions.list(ctx, companyId, projectId, { includeArchived, limit });
        // The run is the one the session itself points at (`CodeSession.runId`), so the list never has to guess
        // by scanning run states. A lookup failure leaves the session visible with `lastRun: null`.
        const runStates = await Promise.all(sessions.map(async (session) => {
          if (!session.runId || !deps.runState) return null;
          try {
            return await deps.runState(ctx, companyId, session.runId);
          } catch {
            return null;
          }
        }));
        return reply.send(withApiVersion({
          status: "ok",
          projectId,
          sessions: sessions.map((session, index) => ({
            sessionId: session.id,
            projectId: session.projectId,
            mode: session.mode,
            status: session.status,
            modelProfile: session.modelProfile ?? null,
            toolManifestVersion: session.toolManifestVersion ?? null,
            dataClassification: session.dataClassification,
            retentionClass: session.retentionClass,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            lastRun: session.runId
              ? {
                runId: session.runId,
                status: runStates[index]?.status ?? null,
                startedAt: runStates[index]?.startedAt ?? null,
                heartbeatAt: runStates[index]?.heartbeatAt ?? null,
                // The registry is the only in-process truth about a stop, so it is reported next to the run.
                stopRequested: deps.cancellation.isSessionCancelled(session.id),
              }
              : null,
          })),
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * Stop. Records the cancellation, aborts a live run this process owns and reports both facts separately —
   * "recorded but not aborted" is a real and common outcome for a run held by another replica.
   */
  instance.post<{ Params: SessionParams; Body: { reason?: string; runId?: string } }>(
    "/companies/:companyId/code/sessions/:sessionId/stop",
    async (request, reply) => {
      try {
        const { companyId, sessionId } = request.params;
        const ctx = await authorizeAction(request, companyId, CODE_SESSION_CONTROL_ACTIONS.stop);
        const session = await deps.sessions.get(ctx, companyId, sessionId);
        if (session.status === "archived") throw new CodeSessionControlError("session_archived", "Archived sessions cannot be stopped", 409, { sessionId: "" });
        await auditOrFail({
          ctx,
          companyId,
          action: "code.session.stop",
          resourceId: sessionId,
          metadata: { projectId: session.projectId, reason: request.body?.reason ?? "user_stop" },
        });
        const outcome = await performSessionStop(deps, ctx, {
          companyId,
          projectId: session.projectId,
          sessionId,
          runId: request.body?.runId ?? null,
          ...(request.body?.reason === undefined ? {} : { reason: request.body.reason }),
        });
        return reply.send(withApiVersion({
          ...outcome,
          // Stated explicitly so the UI can explain a Stop that could not reach the loop in this process.
          note: outcome.liveRunAborted
            ? "The running loop was aborted in this process and will stop at its next step boundary."
            : "Cancellation recorded. If the run is owned by another replica it stops through lease expiry and the reconciler.",
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** Usage from an existing accounting source; without one the answer is `unavailable`, never fabricated zeros. */
  instance.get<{ Params: SessionParams }>("/companies/:companyId/code/sessions/:sessionId/usage", async (request, reply) => {
    try {
      const { companyId, sessionId } = request.params;
      const ctx = await authorizeAction(request, companyId, CODE_SESSION_CONTROL_ACTIONS.usageRead);
      const session = await deps.sessions.get(ctx, companyId, sessionId);
      if (!deps.usage) {
        return reply.send(withApiVersion({
          status: "unavailable",
          sessionId,
          usage: null,
          reason: "usage_accounting_not_configured",
          message: "Token and cost accounting is not wired for code runs in this deployment (usage_unavailable).",
        }));
      }
      const usage = await deps.usage(ctx, { companyId, projectId: session.projectId, sessionId, runId: session.runId ?? null });
      if (!usage) {
        return reply.send(withApiVersion({
          status: "unavailable",
          sessionId,
          usage: null,
          reason: "usage_not_recorded_for_session",
        }));
      }
      if ("unavailable" in usage) {
        // A source exists but could not measure: return the reason verbatim instead of a total that would be read
        // as a measurement (for example `provider_did_not_report_usage`).
        return reply.send(withApiVersion({
          status: "unavailable",
          sessionId,
          usage: null,
          reason: usage.unavailable,
        }));
      }
      return reply.send(withApiVersion({
        status: "ok",
        sessionId,
        // Flat `totalTokens`/`inputTokens`/`outputTokens` alongside the structured `tokens`: a reader that shows a
        // single number must not have to fall back to `0` when the field it expects is absent.
        usage: { ...usage, totalTokens: usage.tokens.total, inputTokens: usage.tokens.input, outputTokens: usage.tokens.output },
      }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Changes of a session, read through the existing workspace change reader. */
  instance.get<{ Params: SessionParams }>("/companies/:companyId/code/sessions/:sessionId/changes", async (request, reply) => {
    try {
      const { companyId, sessionId } = request.params;
      const ctx = await authorizeAction(request, companyId, CODE_SESSION_CONTROL_ACTIONS.changesRead);
      const session = await deps.sessions.get(ctx, companyId, sessionId);
      if (!deps.changes) {
        throw new CodeSessionControlError("changes_unavailable", "Workspace changes are not available in this deployment", 503, { reason: "changes_reader_not_configured" }, true);
      }
      const changes = await deps.changes(ctx, { companyId, projectId: session.projectId, sessionId });
      // The response is rebuilt from named fields instead of forwarding the reader's objects: the existing
      // reader also returns the diff body, and a boundary that copies whatever it is handed is exactly how
      // content reaches a surface that was only supposed to carry statistics.
      return reply.send(withApiVersion({
        status: "ok",
        sessionId,
        projectId: session.projectId,
        summary: {
          added: changes.summary.added,
          modified: changes.summary.modified,
          deleted: changes.summary.deleted,
          total: changes.summary.total,
        },
        changes: changes.changes.map((change) => ({
          path: change.path,
          status: change.status,
          added: change.added,
          removed: change.removed,
        })),
      }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Revert: `all` goes through the existing checkpoint service (its pre-restore safety checkpoint is mandatory), and
   * `files` through the path-scoped restore — which makes the named paths match the **checkpoint** state, restoring
   * what existed there and removing what was created afterwards. A deployment without the `files` port refuses
   * explicitly (501) rather than silently turning a per-file revert into an all-files hard reset.
   */
  instance.post<{ Params: SessionParams; Body: { all?: boolean; files?: unknown } }>(
    "/companies/:companyId/code/sessions/:sessionId/changes/revert",
    async (request, reply) => {
      try {
        const { companyId, sessionId } = request.params;
        const ctx = await authorizeAction(request, companyId, CODE_SESSION_CONTROL_ACTIONS.changesRevert);
        const session = await deps.sessions.get(ctx, companyId, sessionId);
        const revert = resolveRevertRequest(request.body);
        if (!deps.revert) {
          throw new CodeSessionControlError("changes_unavailable", "Revert is not available in this deployment", 503, { reason: "revert_not_configured" }, true);
        }
        if (!revert.all) {
          if (!deps.revert.files) {
            throw new CodeSessionControlError(
              "changes_revert_file_unsupported",
              "This deployment has no path-scoped restore configured for individual files",
              501,
              { reason: "requires_git_checkout_paths", files: revert.files },
            );
          }
        }
        await auditOrFail({
          ctx,
          companyId,
          action: "code.changes.revert",
          resourceId: sessionId,
          metadata: { projectId: session.projectId, all: revert.all, fileCount: revert.files.length },
        });
        const outcome = revert.all
          ? await deps.revert.all(ctx, { companyId, projectId: session.projectId, sessionId })
          : await deps.revert.files!(ctx, { companyId, projectId: session.projectId, sessionId, files: revert.files });
        return reply.send(withApiVersion({
          status: outcome.restored ? "reverted" : "not_reverted",
          sessionId,
          projectId: session.projectId,
          files: outcome.files,
          // Additive: paths that had to be *removed* to reach the checkpoint state (a file created after it). A
          // caller that only looks at `files` still sees them, but the distinction is available.
          ...(outcome.removed === undefined ? {} : { removed: outcome.removed }),
          safetyCheckpointId: outcome.safetyCheckpointId,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * The active project/session for chat. GET derives it through the existing resolver and adds the newest
   * session; PUT validates the requested context (an archived or foreign project is refused by the resolver)
   * and answers `persisted: false`, because no per-user active-context store exists and this module will not
   * invent a second settings system.
   */
  const readActiveContext = async (ctx: AuthContext, requested: Parameters<NonNullable<CodeSessionControlDeps["activeContext"]>["resolve"]>[1]) => {
    if (!deps.activeContext) {
      throw new CodeSessionControlError("session_control_request_failed", "Active context resolution is not available in this deployment", 503, { reason: "active_context_resolver_not_configured" }, true);
    }
    const resolved = await deps.activeContext.resolve(ctx, requested);
    const sessions = resolved.companyId && resolved.projectId
      ? await deps.sessions.list(ctx, resolved.companyId, resolved.projectId, { includeArchived: false, limit: 1 })
      : [];
    return { resolved, session: sessions[0] ?? null };
  };

  instance.get<{ Params: CompanyParams; Querystring: { projectId?: string; contextType?: string } }>(
    "/companies/:companyId/code/active-context",
    async (request, reply) => {
      try {
        const { companyId } = request.params;
        const ctx = await authorizeAction(request, companyId, CODE_SESSION_CONTROL_ACTIONS.activeContextRead);
        // A stored context is what makes "continue this conversation in the active project" work in chat. An
        // explicit query parameter still wins, so the UI can inspect any project without changing the stored one.
        const stored = deps.activeContextStore ? await deps.activeContextStore.read(ctx, companyId) : null;
        const explicitProjectId = request.query?.projectId ?? null;
        const requestedProjectId = explicitProjectId ?? stored?.projectId ?? null;
        const { resolved, session } = await readActiveContext(ctx, {
          contextType: request.query?.contextType ?? stored?.contextType ?? "project",
          companyId,
          projectId: requestedProjectId,
        });
        // Prefer the stored session, but only after re-reading it: a session archived or moved to another project
        // since it was stored must not be handed back as the active one.
        let activeSession = session;
        if (!explicitProjectId && stored?.sessionId && resolved.projectId) {
          const storedSession = await deps.sessions.get(ctx, companyId, stored.sessionId).catch(() => null);
          if (storedSession && storedSession.status !== "archived" && storedSession.projectId === resolved.projectId) {
            activeSession = storedSession;
          }
        }
        return reply.send(withApiVersion({
          status: "ok",
          activeContext: resolved,
          session: activeSession
            ? { sessionId: activeSession.id, mode: activeSession.mode, status: activeSession.status, updatedAt: activeSession.updatedAt }
            : null,
          persisted: Boolean(stored),
          source: stored ? (explicitProjectId ? "stored_overridden_by_request" : "stored") : "derived",
          ...(stored ? { updatedAt: stored.updatedAt } : { reason: "active_context_is_derived_not_stored" }),
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  instance.put<{ Params: CompanyParams; Body: { projectId?: string | null; sessionId?: string | null; contextType?: string } }>(
    "/companies/:companyId/code/active-context",
    async (request, reply) => {
      try {
        const { companyId } = request.params;
        const ctx = await authorizeAction(request, companyId, CODE_SESSION_CONTROL_ACTIONS.activeContextWrite);
        const body = request.body ?? {};
        const projectId = body.projectId === undefined || body.projectId === null ? null : String(body.projectId);
        if (projectId !== null && !projectId.trim()) throw badRequest("projectId must be a non-empty string or null", { field: "projectId" });
        // Where a session is named it must belong to the named project: a session id from another project is a
        // client mistake, and letting it through would point chat at the wrong workspace.
        let sessionId: string | null = null;
        if (body.sessionId !== undefined && body.sessionId !== null) {
          const session = await deps.sessions.get(ctx, companyId, String(body.sessionId));
          if (projectId !== null && session.projectId !== projectId) {
            throw badRequest("sessionId does not belong to projectId", { fields: ["sessionId", "projectId"] });
          }
          if (session.status === "archived") throw new CodeSessionControlError("session_archived", "Archived sessions cannot be the active session", 409, {});
          sessionId = session.id;
        }
        const { resolved } = await readActiveContext(ctx, {
          contextType: body.contextType ?? (projectId ? "project" : "company"),
          companyId,
          projectId,
        });
        await auditOrFail({
          ctx,
          companyId,
          action: "code.active_context.write",
          resourceId: resolved.projectId ?? companyId,
          metadata: { projectId: resolved.projectId, sessionId, contextType: resolved.contextType },
        });
        // Persist only after the journal accepted the change (fail closed): the audit is what makes this
        // privileged state change reviewable, so it must not be possible to store the pointer without it.
        const stored = deps.activeContextStore
          ? await deps.activeContextStore.write(ctx, companyId, {
            contextType: resolved.contextType ?? (projectId ? "project" : "company"),
            projectId: resolved.projectId ?? projectId,
            sessionId,
          })
          : null;
        return reply.send(withApiVersion({
          status: stored ? "persisted" : "validated",
          activeContext: resolved,
          sessionId,
          persisted: Boolean(stored),
          ...(stored
            ? { source: "stored" as const, updatedAt: stored.updatedAt }
            : {
              reason: "active_context_store_not_configured",
              message: "The active context was validated but not stored: this deployment has no active-context store, so the client keeps supplying it per request.",
            }),
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
