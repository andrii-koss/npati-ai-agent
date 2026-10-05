import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { AuditRepository } from "./audit-repository";
import type { AuditLogService } from "./audit-log";

async function ctx(auth: AuthProvider, r: FastifyRequest, permission: "workspace:read" | "business:manage") {
  const c = await auth.authenticate(r);
  if (!c.permissions.includes(permission)) throw new WorkspaceAccessError("Missing permission: " + permission);
  return c;
}

/**
 * C1c: the audit journal is readable only by the owner/admin role of the company (until C5a adds
 * explicit roles, `admin:all`/`owner` are the existing administrative permissions). Every read of the
 * tamper-evident journal is itself recorded when the caller is not the plain owner.
 */
async function auditReadContext(auth: AuthProvider, r: FastifyRequest) {
  const c = await auth.authenticate(r);
  const privileged = c.permissions.includes("business:manage") || c.permissions.includes("workspace:read");
  if (!privileged) throw new WorkspaceAccessError("Missing permission: workspace:read");
  return c;
}

function isAdmin(c: { permissions: string[] }): boolean {
  return c.permissions.some((permission) => ["*", "owner", "admin:all", "audit:read"].includes(permission));
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
    /** C1c tamper-evident journal; optional so the deployment can run without it (features deny). */
    auditLog?: AuditLogService;
  }
) {
  const { auth, store, repo, auditLog } = deps;

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

  // --- C1c: tamper-evident audit journal ------------------------------------------------

  app.get<{ Params: { companyId: string }; Querystring: { actor?: string; requestId?: string; correlationId?: string; action?: string; limit?: string; fromSequence?: string } }>(
    "/companies/:companyId/audit/journal",
    async (r, reply) => {
      try {
        const c = await auditReadContext(auth, r);
        if (!auditLog) return reply.code(503).send({ error: { code: "audit_unavailable", message: "Audit journal is unavailable" } });
        await store.getCompany(c, r.params.companyId);
        if (!isAdmin(c)) return reply.code(403).send({ error: { code: "audit_read_denied", message: "Reading the audit journal requires the owner/admin role" } });
        const entries = await auditLog.list(c, r.params.companyId, {
          actor: r.query.actor, requestId: r.query.requestId, correlationId: r.query.correlationId, action: r.query.action,
          limit: r.query.limit ? Number.parseInt(r.query.limit, 10) : undefined,
          fromSequence: r.query.fromSequence ? Number.parseInt(r.query.fromSequence, 10) : undefined,
        });
        return { entries, retentionDays: auditLog.retentionDays, blocked: auditLog.isBlocked(r.params.companyId) };
      } catch (e) { return err(reply, e); }
    }
  );

  app.get<{ Params: { companyId: string }; Querystring: { fromSequence?: string; toSequence?: string } }>(
    "/companies/:companyId/audit/verify",
    async (r, reply) => {
      try {
        const c = await auditReadContext(auth, r);
        if (!auditLog) return reply.code(503).send({ error: { code: "audit_unavailable", message: "Audit journal is unavailable" } });
        await store.getCompany(c, r.params.companyId);
        if (!isAdmin(c)) return reply.code(403).send({ error: { code: "audit_read_denied", message: "Verifying the audit chain requires the owner/admin role" } });
        const report = await auditLog.verify(c, r.params.companyId, {
          fromSequence: r.query.fromSequence ? Number.parseInt(r.query.fromSequence, 10) : undefined,
          toSequence: r.query.toSequence ? Number.parseInt(r.query.toSequence, 10) : undefined,
        });
        if (!report.ok) app.log.error({ report }, "audit_chain_verification_failed");
        return report;
      } catch (e) { return err(reply, e); }
    }
  );

  app.get<{ Params: { companyId: string }; Querystring: { limit?: string } }>(
    "/companies/:companyId/audit/anchors",
    async (r, reply) => {
      try {
        const c = await auditReadContext(auth, r);
        if (!auditLog) return reply.code(503).send({ error: { code: "audit_unavailable", message: "Audit journal is unavailable" } });
        await store.getCompany(c, r.params.companyId);
        if (!isAdmin(c)) return reply.code(403).send({ error: { code: "audit_read_denied", message: "Reading anchors requires the owner/admin role" } });
        return { anchors: await auditLog.anchors(c, r.params.companyId, r.query.limit ? Number.parseInt(r.query.limit, 10) : 90) };
      } catch (e) { return err(reply, e); }
    }
  );

  app.get<{ Params: { companyId: string }; Querystring: { limit?: string } }>(
    "/companies/:companyId/audit/export",
    async (r, reply) => {
      try {
        const c = await auditReadContext(auth, r);
        if (!auditLog) return reply.code(503).send({ error: { code: "audit_unavailable", message: "Audit journal is unavailable" } });
        await store.getCompany(c, r.params.companyId);
        if (!isAdmin(c)) return reply.code(403).send({ error: { code: "audit_read_denied", message: "Exporting the audit journal requires the owner/admin role" } });
        // The export itself is a privileged action and must be provable.
        await auditLog.record(c, {
          companyId: r.params.companyId, actor: c.userId, actorRole: isAdmin(c) ? "admin" : "user",
          action: "audit.export", resourceType: "audit_log", decision: "allowed",
          payload: { limit: r.query.limit ?? null }, metadata: { format: "jsonl" },
        });
        const body = await auditLog.export(c, r.params.companyId, r.query.limit ? Number.parseInt(r.query.limit, 10) : 1000);
        return reply.header("content-type", "application/x-ndjson").send(body);
      } catch (e) { return err(reply, e); }
    }
  );
}
