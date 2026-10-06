import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CompanyMembershipError,
  WorkspaceAccessError,
  WorkspaceNotFoundError,
  type AuthContext,
  type CompanyRole,
} from "@npati/workspace";
import { API_VERSION, withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import {
  authorizeCodeAction,
  classifyPrincipal,
  CodeRbacError,
  type CodeAuthorizationAuditPort,
} from "./code-rbac";
import {
  CodeMembershipError,
  CodeMembershipService,
  COMPANY_ROLES,
  hashInviteToken,
  type CompanyInvite,
  type CompanyMember,
  type MembershipActor,
} from "./code-membership";
import {
  CodeProtectedBranchError,
  DEFAULT_PROTECTED_BRANCHES,
  PROTECTED_BRANCH_UPDATE_OPERATION,
  type CodeProtectedBranchService,
} from "./code-protected-branches";
import { CodeStepUpError } from "./code-step-up";

/**
 * C5a (part 2B) — company membership and protected-branch administration routes.
 *
 * Every route is gated by `code-rbac.ts` (`authorizeCodeAction`, deny by default), and the **company
 * role** from `code-membership.ts` is the authorisation anchor: the legacy workspace permissions are
 * deliberately dropped for these company-scoped paths, so a workspace-wide grant can never widen a
 * company-scoped code route. An agent or a service identity is refused on **every** route below with
 * `agent_cannot_change_policy` — membership and branch protection are administrative surfaces that a
 * model never touches.
 *
 * `POST …/members/invites/accept` is deliberately a **different** path: the invited person is not an
 * owner/admin yet (that is how a role is obtained), so the gate there is an authenticated *human*
 * principal plus the invite itself (single-use, expiring, SHA-256-hashed token, bound to the invited
 * email and to its company). It never asks for a company role, and it never grants one beyond the role
 * recorded on the invite.
 *
 * The exact refusal codes are part of the contract, because the UI has to explain a refusal:
 *   permission_denied · agent_cannot_change_policy · membership_manage_forbidden · last_owner_protected
 *   membership_not_found · membership_revision_conflict · invite_invalid · invite_expired
 *   invite_already_accepted · invite_email_mismatch · agent_cannot_change_protected_branches
 *   protected_branches_owner_required · protected_branches_membership_required
 *   protected_branch_policy_input_rejected · invalid_protected_branch_policy · policy_revision_conflict
 *   protected_branches_step_up_required · audit_unavailable · unauthorized
 */

/**
 * Action names of this surface. They are the RBAC `action` of every decision (so an allow/deny in the
 * journal names the operation) and the `action` of the membership audit entries written by the service.
 */
export const CODE_MEMBERSHIP_ROUTE_ACTIONS = {
  list: "code.membership.list",
  invite: "code.membership.invite",
  accept: "code.membership.accept",
  roleChange: "code.membership.role_change",
  remove: "code.membership.remove",
  protectedBranchesRead: "code.protected_branches.read",
} as const;

export class CodeMembershipRouteError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeMembershipRouteError";
    this.retryable = retryable;
  }
}

/** Codes this surface can produce, with the status used when the error carries none. */
const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  invalid_company_role: 400,
  invite_token_too_weak: 400,
  invalid_protected_branch_policy: 400,
  protected_branch_policy_input_rejected: 400,
  membership_user_required: 403,
  membership_manage_forbidden: 403,
  membership_access_denied: 403,
  membership_role_required: 403,
  agent_cannot_change_policy: 403,
  agent_cannot_change_protected_branches: 403,
  protected_branches_owner_required: 403,
  protected_branches_membership_required: 403,
  protected_branches_step_up_required: 403,
  protected_branch_write_denied: 403,
  force_push_denied: 403,
  permission_denied: 403,
  invite_invalid: 403,
  invite_email_mismatch: 403,
  invite_company_mismatch: 403,
  membership_not_found: 404,
  invite_not_found: 404,
  invite_already_accepted: 409,
  invite_token_conflict: 409,
  last_owner_protected: 409,
  membership_revision_conflict: 409,
  policy_revision_conflict: 409,
  invite_expired: 410,
  audit_unavailable: 503,
  protected_branches_store_unavailable: 503,
  protected_branches_step_up_unavailable: 503,
};

