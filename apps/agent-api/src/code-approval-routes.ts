import { hasAdminPermission } from "./code-rbac";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  WorkspaceAccessError,
  type AuthContext,
  type CodeApprovalRule,
  type CodeApprovalRuleScope,
  type WorkspaceStore,
} from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { API_VERSION, withApiVersion } from "./api-versioning";
import {
  ApprovalScopeError,
  APPROVAL_SCOPES,
  CodeApprovalScopeService,
  isApprovalRuleAdmin,
  MAX_APPROVAL_TIMEOUT_MS,
  resolveApprovalTimeoutMs,
} from "./code-approval-scope";

/**
 * C5: scoped approval rules API.
 *
 * A standing rule widens what the agent may do without asking again, so the rules are deliberately
 * *visible* (a reviewer must be able to see every allowance that exists) and *revocable* immediately.
 * Reads need `workspace:read`; every mutation needs the administrative role **and** an audit entry
 * written before the change is applied — if the journal is unavailable the change does not happen.
 *
 * `once` is not represented here: a one-shot approval is bound to a single payload hash in the existing
 * approvals repository and must never be promoted into a standing allowance by accident.
 */
export interface CodeApprovalRuleStore extends Pick<WorkspaceStore,
  "createCodeApprovalRule" | "listCodeApprovalRules" | "deleteCodeApprovalRule" | "findMatchingCodeApprovalRule" | "getCompany"> {}

const RULE_ERROR_STATUS: Record<string, number> = {
  invalid_approval_scope: 400,
  invalid_approval_action: 400,
  approval_rule_scope_missing: 400,
  approval_rule_not_found: 404,
  hard_deny_not_approvable: 403,
  project_scope_not_permitted: 403,
  project_scope_privileged_action: 403,
  scoped_rule_not_permitted: 403,
  scoped_rule_privileged_action: 403,
  approval_rule_admin_required: 403,
  approval_denied: 403,
  audit_unavailable: 503,
  approval_timeout: 504,
  approval_rule_error: 500,
};

interface CompanyParams { companyId: string }
interface RuleParams extends CompanyParams { ruleId: string }
interface RuleQuery { projectId?: string; sessionId?: string; scope?: string }

function ruleError(reply: FastifyReply, code: string, message: string, retryable = false, details?: unknown) {
  return reply.code(RULE_ERROR_STATUS[code] ?? 400).send({
    ...withApiVersion({}),
    error: { code, message, retryable, ...(details === undefined ? {} : { details }) },
  });
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) {
    return reply.code(error.status ?? 401).send({
      ...withApiVersion({}),
      error: { code: error.code, message: error.message, retryable: false },
    });
  }
  if (error instanceof ApprovalScopeError) {
    return ruleError(reply, error.code, error.message, error.retryable, error.details);
  }
  if (error instanceof WorkspaceAccessError) {
    return ruleError(reply, "approval_rule_admin_required", error.message);
  }
  const shaped = error as { code?: unknown; status?: unknown; retryable?: unknown; details?: unknown; message?: unknown };
  if (typeof shaped?.code === "string" && shaped.code in RULE_ERROR_STATUS) {
    return ruleError(reply, shaped.code, String(shaped.message ?? "Approval rule request failed"),
      shaped.retryable === true, shaped.details);
  }
  // Unexpected failures never leak an internal message or a stack trace.
  return ruleError(reply, "approval_rule_error", "Approval rule request failed");
}

