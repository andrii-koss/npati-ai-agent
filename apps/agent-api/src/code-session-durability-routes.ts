import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import {
  CodeSessionDurabilityError,
  CODE_SESSION_DURABILITY_ACTIONS,
  toNoticeView,
} from "./code-session-durability";
import type { CodeSessionResumeNoticeRow, CodeSessionResumeRequest, CodeSessionResumeService } from "./code-session-resume";
import type { CodeSessionRewindRequest, CodeSessionRewindService } from "./code-session-rewind";
import type { CodeSessionForkRequest, CodeSessionForkService } from "./code-session-fork";

/**
 * C10 — the transport for resume, rewind, fork and the recovery notice.
 *
 * Three properties are deliberate, and they mirror the surfaces the earlier steps built:
 *
 * 1. **No existence oracle.** A session (or run) of another tenant and one that never existed produce the *same*
 *    response with no ids in the details. The store reads are tenant-scoped, so `null` already covers the foreign
 *    case; the route's job is to not add anything that would tell the two apart. The same rule applies to the
 *    recovery route: an unknown run and a foreign run are one identical 404.
 * 2. **Authorization before any read, and the permission derived from a named action.** Every route goes through
 *    the shared C5a gate with its own action name (`code.session.resume`, `code.rewind`, `code.session.fork`,
 *    `code.recovery.read`), so a caller cannot authorize a rewind by handing in a read label. The gate is called
 *    before the session is loaded, which is why an unauthorized caller cannot use the surfacing of
 *    `session_not_found` as a probe either.
 * 3. **Every mutation is journalled before it applies.** The audit entries are written inside the services, after
 *    the operation is claimed and before any checkpoint or cursor is touched, so an audit outage refuses the
 *    change instead of applying it unrecorded.
 *
 * Refusal codes are part of the contract because the UI explains them:
 *   unauthorized · invalid_arguments · session_not_found · session_archived · run_not_found · run_not_resumable
 *   run_waiting_for_user · run_lease_held · run_revision_conflict · session_revision_conflict · checkpoint_not_found
 *   checkpoint_unavailable · turn_has_no_checkpoint · turn_index_required · rewind_in_progress · rewind_failed
 *   fork_in_progress · fork_incomplete · fork_failed · session_head_revision_conflict · resume_prompt_invalid
 *   run_environment_revoked · audit_unavailable · permission_denied · permission_action_mismatch · action_not_mapped
 *   session_durability_request_failed
 */

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  agent_cannot_change_policy: 403,
  session_not_found: 404,
  run_not_found: 404,
  checkpoint_not_found: 404,
  session_archived: 409,
  run_not_resumable: 409,
  run_waiting_for_user: 409,
  run_lease_held: 409,
  // C10 (Question 2): the environment the run was admitted in is no longer usable — its sandbox image was
  // revoked. It is a 409 with `retryable: true` on purpose: resolving the image and resuming again is exactly
  // the intended recovery, and the run was left untouched for it.
  run_environment_revoked: 409,
  run_revision_conflict: 409,
  session_revision_conflict: 409,
  session_head_revision_conflict: 409,
  turn_has_no_checkpoint: 409,
  rewind_in_progress: 409,
  fork_in_progress: 409,
  fork_incomplete: 409,
  rewind_failed: 500,
  fork_failed: 500,
  resume_prompt_invalid: 500,
  checkpoint_unavailable: 503,
  audit_unavailable: 503,
  session_durability_request_failed: 500,
};

interface CompanyParams { companyId: string }
interface SessionParams extends CompanyParams { sessionId: string }
interface RunParams extends CompanyParams { runId: string }

export interface CodeSessionDurabilityRouteDeps {
  resume: CodeSessionResumeService;
  rewind: CodeSessionRewindService;
  fork: CodeSessionForkService;
  /** The recovery notice read: the newest persisted notice of a run, or `null` when there is none. */
  recovery: {
    /** Whether the run exists for this company. Tenant-scoped, so a foreign run is `false`. */
    runExists(companyId: string, runId: string): Promise<boolean>;
    loadNotice(companyId: string, runId: string): Promise<CodeSessionResumeNoticeRow | null>;
    countNotices(companyId: string, runId: string): Promise<number>;
  };
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeSessionDurabilityError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  if (error instanceof WorkspaceNotFoundError) return "session_not_found";
  if (error instanceof WorkspaceAccessError) return "session_not_found";
  return "session_durability_request_failed";
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
  const message = code === "session_durability_request_failed"
    ? "Code session durability request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Code session durability request failed");
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

