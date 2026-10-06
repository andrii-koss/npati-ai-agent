import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { API_VERSION, resolveApiVersion } from "./api-versioning";
import type { NetworkActivityRecorder } from "./network-activity";
import { hasAdminPermission } from "./code-rbac";
import {
  resolveAllowlistForPhase, toProxyAllowedHosts, type EgressAllowlistConfig,
} from "./egress-allowlist";
import type { EgressEnforcement } from "./sandbox-egress-enforcement";

/**
 * C4b: read-only view of the sandbox network policy, plus an explicit re-probe for operators.
 *
 * The allowlist is operator configuration until C5a (`egress-allowlist.ts` holds the mutating
 * methods, which already require owner/admin and write to the AuditLog), so nothing here changes
 * policy except forcing the enforcement probe to run again — and that is audited.
 */

type CompanyParams = { companyId: string };

export interface NetworkRoutesDeps {
  auth: AuthProvider;
  store: WorkspaceStore;
  recorder?: NetworkActivityRecorder;
  enforcement?: EgressEnforcement;
  allowlist?: EgressAllowlistConfig;
  audit?: {
    record(context: unknown, input: {
      companyId: string; actor: string; actorRole: string; action: string; resourceType: string;
      decision: "allowed" | "denied" | "approved" | "rejected"; metadata?: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

function isAdmin(permissions: string[]): boolean {
  return hasAdminPermission(permissions);
}

export function registerNetworkRoutes(app: FastifyInstance, deps: NetworkRoutesDeps) {
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AuthenticationError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, apiVersion: API_VERSION } });
    }
    const status = error instanceof WorkspaceAccessError ? 403 : 500;
    return reply.code(status).send({
      error: { code: status === 403 ? "network_access_denied" : "network_error", message: error instanceof Error ? error.message : String(error), apiVersion: API_VERSION },
    });
  };

  const authorize = async (request: FastifyRequest, companyId: string) => {
    resolveApiVersion(request.headers);
    const context = await deps.auth.authenticate(request);
    await deps.store.getCompany(context, companyId);
    return context;
  };

  app.get<{ Params: CompanyParams; Querystring: { limit?: string } }>(
    "/companies/:companyId/network",
    async (request, reply) => {
      try {
        const { companyId } = request.params;
        const context = await authorize(request, companyId);
        const limit = request.query.limit ? Number.parseInt(request.query.limit, 10) : 100;
        return {
          apiVersion: API_VERSION,
          allowlist: {
            install: resolveAllowlistForPhase("install", deps.allowlist ?? { install: [], run: [] }),
            run: resolveAllowlistForPhase("run", deps.allowlist ?? { install: [], run: [] }),
            build: resolveAllowlistForPhase("build", deps.allowlist ?? { install: [], run: [] }),
          },
          proxyHosts: deps.allowlist ? toProxyAllowedHosts(deps.allowlist) : "",
          summary: deps.recorder ? deps.recorder.summary(companyId) : undefined,
          recent: deps.recorder ? deps.recorder.recentEvents(companyId, limit) : [],
          enforcement: deps.enforcement?.lastReport() ?? null,
          actor: context.userId,
        };
      } catch (error) { return fail(reply, error); }
    },
  );

  app.get<{ Params: CompanyParams }>(
    "/companies/:companyId/network/enforcement",
    async (request, reply) => {
      try {
        const { companyId } = request.params;
        await authorize(request, companyId);
        const report = deps.enforcement ? await deps.enforcement.verify() : undefined;
        return { apiVersion: API_VERSION, enforced: report?.enforced ?? false, reason: report?.reason ?? "probe_not_configured", details: report?.details ?? {}, checkedAt: report?.checkedAt ?? null, fromCache: report?.fromCache ?? false };
      } catch (error) { return fail(reply, error); }
    },
  );

  // Forcing a re-probe is an operator action: audited, owner/admin only, and it never changes policy.
  app.post<{ Params: CompanyParams }>(
    "/companies/:companyId/network/enforcement/probe",
    async (request, reply) => {
      try {
        const { companyId } = request.params;
        const context = await authorize(request, companyId);
        if (!isAdmin(context.permissions)) {
          return reply.code(403).send({ error: { code: "network_admin_required", message: "Forcing an egress probe requires the owner/admin role", apiVersion: API_VERSION } });
        }
        if (!deps.enforcement) {
          return reply.code(503).send({ error: { code: "network_enforcement_unavailable", message: "No egress enforcement probe is configured", retryable: true, apiVersion: API_VERSION } });
        }
        if (deps.audit) {
          await deps.audit.record(context, {
            companyId, actor: context.userId, actorRole: isAdmin(context.permissions) ? "admin" : "user",
            action: "egress_enforcement.probe", resourceType: "egress_enforcement", decision: "allowed", metadata: {},
          });
        }
        const report = await deps.enforcement.verify(true);
        if (!report.enforced) app.log.error({ report }, "egress_enforcement_probe_failed");
        return { apiVersion: API_VERSION, enforced: report.enforced, reason: report.reason ?? null, details: report.details, checkedAt: report.checkedAt, fromCache: report.fromCache };
      } catch (error) { return fail(reply, error); }
    },
  );
}
