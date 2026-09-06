import { describe, expect, it } from "vitest";
import { RoutingStrategiesManager } from "../apps/agent-api/src/routing-strategies";

describe("Routing Strategies (RoutingStrategiesManager)", () => {
  it("resolves cost-optimized routing to the cheapest model with computed savings", () => {
    const manager = new RoutingStrategiesManager();
    const result = manager.resolveCostOptimized(5000, 1000);

    expect(result.strategy).toBe("cost-optimized");
    expect(result.selectedModelId).toBe("google/gemini-2.5-flash");
    expect(result.estimatedCostUsd).toBeLessThan(0.001);
    expect(result.estimatedSavingsPercent).toBeGreaterThan(90);
    expect(result.reason).toContain("savings");
  });

  it("resolves context-optimized routing based on input prompt token size", () => {
    const manager = new RoutingStrategiesManager();

    // 1. Massive 150,000 token prompt -> routes to 1M Gemini
    const huge = manager.resolveContextOptimized(150_000);
    expect(huge.selectedModelId).toBe("google/gemini-2.5-flash");
    expect(huge.reason).toContain("1M context window");

    // 2. Medium 50,000 token prompt -> routes to 200k Claude 3.7
    const medium = manager.resolveContextOptimized(50_000);
    expect(medium.selectedModelId).toBe("anthropic/claude-3-7-sonnet");
    expect(medium.reason).toContain("200k context window");

    // 3. Compact 5,000 token prompt -> routes to fast/economy model
    const small = manager.resolveContextOptimized(5_000);
    expect(small.selectedModelId).toBe("google/gemini-2.5-flash");
    expect(small.reason).toContain("Compact prompt");
  });

  it("resolves cache-optimized routing with prompt cache discount computation", () => {
    const manager = new RoutingStrategiesManager();
    const result = manager.resolveCacheOptimized(10_000, 8_000); // 8k of 10k tokens are cached

    expect(result.strategy).toBe("cache-optimized");
    expect(result.cacheControlEnabled).toBe(true);
    expect(result.estimatedSavingsPercent).toBeGreaterThan(50);
    expect(result.reason).toContain("Prompt-cache routing active");
  });
});
