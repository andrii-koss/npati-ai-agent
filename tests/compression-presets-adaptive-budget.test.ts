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

  it("lists all available compression presets with descriptions and target ratios", () => {
    const presets = CompressionPresetManager.getAvailablePresets();
    expect(presets.length).toBe(5);
    const names = presets.map((p) => p.name);
    expect(names).toContain("minimal");
    expect(names).toContain("balanced");
    expect(names).toContain("extreme");
    expect(names).toContain("code-safe");
    expect(names).toContain("rag-optimized");
  });

  it("compresses conversation messages array preserving roles and structure", () => {
    const messages = [
      { role: "system", content: "You are an assistant. Please note that you must always be helpful." },
      { role: "user", content: "Can you help deploy?" },
    ];
    const res = CompressionPresetManager.applyPresetToMessages(messages, "balanced");
    expect(res.compressedMessages.length).toBe(2);
    expect(res.compressedMessages[0].role).toBe("system");
    expect(res.compressedMessages[0].content).not.toContain("Please note that");
    expect(res.tokensSaved).toBeGreaterThan(0);
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

  it("resolves model-aware context limits dynamically", () => {
    // 150k tokens on Gemini (1M context limit) -> healthy (15%), no action required
    const geminiRes = AdaptiveContextBudgetManager.evaluateBudget(150_000, undefined, "google/gemini-2.5-flash");
    expect(geminiRes.maxContextTokens).toBe(1_000_000);
    expect(geminiRes.actionRequired).toBe(false);
    expect(geminiRes.suggestedPreset).toBe("none");

    // 150k tokens on Claude (200k context limit) -> 75% -> balanced compression
    const claudeRes = AdaptiveContextBudgetManager.evaluateBudget(150_000, undefined, "anthropic/claude-3-7-sonnet");
    expect(claudeRes.maxContextTokens).toBe(200_000);
    expect(claudeRes.actionRequired).toBe(true);
    expect(claudeRes.suggestedPreset).toBe("balanced");

    // 110k tokens on GPT-4o (128k context limit) -> 86% -> extreme compression
    const gptRes = AdaptiveContextBudgetManager.evaluateBudget(110_000, undefined, "openai/gpt-4o");
    expect(gptRes.maxContextTokens).toBe(128_000);
    expect(gptRes.actionRequired).toBe(true);
    expect(gptRes.suggestedPreset).toBe("extreme");
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
