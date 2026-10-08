import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext, CodeDataErasureTarget } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import {
  CodeDataErasureError,
  CODE_DATA_ERASURE_CODES,
  type CodeDataErasureResult,
  type CodeDataErasureService,
} from "./code-data-erasure";

/**
 * R1-C (item 13) — the erasure surface.
 *
 * `DELETE /companies/:companyId/code/sessions/:sessionId/data` forgets a session;
 * `DELETE /companies/:companyId/code/projects/:projectId/data` forgets a whole code project. The two are one
 * route family on purpose: they differ by which id names the scope, not by what the operation means, and a
 * second implementation is how two erasure paths come to disagree about what "everything" is.
 *
 * The authorization reuses the existing vocabulary through a new **named action** (`code.session.data_erase`),
 * mapped to `business:manage` — the same administrative permission the existing `code.project.delete` carries,
 * because this is destructive in exactly that way. Naming the action is what stops a caller from authorizing an
 * erasure with a read label (`permission_action_mismatch`), and an action the gate does not know is refused
 * (`action_not_mapped`) rather than falling back to the caller's claim.
 *
 * The response is the service's measurement, unedited: `outstanding`, `preserved` and `verified` travel to the
 * caller so "nothing left" is something the answer states with evidence instead of something it asserts.
 */

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  session_not_found: 404,
  erasure_not_verified: 409,
  data_lifecycle_unavailable: 503,
  audit_unavailable: 503,
  code_data_erasure_request_failed: 500,
};

export const CODE_DATA_ERASURE_ACTION = "code.session.data_erase";

interface CompanyParams { companyId: string }
interface SessionParams extends CompanyParams { sessionId: string }
interface ProjectParams extends CompanyParams { projectId: string }

export interface CodeDataErasureRouteDeps {
  erasure: CodeDataErasureService;
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeDataErasureError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  return CODE_DATA_ERASURE_CODES.requestFailed;
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
  const message = code === CODE_DATA_ERASURE_CODES.requestFailed
    ? "Code data erasure failed"
    : String((error as { message?: unknown } | null)?.message ?? "Code data erasure failed");
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

/**
 * The refusal the irreversible action requires. It is the same explicit-boolean contract the project delete
 * route uses (`{ confirm: true }`), because a body-less DELETE that quietly destroys a workspace is the shape
 * of an accident.
 */
export function assertErasureConfirmed(body: unknown): void {
  const confirm = (body as { confirm?: unknown } | null)?.confirm;
  if (confirm !== true) {
    throw new CodeDataErasureError(
      CODE_DATA_ERASURE_CODES.invalidArguments,
      "Erasing code data requires { confirm: true }",
      400,
      { field: "confirm" },
    );
  }
}

/** The HTTP body. Counts and reasons only: no transcript, no path, no row content. */
export function toErasureResponse(result: CodeDataErasureResult) {
  return withApiVersion({
    status: result.status,
    scope: result.target.kind,
    removed: result.removed,
    /** Per-table counts, read back after the delete. `remaining` is the verification. */
    families: result.families,
    outstanding: result.outstanding,
    /**
     * Families erasure may not touch by design, with the reason (the append-only evidence). Named so a caller
     * can see that "complete" is scoped to the data that can be removed.
     */
    preserved: result.preserved,
    /** Why the workspace is in the state reported above — a deliberate scope answer is not a failure. */
    workspaceReason: result.workspaceReason,
    verified: result.verified,
    ...(result.failures.length ? { failures: result.failures } : {}),
  });
}

export async function registerCodeDataErasureRoutes(instance: FastifyInstance, deps: CodeDataErasureRouteDeps) {
  const contextOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    return context;
  };

  const authorizeErasure = async (request: unknown, companyId: string): Promise<AuthContext> => {
    const ctx = contextOrFail(request);
    // The gate derives the permission from the action and refuses a mismatched pair, so the only correct call
    // shape is to hand it the derived permission itself.
    await deps.authorize(ctx, companyId, {
      action: CODE_DATA_ERASURE_ACTION,
      permission: requiredPermissionForAction(CODE_DATA_ERASURE_ACTION) ?? "",
    });
    return ctx;
  };

  const erase = async (input: {
    request: unknown;
    reply: FastifyReply;
    companyId: string;
    body: unknown;
    target: CodeDataErasureTarget;
  }) => {
    try {
      const ctx = await authorizeErasure(input.request, input.companyId);
      assertErasureConfirmed(input.body);
      const result = await deps.erasure.erase({
        ctx,
        actor: String(ctx.userId ?? "unknown"),
        companyId: input.companyId,
        target: input.target,
      });
      if (!result.verified) {
        deps.logger?.warn({ target: input.target, outstanding: result.outstanding }, "code_data_erasure_not_verified");
      }
      return input.reply.code(result.verified ? 200 : 409).send(toErasureResponse(result));
    } catch (error) {
      return fail(input.reply, error);
    }
  };

  instance.delete<{ Params: SessionParams; Body: { confirm?: boolean } }>(
    "/companies/:companyId/code/sessions/:sessionId/data",
    async (request, reply) => {
      const { companyId, sessionId } = request.params;
      return erase({ request, reply, companyId, body: request.body, target: { kind: "session", sessionId } });
    },
  );

  instance.delete<{ Params: ProjectParams; Body: { confirm?: boolean } }>(
    "/companies/:companyId/code/projects/:projectId/data",
    async (request, reply) => {
      const { companyId, projectId } = request.params;
      return erase({ request, reply, companyId, body: request.body, target: { kind: "project", projectId } });
    },
  );
}
