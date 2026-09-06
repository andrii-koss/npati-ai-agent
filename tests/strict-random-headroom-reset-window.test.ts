import { describe, expect, it } from "vitest";
import { RoutingStrategiesManager } from "../apps/agent-api/src/routing-strategies";

describe("Strict-Random Routing Strategy", () => {
  it("routes deterministically with provided CSPRNG integer or randomly without bias", () => {
    const router = new RoutingStrategiesManager();
    const providers = ["anthropic", "openai", "google", "deepseek"];

    // With explicit CSPRNG integer 2 -> google
    const res1 = router.resolveStrictRandom(providers, 2);
    expect(res1.strategy).toBe("strict-random");
    expect(res1.provider).toBe("google");

    // Dynamic execution
    const res2 = router.resolveStrictRandom(providers);
    expect(providers).toContain(res2.provider);
  });
});

describe("Headroom Routing Strategy", () => {
  it("routes to provider with largest remaining safety headroom buffer", () => {
    const router = new RoutingStrategiesManager();

    const headrooms = [
      { provider: "anthropic", remainingHeadroomRpm: 10 },
      { provider: "openai", remainingHeadroomRpm: 50 },
      { provider: "google", remainingHeadroomRpm: 25 },
    ];

    const res = router.resolveHeadroom(headrooms);
    expect(res.strategy).toBe("headroom");
    expect(res.provider).toBe("openai"); // 50 RPM remaining headroom
    expect(res.selectedModelId).toBe("openai/gpt-4o");
  });
});

describe("Reset-Window Routing Strategy", () => {
  it("prioritizes unconstrained providers whose windows reset soonest", () => {
    const router = new RoutingStrategiesManager();

    const resetStates = [
      { provider: "anthropic", resetInSeconds: 30, isLimited: true },
      { provider: "openai", resetInSeconds: 5, isLimited: false },
      { provider: "google", resetInSeconds: 20, isLimited: false },
    ];

    const res = router.resolveResetWindow(resetStates);
    expect(res.strategy).toBe("reset-window");
    expect(res.provider).toBe("openai"); // resets in 5s and not limited
    expect(res.selectedModelId).toBe("openai/gpt-4o");
  });
});