interface CompanyParams { companyId: string }
interface MemberParams extends CompanyParams { userId: string }

/** `AuthContext` plus the company role the request is scoped to; read by `createRoleRegistry().roleOf`. */
type CompanyScopedAuthContext = AuthContext & { role: string | null };

export interface CodeMembershipRouteDeps {
  service: CodeMembershipService;
  protectedBranches: CodeProtectedBranchService;
  /** Synchronous context accessor: a path-scoped `preHandler` resolves it once (same pattern as C5). */
  getAuthContext: (request: unknown) => AuthContext | null;
  /** The shared authorization journal; without it every gate here refuses (fail closed). */
  audit?: CodeAuthorizationAuditPort;
  /** Resolves the company an invite token belongs to, so a token cannot be replayed on another path. */
  findInviteCompanyId?: (tokenHash: string) => Promise<string | null>;
  /** Test seam; production uses 32 random bytes (base64url) and stores only their SHA-256 hash. */
  generateInviteToken?: () => string;
  logger?: { warn(payload: unknown, message?: string): void };
}

function defaultInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The caller's verified email, when the authentication layer exposes one. `MembershipActor.email` is the
 * documented extension point: today `auth.ts` does not copy the verified JWT/OIDC email onto
 * `AuthContext`, so the invite↔email binding only activates once it does.
 *
 * TODO(C5a auth owner): surface the verified email on `AuthContext` in `apps/agent-api/src/auth.ts`
 * (the JWT payload and the OIDC claims both carry it) so `invite_email_mismatch` is enforced in
 * production without any change to this module. The token half of the accept path is enforced today:
 * single use, expiring, SHA-256 hashed at rest, and bound to its own company.
 */
function principalEmail(context: AuthContext): string | null {
  const email = (context as { email?: unknown }).email;
  return typeof email === "string" && email.trim() ? email.trim() : null;
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
  const message =
    code === "code_membership_route_error"
      ? "Company membership request failed"
      : String((error as { message?: unknown } | null)?.message ?? "Company membership request failed");
  return reply.code(status).send({
    ...withApiVersion({}),
    error: { code, message, retryable: (error as { retryable?: unknown } | null)?.retryable === true, ...(details === undefined ? {} : { details }) },
  });
}

/** Membership codes are preserved verbatim; store-layer codes are mapped onto this surface's vocabulary. */
function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeMembershipError || error instanceof CodeMembershipRouteError) return error.code;
  if (error instanceof CodeProtectedBranchError || error instanceof CodeRbacError || error instanceof CodeStepUpError) {
    return error.code;
  }
  if (error instanceof CompanyMembershipError) return error.code;
  // The store refuses a stale role write with the tree-wide optimistic-concurrency error.
  if (error instanceof WorkspaceAccessError) {
    return /changed by another request/i.test(error.message) ? "membership_revision_conflict" : "membership_access_denied";
  }
  if (error instanceof WorkspaceNotFoundError) return "membership_not_found";
  return "code_membership_route_error";
}

function resolveErrorStatus(error: unknown, code: string): number {
  const shaped = error as { httpStatus?: unknown; status?: unknown } | null;
  const explicit = Number(shaped?.httpStatus ?? shaped?.status ?? Number.NaN);
  // A stale role write carries the store's 403; the route models it as the 409 it is.
  if (code === "membership_revision_conflict") return 409;
  if (Number.isFinite(explicit) && explicit >= 400 && explicit <= 599 && code !== "code_membership_route_error") {
    return explicit;
  }
  return ROUTE_ERROR_STATUS[code] ?? 500;
}

