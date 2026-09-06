import { describe, expect, it, vi } from "vitest";
import { CompanyApprovalsRepository, type CompanyApproval } from "../apps/agent-api/src/approvals-repository";
import type { AuthContext } from "@npati/workspace";

describe("Human Approvals & Security Guardrails (OpenClaw Item 256 / P1)", () => {
  const ctx: AuthContext = {
    workspaceId: "ws-test",
    userId: "user-test",
    permissions: ["workspace:read", "business:manage"],
    role: "owner",
  };

  it("creates and persists pending approval requests for high-risk agent operations", async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "app-123",
          workspaceId: ctx.workspaceId,
          companyId: "comp-1",
          userId: ctx.userId,
          runId: "run-456",
          agentId: "agent-specialist",
          toolName: "web.crawl",
          riskLevel: "high",
          actionSummary: "Execute deep recursive crawl on external competitor portal",
          inputPayload: { url: "https://example.com", maxDepth: 2 },
          status: "pending",
          requestedAt: new Date().toISOString(),
        },
      ],
    });

    const repo = new CompanyApprovalsRepository("postgres://fake:fake@localhost/db");
    (repo as any).pool = { query: mockQuery };

    const approval = await repo.requestApproval(ctx, "comp-1", {
      runId: "run-456",
      agentId: "agent-specialist",
      toolName: "web.crawl",
      riskLevel: "high",
      actionSummary: "Execute deep recursive crawl on external competitor portal",
      inputPayload: { url: "https://example.com", maxDepth: 2 },
    });

    expect(approval.id).toBe("app-123");
    expect(approval.status).toBe("pending");
    expect(approval.riskLevel).toBe("high");
    expect(mockQuery).toHaveBeenCalled();
  });

  it("records human approval decisions with timestamps and notes", async () => {
    const pendingApproval: CompanyApproval = {
      id: "app-123",
      workspaceId: ctx.workspaceId,
      companyId: "comp-1",
      userId: ctx.userId,
      toolName: "external.email_send",
      riskLevel: "critical",
      actionSummary: "Send bulk outreach email to 500 recipients",
      inputPayload: { count: 500 },
      status: "pending",
      requestedAt: new Date().toISOString(),
    };

    const approvedApproval: CompanyApproval = {
      ...pendingApproval,
      status: "approved",
      decisionNotes: "Authorized by admin after template review",
      respondedAt: new Date().toISOString(),
      respondedBy: ctx.userId,
    };

    const mockQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [pendingApproval] }) // get()
      .mockResolvedValueOnce({ rows: [approvedApproval] }); // update

    const repo = new CompanyApprovalsRepository("postgres://fake:fake@localhost/db");
    (repo as any).pool = { query: mockQuery };

    const result = await repo.decide(
      ctx,
      "comp-1",
      "app-123",
      "approved",
      "Authorized by admin after template review"
    );

    expect(result.status).toBe("approved");
    expect(result.decisionNotes).toContain("Authorized by admin");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate decision attempts on already resolved approvals", async () => {
    const alreadyResolved: CompanyApproval = {
      id: "app-123",
      workspaceId: ctx.workspaceId,
      companyId: "comp-1",
      userId: ctx.userId,
      toolName: "database.delete_records",
      riskLevel: "critical",
      actionSummary: "Purge customer logs older than 30 days",
      inputPayload: {},
      status: "rejected",
      decisionNotes: "Denied for compliance reasons",
      requestedAt: new Date().toISOString(),
      respondedAt: new Date().toISOString(),
    };

    const mockQuery = vi.fn().mockResolvedValue({ rows: [alreadyResolved] });

    const repo = new CompanyApprovalsRepository("postgres://fake:fake@localhost/db");
    (repo as any).pool = { query: mockQuery };

    await expect(repo.decide(ctx, "comp-1", "app-123", "approved")).rejects.toThrow(
      /already resolved with status "rejected"/i
    );
  });
});
