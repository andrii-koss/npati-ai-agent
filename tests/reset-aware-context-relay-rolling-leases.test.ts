import { describe, expect, it } from "vitest";
import { RoutingStrategiesManager } from "../apps/agent-api/src/routing-strategies";
import { AtomicRpmLeaseManager } from "../apps/agent-api/src/atomic-rpm-rolling-leases";

describe("Reset-Aware Routing Strategy", () => {
  it("smooths traffic according to post-reset recovery trajectories", () => {
    const router = new RoutingStrategiesManager();

    const states = [
      { provider: "anthropic", timeSinceResetSeconds: 5, maxRpm: 100 }, // 5/60 factor = 0.08
      { provider: "openai", timeSinceResetSeconds: 40, maxRpm: 100 },   // 40/60 factor = 0.67
      { provider: "google", timeSinceResetSeconds: 60, maxRpm: 100 },   // 60/60 factor = 1.0 (fully recovered)
    ];

    const res = router.resolveResetAware(states);
    expect(res.strategy).toBe("reset-aware");
    expect(res.provider).toBe("google"); // Highest recovered score
    expect(res.selectedModelId).toBe("google/gemini-2.5-flash");
  });
});

describe("Context-Relay Routing Strategy", () => {
  it("relays large conversation context to a model with adequate window size", () => {
    const router = new RoutingStrategiesManager();

    // 150k tokens requires > 225k tokens -> routes to Gemini 2.5 Flash (1M)
    const res = router.resolveContextRelay(150_000);
    expect(res.strategy).toBe("context-relay");
    expect(res.provider).toBe("google");
    expect(res.selectedModelId).toBe("google/gemini-2.5-flash");
  });
});

describe("Atomic RPM Rolling Lease Manager", () => {
  it("grants atomic leases within capacity, rejects exceeding requests, and releases leases", () => {
    const manager = new AtomicRpmLeaseManager(1000);

    const l1 = manager.acquireLease({ provider: "anthropic", maxRpm: 5, tokens: 3 });
    expect(l1.granted).toBe(true);
    expect(l1.remainingTokens).toBe(2);

    const l2 = manager.acquireLease({ provider: "anthropic", maxRpm: 5, tokens: 2 });
    expect(l2.granted).toBe(true);
    expect(l2.remainingTokens).toBe(0);

    // Over capacity
    const l3 = manager.acquireLease({ provider: "anthropic", maxRpm: 5, tokens: 1 });
    expect(l3.granted).toBe(false);
    expect(l3.reason).toContain("RPM limit exceeded");

    // Release l1 (3 tokens freed)
    const released = manager.releaseLease(l1.leaseId!);
    expect(released).toBe(true);
    const l4 = manager.acquireLease({ provider: "anthropic", maxRpm: 5, tokens: 2 });
    expect(l4.granted).toBe(true);
  });

  it("filters active leases by provider and cleans up expired leases automatically", async () => {
    const manager = new AtomicRpmLeaseManager(50); // 50ms window

    const l1 = manager.acquireLease({ provider: "openai", maxRpm: 10, tokens: 4 });
    const l2 = manager.acquireLease({ provider: "anthropic", maxRpm: 10, tokens: 2 });

    expect(manager.getActiveLeases().length).toBe(2);
    expect(manager.getActiveLeases("openai").length).toBe(1);
    expect(manager.getActiveLeases("anthropic").length).toBe(1);
    expect(manager.getActiveLeases("google").length).toBe(0);

    // Wait for expiration
    await new Promise((r) => setTimeout(r, 60));
    expect(manager.cleanupExpired()).toBe(2);
    expect(manager.getActiveLeases().length).toBe(0);
  });
});
