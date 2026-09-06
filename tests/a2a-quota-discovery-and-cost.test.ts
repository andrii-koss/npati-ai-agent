import { describe, expect, it } from "vitest";
import {
  A2AQuotaManager,
  A2AProviderDiscovery,
  A2ACostAnalyzer,
} from "../apps/agent-api/src/a2a-protocol-extensions";

describe("A2A Quota Management (A2AQuotaManager)", () => {
  it("enforces session token, cost limits, and maximum recursion depth", () => {
    const quota = new A2AQuotaManager();
    const sessionId = "session-a2a-limits";

    quota.setSessionBudget(sessionId, 5000, 0.05, 3); // 5k tokens, $0.05 max spend, depth 3

    // Allowed call at depth 1
    const check1 = quota.checkAllowance(sessionId, 1000, 0.01, 1);
    expect(check1.allowed).toBe(true);
    quota.recordUsage(sessionId, 1000, 0.01);

    // Call exceeding recursion depth (depth 4 > max 3)
    const checkDepth = quota.checkAllowance(sessionId, 500, 0.005, 4);
    expect(checkDepth.allowed).toBe(false);
    expect(checkDepth.error).toContain("A2A_MAX_DEPTH_EXCEEDED");

    // Call exceeding spend limit
    const checkSpend = quota.checkAllowance(sessionId, 500, 0.05, 2);
    expect(checkSpend.allowed).toBe(false);
    expect(checkSpend.error).toContain("A2A_COST_QUOTA_EXCEEDED");
  });
});

describe("A2A Provider Discovery (A2AProviderDiscovery)", () => {
  it("discovers and ranks agents by capability, health score, and latency", () => {
    const discovery = new A2AProviderDiscovery();

    discovery.registerAgent({
      agentId: "agent-coder-pro",
      name: "Expert Code Agent",
      capabilities: ["typescript", "coding", "testing"],
      preferredModel: "claude-3-7-sonnet",
      healthScore: 0.98,
      avgLatencyMs: 350,
      isAvailable: true,
    });

    discovery.registerAgent({
      agentId: "agent-coder-lite",
      name: "Fast Code Agent",
      capabilities: ["coding", "debugging"],
      preferredModel: "gpt-4o-mini",
      healthScore: 0.85,
      avgLatencyMs: 180,
      isAvailable: true,
    });

    discovery.registerAgent({
      agentId: "agent-docs",
      name: "Doc Writer",
      capabilities: ["documentation", "markdown"],
      preferredModel: "gemini-2.5-flash",
      healthScore: 0.95,
      avgLatencyMs: 200,
      isAvailable: true,
    });

    const candidates = discovery.discoverAgents("coding");
    expect(candidates.length).toBe(2);
    expect(candidates[0].agentId).toBe("agent-coder-pro"); // Higher health score ranked first
  });
});

describe("A2A Cost Analysis (A2ACostAnalyzer)", () => {
  it("tracks multi-agent delegation traces and calculates aggregated tree costs", () => {
    const analyzer = new A2ACostAnalyzer();
    const traceId = "trace-tree-123";

    analyzer.recordDelegation({
      traceId,
      agentId: "agent-planner",
      model: "gpt-4o",
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.0035,
      durationMs: 400,
      timestamp: new Date().toISOString(),
    });

    analyzer.recordDelegation({
      traceId,
      agentId: "agent-coder",
      parentAgentId: "agent-planner",
      model: "claude-3-7-sonnet",
      inputTokens: 1200,
      outputTokens: 800,
      costUsd: 0.015,
      durationMs: 1200,
      timestamp: new Date().toISOString(),
    });

    const summary = analyzer.analyzeTraceCosts(traceId);
    expect(summary.totalTokens).toBe(2700);
    expect(summary.totalCostUsd).toBeCloseTo(0.0185, 4);
    expect(summary.agentBreakdown["agent-coder"]?.callsCount).toBe(1);
    expect(summary.agentBreakdown["agent-planner"]?.tokens).toBe(700);
  });
});
