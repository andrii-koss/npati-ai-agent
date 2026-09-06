import { describe, it, expect } from "vitest";
import {
  buildRunTimeline,
  aggregateRunAccounting,
  paginateTraceEvents,
  isEligibleForRetention,
  type ActivityTimelineItem,
} from "@npati/shared";
import type {
  CompanyAgentRun,
  CompanyAgentRunStep,
  CompanyAgentToolAudit,
} from "@npati/workspace";

describe("PHASE 7: Run Engine, Trace, Activity and Observability", () => {
  const baseRun: CompanyAgentRun = {
    id: "run-trace-100",
    workspaceId: "ws-1",
    companyId: "comp-1",
    userId: "user-1",
    mainAgentId: "agent-main",
    idempotencyKey: "key-100",
    task: "Generate multi-agent competitive research report",
    requestedMode: "pipeline",
    executionMode: "pipeline",
    status: "completed",
    selectedAgentIds: ["agent-research", "agent-writer", "agent-reviewer"],
    attemptCount: 1,
    maxAttempts: 3,
    nextAttemptAt: new Date().toISOString(),
    cancelRequested: false,
    agentConfigRevision: 2,
    capabilitySetRevision: 14,
    totalCost: 0.045,
    totalTokens: 3200,
    totalDurationMs: 4500,
    createdAt: "2026-09-03T10:00:00.000Z",
    startedAt: "2026-09-03T10:00:00.500Z",
    completedAt: "2026-09-03T10:00:05.000Z",
    updatedAt: "2026-09-03T10:00:05.000Z",
  };

  const sampleSteps: CompanyAgentRunStep[] = [
    {
      id: "step-1",
      workspaceId: "ws-1",
      companyId: "comp-1",
      runId: baseRun.id,
      agentId: "agent-research",
      stepOrder: 0,
      lane: 0,
      role: "worker",
      status: "completed",
      modelId: "gpt-4o",
      createdAt: "2026-09-03T10:00:01.000Z",
      updatedAt: "2026-09-03T10:00:02.000Z",
    },
    {
      id: "step-2",
      workspaceId: "ws-1",
      companyId: "comp-1",
      runId: baseRun.id,
      agentId: "agent-writer",
      stepOrder: 1,
      lane: 0,
      role: "worker",
      status: "completed",
      modelId: "claude-3-5-sonnet",
      createdAt: "2026-09-03T10:00:02.100Z",
      updatedAt: "2026-09-03T10:00:03.500Z",
    },
    {
      id: "step-3",
      workspaceId: "ws-1",
      companyId: "comp-1",
      runId: baseRun.id,
      agentId: "agent-reviewer",
      stepOrder: 2,
      lane: 0,
      role: "reviewer",
      status: "completed",
      modelId: "gpt-4o",
      createdAt: "2026-09-03T10:00:03.600Z",
      updatedAt: "2026-09-03T10:00:04.900Z",
    },
  ];

  const sampleAudits: CompanyAgentToolAudit[] = [
    {
      id: "audit-1",
      workspaceId: "ws-1",
      companyId: "comp-1",
      runId: baseRun.id,
      agentId: "agent-research",
      toolName: "web.search",
      decision: "allowed",
      status: "succeeded",
      inputSummary: { query: "AI agent market share 2026" },
      createdAt: "2026-09-03T10:00:01.200Z",
      completedAt: "2026-09-03T10:00:01.800Z",
      latencyMs: 600,
      cost: 0.01,
      tokens: 450,
      sequenceNumber: 1,
    },
    {
      id: "audit-2",
      workspaceId: "ws-1",
      companyId: "comp-1",
      runId: baseRun.id,
      agentId: "agent-research",
      toolName: "database.drop_table",
      decision: "denied",
      status: "blocked",
      inputSummary: { table: "audit_logs" },
      errorMessage: "Destructive tool database.drop_table requires human approval before execution",
      reasonCode: "approval_required",
      createdAt: "2026-09-03T10:00:01.900Z",
      completedAt: "2026-09-03T10:00:01.900Z",
      latencyMs: 2,
      cost: 0,
      tokens: 0,
      sequenceNumber: 2,
    },
  ];

  const agentsMap = new Map<string, string>([
    ["agent-main", "Coordinator Main Agent"],
    ["agent-research", "Deep Research Specialist"],
    ["agent-writer", "Content Writer Agent"],
    ["agent-reviewer", "Senior Reviewer"],
  ]);

  describe("Complete Activity Timeline & Tracing", () => {
    it("generates a complete timeline covering run start, step delegation, tool execution, and completion", () => {
      const timeline = buildRunTimeline(baseRun, sampleSteps, sampleAudits, agentsMap);

      expect(timeline.length).toBeGreaterThanOrEqual(6);
      const types = timeline.map((e) => e.type);

      expect(types).toContain("run_started");
      expect(types).toContain("step_delegated");
      expect(types).toContain("tool_executed");
      expect(types).toContain("tool_blocked");
      expect(types).toContain("run_completed");

      // Verify agent name resolution
      const startItem = timeline.find((e) => e.type === "run_started");
      expect(startItem?.agentName).toBe("Coordinator Main Agent");
    });

    it("ensures no internal chain-of-thought is leaked in user-facing timeline", () => {
      const timeline = buildRunTimeline(baseRun, sampleSteps, sampleAudits, agentsMap);

      for (const item of timeline) {
        expect((item as any).chainOfThought).toBeUndefined();
        expect((item as any).internalThoughts).toBeUndefined();
        expect(item.summary).not.toMatch(/thinking process|hidden reasoning/i);
      }
    });

    it("makes denied tools explicitly visible as denied/blocked with reasonCode, never silent failure", () => {
      const timeline = buildRunTimeline(baseRun, sampleSteps, sampleAudits, agentsMap);
      const blockedItem = timeline.find((e) => e.type === "tool_blocked");

      expect(blockedItem).toBeDefined();
      expect(blockedItem?.decision).toBe("denied");
      expect(blockedItem?.status).toBe("blocked");
      expect(blockedItem?.toolName).toBe("database.drop_table");
      expect(blockedItem?.reasonCode).toBe("approval_required");
      expect(blockedItem?.summary).toContain("Blocked database.drop_table");
      expect(blockedItem?.summary).toContain("requires human approval");
    });
  });

  describe("Cost, Token, and Duration Accounting", () => {
    it("aggregates cost and tokens by company, user, and agent", () => {
      const accounting = aggregateRunAccounting([baseRun], sampleAudits);

      expect(accounting.totalCost).toBe(0.045);
      expect(accounting.totalTokens).toBe(3200);
      expect(accounting.totalRuns).toBe(1);

      // By Company
      expect(accounting.byCompany["comp-1"]).toBeDefined();
      expect(accounting.byCompany["comp-1"].totalCost).toBe(0.045);
      expect(accounting.byCompany["comp-1"].totalTokens).toBe(3200);
      expect(accounting.byCompany["comp-1"].totalDurationMs).toBe(4500);

      // By User
      expect(accounting.byUser["user-1"]).toBeDefined();
      expect(accounting.byUser["user-1"].totalCost).toBe(0.045);
      expect(accounting.byUser["user-1"].totalTokens).toBe(3200);

      // By Agent
      expect(accounting.byAgent["agent-research"]).toBeDefined();
      expect(accounting.byAgent["agent-research"].totalCalls).toBe(2);
      expect(accounting.byAgent["agent-research"].totalCost).toBe(0.01);
      expect(accounting.byAgent["agent-research"].totalTokens).toBe(450);
      expect(accounting.byAgent["agent-research"].totalDurationMs).toBe(602);
    });
  });

  describe("Deterministic Sequence Ordering & Cursor Pagination", () => {
    it("orders concurrent/simultaneous events deterministically using timestamp, sequenceNumber, and id", () => {
      const concurrentAudits: CompanyAgentToolAudit[] = [
        {
          id: "audit-b",
          workspaceId: "ws-1",
          companyId: "comp-1",
          runId: baseRun.id,
          agentId: "agent-research",
          toolName: "tool.b",
          decision: "allowed",
          status: "succeeded",
          inputSummary: {},
          createdAt: "2026-09-03T10:00:01.000Z", // same timestamp as audit-a
          sequenceNumber: 2,
        },
        {
          id: "audit-a",
          workspaceId: "ws-1",
          companyId: "comp-1",
          runId: baseRun.id,
          agentId: "agent-research",
          toolName: "tool.a",
          decision: "allowed",
          status: "succeeded",
          inputSummary: {},
          createdAt: "2026-09-03T10:00:01.000Z", // same timestamp as audit-b
          sequenceNumber: 1,
        },
      ];

      const timeline = buildRunTimeline(baseRun, [], concurrentAudits);
      const auditItems = timeline.filter((e) => e.type === "tool_executed");

      expect(auditItems).toHaveLength(2);
      expect(auditItems[0].id).toBe("tl-audit-audit-a");
      expect(auditItems[1].id).toBe("tl-audit-audit-b");
    });

    it("paginates large event lists stably using cursor pagination", () => {
      const items: ActivityTimelineItem[] = Array.from({ length: 50 }, (_, i) => ({
        id: `event-${i.toString().padStart(3, "0")}`,
        runId: "run-large",
        timestamp: new Date(1700000000000 + i * 1000).toISOString(),
        sequenceNumber: i,
        type: "tool_executed",
        summary: `Action ${i}`,
      }));

      // First page
      const page1 = paginateTraceEvents(items, { limit: 15 });
      expect(page1.items).toHaveLength(15);
      expect(page1.items[0].id).toBe("event-000");
      expect(page1.items[14].id).toBe("event-014");
      expect(page1.nextCursor).toBe("event-014");
      expect(page1.totalCount).toBe(50);

      // Second page using cursor
      const page2 = paginateTraceEvents(items, { limit: 15, cursor: page1.nextCursor });
      expect(page2.items).toHaveLength(15);
      expect(page2.items[0].id).toBe("event-015");
      expect(page2.items[14].id).toBe("event-029");
      expect(page2.nextCursor).toBe("event-029");

      // Last page
      const page4 = paginateTraceEvents(items, { limit: 15, cursor: "event-044" });
      expect(page4.items).toHaveLength(5);
      expect(page4.nextCursor).toBeUndefined(); // no more pages
    });
  });

  describe("Retention & Lifecycle Readiness", () => {
    it("identifies events older than retention period", () => {
      const now = new Date("2026-09-03T12:00:00.000Z").getTime();
      const recent = "2026-09-01T12:00:00.000Z"; // 2 days old
      const stale = "2026-07-01T12:00:00.000Z";  // ~64 days old

      // 30 days retention policy
      expect(isEligibleForRetention(recent, 30, now)).toBe(false);
      expect(isEligibleForRetention(stale, 30, now)).toBe(true);
    });
  });
});
