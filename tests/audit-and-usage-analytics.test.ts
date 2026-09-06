import { describe, expect, it, vi } from "vitest";
import {
  AuditRepository,
  type AuditLogEntry,
} from "../apps/agent-api/src/audit-repository";
import type { AuthContext } from "@npati/workspace";

describe("Audit Trail & Usage Analytics (OpenClaw Items 109, 102, 103 / P1)", () => {
  const ctx: AuthContext = {
    workspaceId: "ws-test",
    userId: "user-test",
    permissions: ["workspace:read", "business:manage"],
    role: "owner",
  };

  describe("Audit Trail (OpenClaw Item 109 / Row 67)", () => {
    it("creates and retrieves audit trail log entries with tenant isolation", async () => {
      const mockLog: AuditLogEntry = {
        id: "audit-1",
        workspaceId: ctx.workspaceId,
        companyId: "comp-1",
        userId: ctx.userId,
        action: "mcp.server.created",
        category: "mcp",
        resourceType: "mcp_server",
        resourceId: "mcp-123",
        details: { serverName: "CRM Server" },
        ipAddress: "127.0.0.1",
        createdAt: new Date().toISOString(),
      };

      const mockQuery = vi
        .fn()
        .mockResolvedValueOnce({ rows: [mockLog] }) // log
        .mockResolvedValueOnce({ rows: [mockLog] }); // listAuditLogs

      const repo = new AuditRepository("postgres://fake:fake@localhost/db");
      (repo as any).pool = { query: mockQuery };

      const created = await repo.log(ctx, "comp-1", {
        action: "mcp.server.created",
        category: "mcp",
        resourceType: "mcp_server",
        resourceId: "mcp-123",
        details: { serverName: "CRM Server" },
      });

      expect(created.action).toBe("mcp.server.created");
      expect(created.category).toBe("mcp");

      const logs = await repo.listAuditLogs(ctx, "comp-1", 10);
      expect(logs.length).toBe(1);
      expect(logs[0]?.resourceType).toBe("mcp_server");
    });
  });

  describe("Usage Analytics & Quota Tracking (OpenClaw Items 102 & 103 / Rows 65 & 66)", () => {
    it("records token usage and aggregates summary metrics by model", async () => {
      const mockQuery = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: "metric-1",
              workspaceId: ctx.workspaceId,
              companyId: "comp-1",
              modelId: "openai/gpt-4o",
              promptTokens: 1000,
              completionTokens: 500,
              costUsd: 0.0075,
              latencyMs: 850,
              createdAt: new Date().toISOString(),
            },
          ],
        }) // recordUsage
        .mockResolvedValueOnce({
          rows: [
            {
              model_id: "openai/gpt-4o",
              request_count: "10",
              total_prompt_tokens: "10000",
              total_completion_tokens: "5000",
              total_cost_usd: "0.075",
              avg_latency_ms: "820",
            },
            {
              model_id: "google/gemini-2.0-flash",
              request_count: "20",
              total_prompt_tokens: "15000",
              total_completion_tokens: "6000",
              total_cost_usd: "0.0039",
              avg_latency_ms: "410",
            },
          ],
        }); // getUsageAnalytics

      const repo = new AuditRepository("postgres://fake:fake@localhost/db");
      (repo as any).pool = { query: mockQuery };

      await repo.recordUsage(ctx, "comp-1", {
        modelId: "openai/gpt-4o",
        promptTokens: 1000,
        completionTokens: 500,
        costUsd: 0.0075,
        latencyMs: 850,
      });

      const analytics = await repo.getUsageAnalytics(ctx, "comp-1");

      expect(analytics.totalRequests).toBe(30);
      expect(analytics.totalPromptTokens).toBe(25000);
      expect(analytics.totalCompletionTokens).toBe(11000);
      expect(analytics.totalTokens).toBe(36000);
      expect(analytics.totalCostUsd).toBeCloseTo(0.0789, 4);
      expect(analytics.byModel["openai/gpt-4o"]?.requests).toBe(10);
      expect(analytics.byModel["google/gemini-2.0-flash"]?.requests).toBe(20);
    });
  });
});
