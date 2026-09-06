import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { CompanyApprovalsRepository, ApprovalStatus } from "./approvals-repository";

async function ctx(auth: AuthProvider, r: FastifyRequest, permission: "workspace:read" | "business:manage") {
  const c = await auth.authenticate(r);
  if (!c.permissions.includes(permission)) throw new WorkspaceAccessError("Missing permission: " + permission);
  return c;
}

function err(reply: any, e: unknown) {
  const status = Number((e as any)?.status ?? (e instanceof WorkspaceAccessError ? 403 : 400));
  return reply.code(status).send({
    error: {
      code: status === 404 ? "NOT_FOUND" : "APPROVAL_ERROR",
      message: e instanceof Error ? e.message : String(e),
    },
  });
}

export function registerCompanyApprovalsRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthProvider;
    store: WorkspaceStore;
    repo: CompanyApprovalsRepository;
  }
) {
  const { auth, store, repo } = deps;

  // List approvals for a company
  app.get<{
    Params: { companyId: string };
    Querystring: { status?: string };
  }>("/companies/:companyId/approvals", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const approvals = await repo.list(c, r.params.companyId, r.query.status as ApprovalStatus);
      return { approvals };
    } catch (e) {
      return err(reply, e);
    }
  });

  // Get specific approval
  app.get<{ Params: { companyId: string; approvalId: string } }>(
    "/companies/:companyId/approvals/:approvalId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        const approval = await repo.get(c, r.params.companyId, r.params.approvalId);
        return { approval };
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Submit human approval decision (approve or reject)
  app.post<{
    Params: { companyId: string; approvalId: string };
    Body: { decision: "approved" | "rejected"; notes?: string };
  }>(
    "/companies/:companyId/approvals/:approvalId/decide",
    {
      schema: {
        body: {
          type: "object",
          required: ["decision"],
          properties: {
            decision: { type: "string", enum: ["approved", "rejected"] },
            notes: { type: "string", maxLength: 2000 },
          },
        },
      },
    },
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await store.getCompany(c, r.params.companyId);
        const resolved = await repo.decide(
          c,
          r.params.companyId,
          r.params.approvalId,
          r.body.decision,
          r.body.notes
        );
        return reply.send(resolved);
      } catch (e) {
        return err(reply, e);
      }
    }
  );
}
