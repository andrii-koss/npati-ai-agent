import { describe, expect, it } from "vitest";
import { RoutingStrategiesManager } from "../apps/agent-api/src/routing-strategies";

describe("P2C (Power of Two Random Choices) Routing Strategy", () => {
  it("compares two candidates and picks the one with lower load/latency", () => {
    const router = new RoutingStrategiesManager();

    const loads = [
      { provider: "anthropic", activeRequests: 15, latencyMs: 300 },
      { provider: "openai", activeRequests: 3, latencyMs: 150 },
      { provider: "google", activeRequests: 25, latencyMs: 400 },
    ];

    // Comparing anthropic (idx 0) vs openai (idx 1) -> openai wins
    const res = router.resolveP2c(loads, 0, 1);
    expect(res.strategy).toBe("p2c");
    expect(res.provider).toBe("openai");
    expect(res.selectedModelId).toBe("openai/gpt-4o");
  });
});

describe("Least-Used Routing Strategy", () => {
  it("routes strictly to provider with minimum active concurrent requests", () => {
    const router = new RoutingStrategiesManager();

    const loads = [
      { provider: "anthropic", activeRequests: 10 },
      { provider: "openai", activeRequests: 8 },
      { provider: "deepseek", activeRequests: 1 },
    ];

    const res = router.resolveLeastUsed(loads);
    expect(res.strategy).toBe("least-used");
    expect(res.provider).toBe("deepseek");
    expect(res.selectedModelId).toBe("deepseek/deepseek-v3");
  });
});

describe("Random Routing Strategy", () => {
  it("routes uniformly across healthy provider pool", () => {
    const router = new RoutingStrategiesManager();
    const providers = ["anthropic", "openai", "google", "deepseek"];

    // First bucket (0.1 / 4) -> anthropic
    const res1 = router.resolveRandom(providers, 0.1);
    expect(res1.strategy).toBe("random");
    expect(res1.provider).toBe("anthropic");

    // Third bucket (0.6 / 4) -> google
    const res2 = router.resolveRandom(providers, 0.6);
    expect(res2.strategy).toBe("random");
    expect(res2.provider).toBe("google");
  });
});
