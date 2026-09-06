import { describe, expect, it } from "vitest";
import { RoutingStrategiesManager } from "../apps/agent-api/src/routing-strategies";

describe("Fill-First Routing Strategy (RoutingStrategiesManager)", () => {
  it("routes to first provider until saturated, then overflows to next candidate", () => {
    const router = new RoutingStrategiesManager();

    // Below 90% -> picks anthropic
    const res1 = router.resolveFillFirst([
      { provider: "anthropic", currentRpm: 50, maxRpm: 100 },
      { provider: "openai", currentRpm: 10, maxRpm: 100 },
    ]);
    expect(res1.strategy).toBe("fill-first");
    expect(res1.provider).toBe("anthropic");

    // Saturated (95%) -> overflows to openai
    const res2 = router.resolveFillFirst([
      { provider: "anthropic", currentRpm: 95, maxRpm: 100 },
      { provider: "openai", currentRpm: 10, maxRpm: 100 },
    ]);
    expect(res2.strategy).toBe("fill-first");
    expect(res2.provider).toBe("openai");
    expect(res2.selectedModelId).toBe("openai/gpt-4o");
  });
});

describe("Weighted Routing Strategy (RoutingStrategiesManager)", () => {
  it("routes probabilistically based on assigned weight ratios", () => {
    const router = new RoutingStrategiesManager();
    const weights = { anthropic: 80, openai: 20 };

    // At 0.5 (within 0..0.8) -> anthropic
    const res1 = router.resolveWeighted(weights, 0.5);
    expect(res1.strategy).toBe("weighted");
    expect(res1.provider).toBe("anthropic");

    // At 0.9 (within 0.8..1.0) -> openai
    const res2 = router.resolveWeighted(weights, 0.9);
    expect(res2.strategy).toBe("weighted");
    expect(res2.provider).toBe("openai");
  });
});

describe("Round-Robin Routing Strategy (RoutingStrategiesManager)", () => {
  it("cycles evenly across healthy provider list", () => {
    const router = new RoutingStrategiesManager();
    const providers = ["anthropic", "openai", "google"];

    const turn1 = router.resolveRoundRobin(providers);
    const turn2 = router.resolveRoundRobin(providers);
    const turn3 = router.resolveRoundRobin(providers);
    const turn4 = router.resolveRoundRobin(providers);

    expect(turn1.provider).toBe("anthropic");
    expect(turn2.provider).toBe("openai");
    expect(turn3.provider).toBe("google");
    expect(turn4.provider).toBe("anthropic"); // Rotates back
  });
});
