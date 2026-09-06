import { describe, expect, it } from "vitest";
import { AutoComboRouter, DEFAULT_MODEL_CANDIDATES } from "../apps/agent-api/src/auto-combo-profiles";

describe("Auto-Combo Profiles Routing (AutoComboRouter)", () => {
  it("resolves auto/coding to top coding model with deterministic temperature", () => {
    const router = new AutoComboRouter();
    const result = router.resolve("auto/coding");

    expect(result.profile).toBe("auto/coding");
    expect(result.selectedModelId).toBe("anthropic/claude-3-7-sonnet");
    expect(result.provider).toBe("anthropic");
    expect(result.temperature).toBe(0.1);
    expect(result.fallbackModelId).toBeDefined();
    expect(result.reason).toContain("coding capability score");
  });

  it("resolves auto/fast to lowest latency model under 300ms", () => {
    const router = new AutoComboRouter();
    const result = router.resolve("auto/fast");

    expect(result.profile).toBe("auto/fast");
    expect(result.selectedModelId).toBe("google/gemini-2.5-flash");
    expect(result.provider).toBe("google");
    expect(result.reason).toContain("220ms");
  });

  it("resolves auto/cheap to lowest blended cost model", () => {
    const router = new AutoComboRouter();
    const result = router.resolve("auto/cheap");

    expect(result.profile).toBe("auto/cheap");
    expect(result.selectedModelId).toBe("google/gemini-2.5-flash");
    expect(result.reason).toContain("minimum USD cost");
  });

  it("gracefully falls back when top preferred provider is unavailable", () => {
    // Clone candidates and make Claude 3.7 Sonnet unavailable
    const candidates = DEFAULT_MODEL_CANDIDATES.map((c) =>
      c.id === "anthropic/claude-3-7-sonnet" ? { ...c, isAvailable: false } : { ...c }
    );

    const router = new AutoComboRouter(candidates);
    const result = router.resolve("auto/coding");

    // Next best coding model is DeepSeek Coder
    expect(result.selectedModelId).toBe("deepseek/deepseek-coder");
    expect(result.provider).toBe("deepseek");
  });
});