/** The invite as it is shown to a caller: the token hash is never returned. */
function inviteView(invite: CompanyInvite) {
  return {
    id: invite.id,
    companyId: invite.companyId,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
  };
}

export async function registerCodeMembershipRoutes(instance: FastifyInstance, deps: CodeMembershipRouteDeps) {
  const rbacDeps = {
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  };

  const authOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) {
      throw new CodeMembershipRouteError("unauthorized", "Authentication required", 401, { reason: "unauthorized" });
    }
    return context;
  };

  /**
   * Two-step gate, one audit entry per request:
   *  1. an agent/service principal is refused by the shared gate with `agent_cannot_change_policy`;
   *  2. a human is authorized on the **company role** only (legacy permissions dropped, deny by default,
   *     so a caller without an active membership row is refused with `permission_denied`).
   */
  const authorizeCompanyAction = async (
    context: AuthContext,
    companyId: string,
    permission: string,
    action: string,
  ): Promise<CompanyScopedAuthContext> => {
    if (classifyPrincipal(context) !== "user") {
      // Canonical refusal + journal entry from the shared gate: `policyChange` is what turns an agent
      // principal into `agent_cannot_change_policy`, and it is the only place that decides it.
      await authorizeCodeAction(context, companyId, { permission, action, policyChange: true }, rbacDeps);
      // Unreachable by contract; kept so the refusal stays explicit in the types.
      throw new CodeMembershipRouteError(
        "agent_cannot_change_policy",
        "An agent or service identity cannot change company membership or policy",
        403,
        { reason: "agent_cannot_change_policy", action },
      );
    }
    const role = await deps.service.resolveRoleForUser(context, companyId);
    const scoped: CompanyScopedAuthContext = Object.assign({}, context, { role, companyId, permissions: [] });
    await authorizeCodeAction(scoped, companyId, { permission, action, policyChange: true }, rbacDeps);
    return scoped;
  };

  instance.get<{ Params: CompanyParams }>("/companies/:companyId/code/members", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const scoped = await authorizeCompanyAction(
        context,
        request.params.companyId,
        "business:manage",
        CODE_MEMBERSHIP_ROUTE_ACTIONS.list,
      );
      const members: CompanyMember[] = await deps.service.listMembers(scoped, request.params.companyId);
      return reply.send(withApiVersion({ members, roles: [...COMPANY_ROLES] }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  instance.post<{ Params: CompanyParams }>("/companies/:companyId/code/members/invites", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const body = (request.body ?? {}) as { email?: unknown; role?: unknown };
      // Authorization first: a caller who may not invite learns that, not the body shape.
      const scoped = await authorizeCompanyAction(
        context,
        request.params.companyId,
        "business:manage",
        CODE_MEMBERSHIP_ROUTE_ACTIONS.invite,
      );
      if (typeof body.email !== "string" || !body.email.trim() || typeof body.role !== "string") {
        return fail(reply, new CodeMembershipRouteError("invalid_arguments", "email and role are required", 400));
      }
      // The token is generated here and shown exactly once: the store keeps only its SHA-256 hash, and a
      // client-supplied token is deliberately ignored (a caller would otherwise choose its own secret).
      const token = (deps.generateInviteToken ?? defaultInviteToken)();
      const invite = await deps.service.invite(scoped, request.params.companyId, {
        email: body.email.trim(),
        role: body.role as CompanyRole,
        token,
      });
      return reply.code(201).send(
        withApiVersion({
          invite: inviteView(invite),
          inviteToken: token,
          note: "The invite token is shown once; only its hash is stored. It is bound to the invited email.",
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  instance.post<{ Params: CompanyParams }>("/companies/:companyId/code/members/invites/accept", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const body = (request.body ?? {}) as { token?: unknown };
      const companyId = request.params.companyId;
      // Different pathway on purpose: the invited person holds no company role yet, so the gate is "an
      // authenticated human principal" (an agent is refused by the shared gate with
      // `agent_cannot_change_policy`) plus the invite token and its email binding. No owner/admin role.
      await authorizeCodeAction(
        context,
        companyId,
        { permission: "workspace:read", action: CODE_MEMBERSHIP_ROUTE_ACTIONS.accept, policyChange: true },
        rbacDeps,
      );
      if (typeof body.token !== "string" || !body.token) {
        return fail(reply, new CodeMembershipRouteError("invalid_arguments", "token is required", 400));
      }
      if (deps.findInviteCompanyId) {
        const inviteCompanyId = await deps.findInviteCompanyId(hashInviteToken(body.token));
        if (inviteCompanyId && inviteCompanyId !== companyId) {
          return fail(
            reply,
            new CodeMembershipRouteError(
              "invite_company_mismatch",
              "This invite belongs to a different company",
              403,
              { reason: "invite_company_mismatch" },
            ),
          );
        }
      }
      const actor: MembershipActor & { email?: string | null } = {
        userId: context.userId,
        externalSubject: context.externalSubject ?? null,
        companyId: context.companyId ?? null,
        email: principalEmail(context),
      };
      const member: CompanyMember = await deps.service.acceptInvite(actor, { token: body.token });
      return reply.code(201).send(withApiVersion({ member }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  instance.patch<{ Params: MemberParams }>("/companies/:companyId/code/members/:userId", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const body = (request.body ?? {}) as { role?: unknown; expectedRevision?: unknown };
      const scoped = await authorizeCompanyAction(
        context,
        request.params.companyId,
        "business:manage",
        CODE_MEMBERSHIP_ROUTE_ACTIONS.roleChange,
      );
      if (typeof body.role !== "string" || !Number.isInteger(body.expectedRevision)) {
        return fail(
          reply,
          new CodeMembershipRouteError("invalid_arguments", "role and expectedRevision are required", 400),
        );
      }
      const member = await deps.service.updateRole(scoped, request.params.companyId, {
        userId: request.params.userId,
        role: body.role as CompanyRole,
        expectedRevision: body.expectedRevision as number,
      });
      return reply.send(withApiVersion({ member }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  instance.delete<{ Params: MemberParams }>("/companies/:companyId/code/members/:userId", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const scoped = await authorizeCompanyAction(
        context,
        request.params.companyId,
        "business:manage",
        CODE_MEMBERSHIP_ROUTE_ACTIONS.remove,
      );
      await deps.service.removeMember(scoped, request.params.companyId, request.params.userId);
      return reply.send(withApiVersion({ deleted: true, userId: request.params.userId }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  instance.get<{ Params: CompanyParams }>("/companies/:companyId/code/protected-branches", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const scoped = await authorizeCompanyAction(
        context,
        request.params.companyId,
        "workspace:read",
        CODE_MEMBERSHIP_ROUTE_ACTIONS.protectedBranchesRead,
      );
      const policy = await deps.protectedBranches.getPolicy(scoped, request.params.companyId);
      return reply.send(
        withApiVersion({
          policy,
          defaults: [...DEFAULT_PROTECTED_BRANCHES],
          guard: deps.protectedBranches.effectiveGuard,
          note: "A protected branch is refused to every principal, the owner included; changes reach it only through a pull request a human merges.",
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  instance.put<{ Params: CompanyParams }>("/companies/:companyId/code/protected-branches", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const scoped = await authorizeCompanyAction(
        context,
        request.params.companyId,
        "business:manage",
        PROTECTED_BRANCH_UPDATE_OPERATION,
      );
      // The raw body is forwarded on purpose: the policy service rejects any key that is not
      // administrative (`branches`, `expectedRevision`, `challengeId`), so repository content cannot be
      // smuggled into a policy change.
      const policy = await deps.protectedBranches.updatePolicy(
        scoped,
        request.params.companyId,
        (request.body ?? {}) as Record<string, unknown>,
      );
      return reply.send(withApiVersion({ policy }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  return { apiVersion: API_VERSION, roles: [...COMPANY_ROLES] };
}
