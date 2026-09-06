import { describe, expect, it } from "vitest";
import {
  CompressionPresetManager,
  AdaptiveContextBudgetManager,
  PerRequestCompressionOverrideManager,
} from "../apps/agent-api/src/context-compression-presets-and-budget";

describe("Compression Preset Manager (Compression Presets)", () => {
  it("applies balanced, extreme, and code-safe compression presets", () => {
    const raw = `
    Please note that in order to deploy, follow instructions:

    \`\`\`bash
    npm run build && npm start
    \`\`\`

    It is important to remember that this process is very critical and basically necessary.
    `;

    // Balanced
    const balanced = CompressionPresetManager.applyPreset(raw, "balanced");
    expect(balanced.preset).toBe("balanced");
    expect(balanced.compressedText).not.toContain("Please note that");
    expect(balanced.compressedText).toContain("npm run build && npm start");

    // Extreme
    const extreme = CompressionPresetManager.applyPreset(raw, "extreme");
    expect(extreme.preset).toBe("extreme");
    expect(extreme.tokensSaved).toBeGreaterThanOrEqual(balanced.tokensSaved);

    // Code-Safe
    const codeSafe = CompressionPresetManager.applyPreset(raw, "code-safe");
    expect(codeSafe.preset).toBe("code-safe");
    expect(codeSafe.compressedText).toContain("```bash\n    npm run build && npm start\n    ```");
  });
});

describe("Adaptive Context Budget Manager (Adaptive Context Budget)", () => {
  it("recommends no compression for healthy ratios, balanced for medium, and extreme for critical", () => {
    // 40% usage -> healthy, none
    const low = AdaptiveContextBudgetManager.evaluateBudget(40_000, 100_000);
    expect(low.actionRequired).toBe(false);
    expect(low.suggestedPreset).toBe("none");

    // 70% usage -> balanced
    const medium = AdaptiveContextBudgetManager.evaluateBudget(70_000, 100_000);
    expect(medium.actionRequired).toBe(true);
    expect(medium.suggestedPreset).toBe("balanced");

    // 90% usage -> extreme
    const critical = AdaptiveContextBudgetManager.evaluateBudget(90_000, 100_000);
    expect(critical.actionRequired).toBe(true);
    expect(critical.suggestedPreset).toBe("extreme");
  });
});

describe("Per-Request Compression Override (Per-Request Override)", () => {
  it("honors header bypass and body overrides", () => {
    // Header bypass
    const bypassRes = PerRequestCompressionOverrideManager.resolveOverride({
      "x-npati-compression": "bypass",
    });
    expect(bypassRes.bypass).toBe(true);
    expect(bypassRes.enabled).toBe(false);

    // Header preset
    const presetRes = PerRequestCompressionOverrideManager.resolveOverride({
      "x-npati-compression": "extreme",
    });
    expect(presetRes.bypass).toBe(false);
    expect(presetRes.preset).toBe("extreme");

    // Body override
    const bodyRes = PerRequestCompressionOverrideManager.resolveOverride(
      {},
      { preset: "rag-optimized", maxBudgetTokens: 4000 }
    );
    expect(bodyRes.preset).toBe("rag-optimized");
    expect(bodyRes.maxBudgetTokens).toBe(4000);
  });
});
