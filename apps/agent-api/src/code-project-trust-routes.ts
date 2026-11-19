import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext, ProjectCodeTrust } from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import { CodeTrustError } from "./code-project-trust";

/**
 * C8 — the trust surface.
 *
 * This module exists because trust was, until now, **unreachable**: `CodeProjectTrustService.trust()` and
 * `.revoke()` were implemented (owner/admin check, audit-before-write, revision check, fail closed) and the RBAC
 * actions `code.project.trust` / `code.project.untrust` were already mapped, but nothing in the server ever
 * called them and no route exposed them. A trust-gated feature with no way to grant trust is not "dark by
 * default" — it is a dead path, and every "after the user trusts the project" behaviour would have been
 * unreachable in production while looking implemented in the source.
 *
 * The route adds transport only. It does not re-implement the decision: the service still performs the
 * owner/admin check and still writes the audit entry *before* the store write, so an unavailable journal fails
 * the action closed. The route's own `authorize` call uses the actions that were already mapped, keeping the
 * permission derived from the action rather than from a caller-supplied label.
 *
 * `expectedRevision` is required on both mutations. Trust that silently survives a content change is exactly the
 * failure mode this field prevents: the caller states which revision it inspected, and the store refuses if the
 * project moved on. For the same reason the route never caches a trust answer.
 */

export class CodeProjectTrustRouteError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeProjectTrustRouteError";
    this.retryable = retryable;
  }
}

export const CODE_PROJECT_TRUST_ACTIONS = Object.freeze({
  read: "code.project.trust" as const,
  grant: "code.project.trust" as const,
  revoke: "code.project.untrust" as const,
});

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  agent_cannot_change_policy: 403,
  code_trust_admin_required: 403,
  project_not_found: 404,
  code_trust_revision_mismatch: 409,
  audit_unavailable: 503,
  code_project_trust_request_failed: 500,
};

interface ProjectParams { companyId: string; projectId: string }

export interface CodeProjectTrustRouteDeps {
  trust: {
    get(ctx: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null>;
    trust(ctx: AuthContext, companyId: string, projectId: string, input: { expectedRevision: number; reason?: string }): Promise<ProjectCodeTrust>;
    revoke(ctx: AuthContext, companyId: string, projectId: string, input: { expectedRevision: number; reason?: string }): Promise<ProjectCodeTrust>;
  };
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeProjectTrustRouteError) return error.code;
  if (error instanceof CodeTrustError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  if (error instanceof WorkspaceAccessError) return "permission_denied";
  if (error instanceof WorkspaceNotFoundError) return "project_not_found";
  return "code_project_trust_request_failed";
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
  const message = code === "code_project_trust_request_failed"
    ? "Code project trust request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Code project trust request failed");
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

/** Read the revision a caller must echo. An absent record is "not trusted at revision 0", never "trusted". */
function revisionOf(record: ProjectCodeTrust | null): number {
  const revision = Number((record as { revision?: unknown } | null)?.revision ?? 0);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

export function presentProjectTrust(record: ProjectCodeTrust | null) {
  return {
    trusted: record?.trusted === true,
    revision: revisionOf(record),
    ...(record?.trustedBy === undefined ? {} : { trustedBy: record.trustedBy }),
    ...(record?.trustedAt === undefined ? {} : { trustedAt: record.trustedAt }),
  };
}

export async function registerCodeProjectTrustRoutes(
  instance: FastifyInstance,
  deps: CodeProjectTrustRouteDeps,
) {
  const authorizeAction = async (request: unknown, companyId: string, action: string): Promise<AuthContext> => {
    const ctx = deps.getAuthContext(request);
    if (!ctx) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });
    return ctx;
  };

  instance.get(
    "/companies/:companyId/projects/:projectId/code/trust",
    async (request, reply) => {
      const { companyId, projectId } = request.params as ProjectParams;
      try {
        const ctx = await authorizeAction(request, companyId, CODE_PROJECT_TRUST_ACTIONS.read);
        // Never cached: trust is read fresh on every request so a revoked or revision-bumped decision cannot
        // survive in a client that asked once.
        const record = await deps.trust.get(ctx, companyId, projectId);
        return reply.code(200).send({
          ...withApiVersion({}),
          status: "ok",
          trust: presentProjectTrust(record),
        });
      } catch (error) {
        deps.logger?.warn({ projectId, code: resolveErrorCode(error) }, "code_project_trust_read_failed");
        return fail(reply, error);
      }
    },
  );

  const mutate = (action: string, verb: "grant" | "revoke") =>
    async (request: unknown, reply: FastifyReply) => {
      const params = (request as { params?: unknown }).params as ProjectParams;
      const { companyId, projectId } = params;
      try {
        const ctx = await authorizeAction(request, companyId, action);
        const body = ((request as { body?: unknown }).body ?? {}) as { expectedRevision?: unknown; reason?: unknown };
        const expectedRevision = Number(body.expectedRevision);
        if (!Number.isFinite(expectedRevision) || expectedRevision < 0) {
          throw new CodeProjectTrustRouteError(
            "invalid_arguments",
            "expectedRevision is required so trust cannot silently survive a content change",
            400,
          );
        }
        const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
        const input = { expectedRevision, ...(reason === undefined ? {} : { reason }) };
        const record = verb === "grant"
          ? await deps.trust.trust(ctx, companyId, projectId, input)
          : await deps.trust.revoke(ctx, companyId, projectId, input);
        return reply.code(200).send({
          ...withApiVersion({}),
          status: "ok",
          trust: presentProjectTrust(record),
        });
      } catch (error) {
        deps.logger?.warn({ projectId, code: resolveErrorCode(error) }, "code_project_trust_mutation_failed");
        return fail(reply, error);
      }
    };

  instance.post("/companies/:companyId/projects/:projectId/code/trust", mutate(CODE_PROJECT_TRUST_ACTIONS.grant, "grant"));
  instance.post(
    "/companies/:companyId/projects/:projectId/code/trust/revoke",
    mutate(CODE_PROJECT_TRUST_ACTIONS.revoke, "revoke"),
  );
}
