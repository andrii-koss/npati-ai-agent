// Retired quota algorithms only: activation is confined to this isolated test file.
// Real release-policy and HTTP coverage: usage-quotas-disabled.test.ts.
vi.mock("../apps/agent-api/src/usage-quota-policy", () => ({ usageQuotasEnabled: () => true }));
import { describe, expect, it , vi } from "vitest";
import {
  QuotaShareRouter,
  RoutingTransparencyLogger,
  SessionPromptDeduplicator,
} from "../apps/agent-api/src/routing-transparency-and-dedup";

describe("Quota-Share Router (QuotaShareRouter)", () => {
  it("enforces fair-share quota admission during saturation by tenant tier", () => {
    const router = new QuotaShareRouter();
    router.setTenantShare("tenant-ent", "enterprise", 60);
    router.setTenantShare("tenant-starter", "starter", 10);

    // Below 80% saturation -> all admitted
    const normalState = router.isAdmitted("tenant-starter", 50, 100);
    expect(normalState.admitted).toBe(true);

    // At 85% saturation -> starter throttled, enterprise admitted
    const satStarter = router.isAdmitted("tenant-starter", 85, 100);
    expect(satStarter.admitted).toBe(false);
    expect(satStarter.reason).toContain("throttled to preserve fair share");

    const satEnterprise = router.isAdmitted("tenant-ent", 85, 100);
    expect(satEnterprise.admitted).toBe(true);
    expect(satEnterprise.reason).toContain("guaranteed quota share");
  });

  it("handles pro tier thresholds and inspects tenant shares", () => {
    const router = new QuotaShareRouter();
    router.setTenantShare("tenant-pro", "pro", 30);

    expect(router.getTenantShare("tenant-pro")).toEqual({
      tenantId: "tenant-pro",
      tier: "pro",
      allocatedSharePercent: 30,
      activeRequests: 0,
    });
    expect(router.getAllShares().length).toBe(1);

    // At 90% saturation (between 80% and 95%), pro is admitted
    const admit90 = router.isAdmitted("tenant-pro", 90, 100);
    expect(admit90.admitted).toBe(true);
    expect(admit90.reason).toContain("Pro tenant admitted below 95% saturation");

    // At 97% saturation (>95%), pro is throttled
    const throttle97 = router.isAdmitted("tenant-pro", 97, 100);
    expect(throttle97.admitted).toBe(false);
    expect(throttle97.reason).toContain("throttled to preserve fair share");
  });
});

describe("Routing Transparency Logger (RoutingTransparencyLogger)", () => {
  it("creates decision records and attaches standard transparency headers", () => {
    const record = RoutingTransparencyLogger.createDecisionRecord({
      strategy: "cost-optimized",
      provider: "anthropic",
      modelId: "claude-3-7-sonnet",
      latencyMs: 340,
      estimatedCostUsd: 0.0045,
      cacheHit: true,
      failoverCount: 0,
    });

    expect(record.requestId).toMatch(/^req_/);
    expect(record.cacheHit).toBe(true);

    const headers = RoutingTransparencyLogger.generateTransparencyHeaders(record);
    expect(headers["X-NPATI-Routing-Strategy"]).toBe("cost-optimized");
    expect(headers["X-NPATI-Selected-Provider"]).toBe("anthropic");
    expect(headers["X-NPATI-Selected-Model"]).toBe("claude-3-7-sonnet");
    expect(headers["X-NPATI-Cache-Hit"]).toBe("true");
    expect(headers["X-NPATI-Latency-MS"]).toBe("340");
  });
});

describe("Session Prompt Deduplicator (SessionPromptDeduplicator)", () => {
  it("deduplicates redundant repeated system instructions across conversation turns", () => {
    const massiveSystemPrompt = "You are NPATI Agent. Follow guidelines: Rule 1... Rule 2... ".repeat(20);

    const messages = [
      { role: "system", content: massiveSystemPrompt },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "system", content: massiveSystemPrompt }, // Redundant repeat
      { role: "user", content: "Tell me about routing" },
    ];

    const result = SessionPromptDeduplicator.deduplicate(messages);

    expect(result.deduplicatedMessages.length).toBe(5);
    expect(result.deduplicatedMessages[3].content).toContain("[Inherited System Prompt: Ref #1]");
    expect(result.estimatedTokensSaved).toBeGreaterThan(50);
    expect(result.deduplicatedLength).toBeLessThan(result.originalLength);
  });
});
