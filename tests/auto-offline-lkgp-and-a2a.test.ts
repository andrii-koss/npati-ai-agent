import { describe, expect, it } from "vitest";
import { AutoComboRouter } from "../apps/agent-api/src/auto-combo-profiles";
import { LkgpStrategyManager } from "../apps/agent-api/src/lkgp-router";
import { A2AProtocolV03 } from "../apps/agent-api/src/a2a-protocol";

describe("Auto/Offline Air-Gapped Routing (AutoComboRouter)", () => {
  it("resolves auto/offline to local zero-cost models", () => {
    const router = new AutoComboRouter();
    const result = router.resolve("auto/offline");

    expect(result.profile).toBe("auto/offline");
    expect(result.isOffline).toBe(true);
    expect(result.selectedModelId).toContain("ollama/");
    expect(result.reason).toContain("$0.00/M tokens");
  });
});

describe("Last Known Good Provider - LKGP (LkgpStrategyManager)", () => {
  it("remembers successful providers and provides fast-path resolution", () => {
    const lkgp = new LkgpStrategyManager();
    const companyId = "company-fintech";

    // Initially no LKGP, returns fallback
    const initial = lkgp.resolveLkgp(companyId, "accounting");
    expect(initial.isCachedLkgp).toBe(false);

    // Record success with Claude 3.7
    lkgp.recordSuccess(companyId, "accounting", "anthropic/claude-3-7-sonnet", "anthropic");

    // Subsequent resolution returns cached LKGP
    const cached = lkgp.resolveLkgp(companyId, "accounting");
    expect(cached.isCachedLkgp).toBe(true);
    expect(cached.selectedModelId).toBe("anthropic/claude-3-7-sonnet");
    expect(cached.provider).toBe("anthropic");
  });

  it("downgrades and falls back when LKGP accumulates failures", () => {
    const lkgp = new LkgpStrategyManager();
    const companyId = "company-resilience";

    lkgp.recordSuccess(companyId, "support", "openai/gpt-4o", "openai");
    expect(lkgp.resolveLkgp(companyId, "support").isCachedLkgp).toBe(true);

    // Record 2 consecutive failures
    lkgp.recordFailure(companyId, "support", "openai/gpt-4o");
    lkgp.recordFailure(companyId, "support", "openai/gpt-4o");

    // Should now fallback
    const fallback = lkgp.resolveLkgp(companyId, "support", "google/gemini-2.5-flash");
    expect(fallback.isCachedLkgp).toBe(false);
    expect(fallback.selectedModelId).toBe("google/gemini-2.5-flash");
    expect(fallback.reason).toContain("degraded");
  });
});

describe("A2A Protocol v0.3 (A2AProtocolV03)", () => {
  it("creates, validates, and serializes standardized A2A v0.3 envelopes", () => {
    const sender = { agentId: "agent-manager", companyId: "comp-1", tenantId: "tenant-1", role: "manager" };
    const recipient = { agentId: "agent-researcher", companyId: "comp-1", tenantId: "tenant-1", role: "worker" };

    const envelope = A2AProtocolV03.createEnvelope(
      "task_delegate",
      sender,
      recipient,
      { query: "Find market competitors", depth: 3 }
    );

    expect(envelope.version).toBe("0.3");
    expect(envelope.type).toBe("task_delegate");
    expect(envelope.correlationId).toBeDefined();
    expect(envelope.traceId).toMatch(/^tr_/);

    // Validate envelope
    const validation = A2AProtocolV03.validateEnvelope(envelope);
    expect(validation.valid).toBe(true);

    // Create result response envelope
    const response = A2AProtocolV03.createResponseEnvelope(envelope, {
      competitors: ["Company A", "Company B"],
      completedAt: new Date().toISOString(),
    });

    expect(response.type).toBe("task_result");
    expect(response.sender.agentId).toBe("agent-researcher");
    expect(response.recipient.agentId).toBe("agent-manager");
    expect(response.correlationId).toBe(envelope.correlationId);
    expect(response.traceId).toBe(envelope.traceId);
  });

  it("rejects invalid A2A envelopes with version mismatch or missing fields", () => {
    const invalidVersion = {
      version: "0.1",
      id: "123",
      type: "handshake",
    };

    const valResult = A2AProtocolV03.validateEnvelope(invalidVersion);
    expect(valResult.valid).toBe(false);
    if (!valResult.valid) {
      expect(valResult.error).toContain("A2A_VERSION_MISMATCH");
    }
  });
});
