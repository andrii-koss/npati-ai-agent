import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { AuditRepository } from "./audit-repository";

async function ctx(auth: AuthProvider, r: FastifyRequest, permission: "workspace:read" | "business:manage") {
  const c = await auth.authenticate(r);
  if (!c.permissions.includes(permission)) throw new WorkspaceAccessError("Missing permission: " + permission);
  return c;
}

function err(reply: any, e: unknown) {
  const status = Number((e as any)?.status ?? (e instanceof WorkspaceAccessError ? 403 : 400));
  return reply.code(status).send({
    error: {
      code: status === 404 ? "NOT_FOUND" : "AUDIT_ERROR",
      message: e instanceof Error ? e.message : String(e),
    },
  });
}

export function registerAuditRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthProvider;
    store: WorkspaceStore;
    repo: AuditRepository;
  }
) {
  const { auth, store, repo } = deps;

  // --- Audit Trail (Item 109 / Row 67) ---
  app.get<{ Params: { companyId: string }; Querystring: { limit?: string } }>(
    "/companies/:companyId/audit",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        await store.getCompany(c, r.params.companyId);
        const limit = r.query.limit ? parseInt(r.query.limit, 10) : 50;
        const logs = await repo.listAuditLogs(c, r.params.companyId, limit);
        return { logs };
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // --- Usage Analytics & Quota Tracking (Items 102, 103 / Rows 65, 66) ---
  app.get<{ Params: { companyId: string } }>(
    "/companies/:companyId/analytics/usage",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        await store.getCompany(c, r.params.companyId);
        const analytics = await repo.getUsageAnalytics(c, r.params.companyId);
        return { analytics };
      } catch (e) {
        return err(reply, e);
      }
    }
  );
}
