import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type AuthContext, type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { CompanyApproval, CompanyApprovalsRepository, ApprovalStatus } from "./approvals-repository";
import type { AuditLogService } from "./audit-log";

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
    /** C1c: when present, approval decisions are recorded in the tamper-evident journal. */
    auditLog?: AuditLogService;
    /**
     * C13 (owner blocker 1): what a decision **releases**. A run that paused on a runtime MCP approval is held in
     * the existing `waiting_for_user` state, and the human decision is what ends that pause — the same role
     * `CodeAskUserService.answer` plays for a question (`resumeAfterAnswer`). The port is called after the
     * decision is applied, and its failure is reported rather than allowed to undo a decision that already
     * happened: the approval row stays decided and the paused run stays visible, so the release can be retried.
     */
    onDecided?: (input: {
      ctx: AuthContext;
      companyId: string;
      approval: CompanyApproval;
      decision: "approved" | "rejected";
    }) => Promise<void> | void;
    logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  }
) {
  const { auth, store, repo, auditLog } = deps;

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
        // C1c: an approval decision is a privileged, provable action. The journal records it (with the
        // hash of the exact payload the approver saw) before the decision is applied, so an audit
        // outage refuses the decision instead of losing it (fail closed).
        const approval = await repo.get(c, r.params.companyId, r.params.approvalId);
        if (auditLog) {
          await auditLog.record(c, {
            companyId: r.params.companyId,
            actor: c.userId,
            actorRole: "approver",
            action: "approval.decide",
            resourceType: "approval",
            resourceId: r.params.approvalId,
            correlationId: approval.runId ?? undefined,
            decision: r.body.decision === "approved" ? "approved" : "rejected",
            payload: approval.inputPayload ?? { approvalId: r.params.approvalId },
            metadata: {
              toolName: approval.toolName, riskLevel: approval.riskLevel, agentId: approval.agentId ?? null,
              payloadHash: approval.payloadHash ?? null, notes: r.body.notes ? "[PROVIDED]" : null,
            },
          });
        }
        const resolved = await repo.decide(
          c,
          r.params.companyId,
          r.params.approvalId,
          r.body.decision,
          r.body.notes
        );
        /**
         * C13 (owner blocker 1): the decision may be the answer a paused run is waiting for. It is released
         * **after** the decision is durable (never before: a released run whose approval was not recorded would be
         * a run nobody can continue), and a failure to release is logged instead of failing a decision the human
         * already made.
         */
        if (deps.onDecided) {
          try {
            await deps.onDecided({
              ctx: c,
              companyId: r.params.companyId,
              approval: resolved,
              decision: r.body.decision,
            });
          } catch (error) {
            deps.logger?.warn("approval_release_failed", {
              approvalId: r.params.approvalId,
              companyId: r.params.companyId,
              code: (error as { code?: string }).code ?? "approval_release_failed",
            });
          }
        }
        return reply.send(resolved);
      } catch (e) {
        return err(reply, e);
      }
    }
  );
}