export async function registerCodeSessionDurabilityRoutes(
  instance: FastifyInstance,
  deps: CodeSessionDurabilityRouteDeps,
) {
  const authorizeAction = async (request: unknown, companyId: string, action: string): Promise<AuthContext> => {
    const ctx = deps.getAuthContext(request);
    if (!ctx) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });
    return ctx;
  };

  /**
   * Resume. The body may name the run (a session whose link predates C10) and the question the user answered; the
   * run id itself is never minted here, because a resume continues one run.
   */
  instance.post<{
    Params: SessionParams;
    Body: { runId?: string; expectedRevision?: number; questionId?: string; restoreWorkspace?: boolean };
  }>(
    "/companies/:companyId/code/sessions/:sessionId/resume",
    async (request, reply) => {
      const { companyId, sessionId } = request.params;
      try {
        const ctx = await authorizeAction(request, companyId, CODE_SESSION_DURABILITY_ACTIONS.resume);
        const body = request.body ?? {};
        const input: CodeSessionResumeRequest = {
          ctx,
          companyId,
          sessionId,
          ...(body.runId === undefined ? {} : { runId: body.runId }),
          ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }),
          ...(body.questionId === undefined ? {} : { questionId: body.questionId }),
          ...(body.restoreWorkspace === undefined ? {} : { restoreWorkspace: body.restoreWorkspace === true }),
        };
        const outcome = await deps.resume.resume(input);
        return reply.send(withApiVersion({
          status: outcome.status,
          // The prompt is the continuation context the caller issues the next step with. It is bounded and
          // scanned; the run id, the lease and the lost processes are the machine-readable part.
          resume: outcome,
        }));
      } catch (error) {
        deps.logger?.warn({ sessionId, code: resolveErrorCode(error) }, "code_session_resume_failed");
        return fail(reply, error);
      }
    },
  );

  /** Rewind: `code`, `conversation` or `both`, to a turn or to an explicitly named checkpoint. */
  instance.post<{ Params: SessionParams; Body: unknown }>(
    "/companies/:companyId/code/sessions/:sessionId/rewind",
    async (request, reply) => {
      const { companyId, sessionId } = request.params;
      try {
        const ctx = await authorizeAction(request, companyId, CODE_SESSION_DURABILITY_ACTIONS.rewind);
        const input: CodeSessionRewindRequest = { ctx, companyId, sessionId, body: request.body ?? {} };
        const outcome = await deps.rewind.rewind(input);
        return reply.send(withApiVersion({ status: outcome.status, rewind: outcome }));
      } catch (error) {
        deps.logger?.warn({ sessionId, code: resolveErrorCode(error) }, "code_session_rewind_failed");
        return fail(reply, error);
      }
    },
  );

  /** Fork: a new branch of the conversation from the same checkpoint. */
  instance.post<{ Params: SessionParams; Body: unknown }>(
    "/companies/:companyId/code/sessions/:sessionId/fork",
    async (request, reply) => {
      const { companyId, sessionId } = request.params;
      try {
        const ctx = await authorizeAction(request, companyId, CODE_SESSION_DURABILITY_ACTIONS.fork);
        const input: CodeSessionForkRequest = { ctx, companyId, sessionId, body: request.body ?? {} };
        const outcome = await deps.fork.fork(input);
        return reply.send(withApiVersion({ status: outcome.status, fork: outcome }));
      } catch (error) {
        deps.logger?.warn({ sessionId, code: resolveErrorCode(error) }, "code_session_fork_failed");
        return fail(reply, error);
      }
    },
  );

  /**
   * The recovery notice of a run — the answer the reconciler produced and, until C10, threw away.
   *
   * A run that exists but was never recovered answers `notice: null` with `notices: 0` and HTTP 200: "this run was
   * never interrupted" is a fact about a healthy run, not an error. A run that does not exist (or belongs to
   * another company) is a single 404 with no ids, the same rule the run-stream route follows.
   */
  instance.get<{ Params: RunParams }>(
    "/companies/:companyId/code/runs/:runId/recovery",
    async (request, reply) => {
      const { companyId, runId } = request.params;
      try {
        const _ctx = await authorizeAction(request, companyId, CODE_SESSION_DURABILITY_ACTIONS.recoveryRead);
        if (!(await deps.recovery.runExists(companyId, runId))) {
          throw new CodeSessionDurabilityError("run_not_found", "Run not found", 404, {});
        }
        const notice = await deps.recovery.loadNotice(companyId, runId);
        if (!notice) {
          return reply.send(withApiVersion({
            status: "none",
            runId,
            notice: null,
            notices: 0,
            reason: "no_recovery_notice_for_run",
            message: "This run has no recorded recovery notice: it was never reconciled, or it is recorded before C10.",
          }));
        }
        return reply.send(withApiVersion({
          status: "ok",
          runId,
          notice: toNoticeView(notice),
          notices: await deps.recovery.countNotices(companyId, runId),
        }));
      } catch (error) {
        deps.logger?.warn({ runId, code: resolveErrorCode(error) }, "code_run_recovery_read_failed");
        return fail(reply, error);
      }
    },
  );
}