export function registerCodeApprovalRoutes(
  app: FastifyInstance,
  auth: AuthProvider,
  deps: { store?: CodeApprovalRuleStore; scope?: CodeApprovalScopeService },
) {
  const service = deps.scope;

  const authorize = async (request: FastifyRequest, permission: "workspace:read" | "business:manage") => {
    const ctx = await auth.authenticate(request);
    if (!ctx.permissions.includes(permission) && !hasAdminPermission(ctx.permissions)) {
      throw new WorkspaceAccessError("Missing permission: " + permission);
    }
    if (!service || !deps.store) {
      throw Object.assign(new Error("Approval rules are not configured"), { code: "audit_unavailable", status: 503, retryable: true });
    }
    return ctx;
  };

  /** Authorization first (explicit administrative role), then any lookup, mirroring the flag routes. */
  const authorizeAdmin = async (request: FastifyRequest) => {
    const ctx = await authorize(request, "business:manage");
    if (!isApprovalRuleAdmin(ctx)) {
      throw Object.assign(new Error("Managing approval rules requires the owner/admin role"), { code: "approval_rule_admin_required", status: 403 });
    }
    return ctx;
  };

  /** Company ownership before any listing: the path company is never trusted on its own. */
  const assertOwnership = async (ctx: AuthContext, companyId: string) => {
    if (!deps.store?.getCompany) return;
    try {
      await deps.store.getCompany(ctx, companyId);
    } catch {
      throw Object.assign(new Error("Company is not available to this caller"), { code: "approval_rule_not_found", status: 403 });
    }
  };

  app.get<{ Params: CompanyParams; Querystring: RuleQuery }>("/companies/:companyId/code/approval-rules", async (request, reply) => {
    try {
      const ctx = await authorize(request, "workspace:read");
      await assertOwnership(ctx, request.params.companyId);
      const scopeFilter = request.query?.scope;
      if (scopeFilter !== undefined && scopeFilter !== "session" && scopeFilter !== "project") {
        return ruleError(reply, "invalid_approval_scope", "scope must be 'session' or 'project'");
      }
      const rules = await service!.listRules(ctx, request.params.companyId, {
        projectId: request.query?.projectId,
        sessionId: request.query?.sessionId,
        scope: scopeFilter as CodeApprovalRuleScope | undefined,
      });
      return reply.send(withApiVersion({
        rules,
        scopes: APPROVAL_SCOPES,
        approvalTimeoutMs: resolveApprovalTimeoutMs(process.env),
        maxApprovalTimeoutMs: MAX_APPROVAL_TIMEOUT_MS,
        note: "A rule widens an approval inside its scope; it can never override a hard deny or the network gate.",
      }));
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: CompanyParams; Body: { scope?: string; action?: string; projectId?: string; sessionId?: string; reason?: string; expiresAt?: string; command?: string } }>(
    "/companies/:companyId/code/approval-rules",
    async (request, reply) => {
      try {
        const ctx = await authorizeAdmin(request);
        await assertOwnership(ctx, request.params.companyId);
        const body = request.body ?? {};
        if (body.expiresAt !== undefined && (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt)))) {
          return ruleError(reply, "invalid_approval_scope", "expiresAt must be an ISO timestamp");
        }
        const rule: CodeApprovalRule = await service!.grantRule({
          ctx, companyId: request.params.companyId,
          scope: body.scope === "project" ? "project" : "session",
          action: String(body.action ?? ""),
          projectId: body.projectId ?? null,
          sessionId: body.sessionId ?? null,
          reason: body.reason ?? null,
          expiresAt: body.expiresAt ?? null,
          // A shell allowance must name the command shape it covers: the service refuses `project` scope
          // for a shell action without a command, and stores the shaped action (`…:npm:test`).
          command: body.command ?? null,
        });
        return reply.code(201).send(withApiVersion({ rule }));
      } catch (error) { return fail(reply, error); }
    },
  );

  app.delete<{ Params: RuleParams }>("/companies/:companyId/code/approval-rules/:ruleId", async (request, reply) => {
    try {
      const ctx = await authorizeAdmin(request);
      await assertOwnership(ctx, request.params.companyId);
      await service!.revokeRule({ ctx, companyId: request.params.companyId, ruleId: request.params.ruleId });
      return reply.send(withApiVersion({ deleted: true, ruleId: request.params.ruleId }));
    } catch (error) { return fail(reply, error); }
  });

  return {
    apiVersion: API_VERSION,
    scopes: APPROVAL_SCOPES,
    maxApprovalTimeoutMs: MAX_APPROVAL_TIMEOUT_MS,
  };
}
