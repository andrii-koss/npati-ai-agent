import { describe, expect, it } from "vitest";
import { ActionSensitiveMemoryEngine } from "../apps/agent-api/src/action-sensitive-memory";
import {
  AnthropicMessagesHandler,
  GeminiGenerateContentHandler,
} from "../apps/agent-api/src/compat-api-endpoints";

describe("Action-Sensitive Memory Engine (ActionSensitiveMemoryEngine)", () => {
  it("injects specialized memory rules when matching actions are planned", () => {
    const engine = new ActionSensitiveMemoryEngine();
    const companyId = "comp-act-1";

    engine.registerRule({
      companyId,
      actionName: "stripe_charge",
      title: "PCI-DSS Payment Compliance",
      instruction: "Never log raw credit card numbers or CVC in telemetry.",
      riskLevel: "high",
    });

    engine.registerRule({
      companyId,
      actionName: "kubernetes_deploy",
      title: "Cluster Deploy Rule",
      instruction: "Always require canary deployment with 10% traffic split.",
      riskLevel: "medium",
    });

    // Case 1: Matching Stripe action
    const stripeInjection = engine.injectActionMemories(
      companyId,
      "You are a billing agent.",
      ["stripe_charge_customer"]
    );

    expect(stripeInjection.injectedRulesCount).toBe(1);
    expect(stripeInjection.prompt).toContain("<action_sensitive_memory>");
    expect(stripeInjection.prompt).toContain("PCI-DSS Payment Compliance");
    expect(stripeInjection.prompt).not.toContain("Cluster Deploy Rule");

    // Case 2: No matching actions
    const noActionInjection = engine.injectActionMemories(
      companyId,
      "You are a weather agent.",
      ["get_weather_forecast"]
    );

    expect(noActionInjection.injectedRulesCount).toBe(0);
    expect(noActionInjection.prompt).toBe("You are a weather agent.");
  });
});

describe("Anthropic Messages API Handler (AnthropicMessagesHandler)", () => {
  it("processes /v1/messages request and returns compliant Anthropic envelope", async () => {
    const response = await AnthropicMessagesHandler.handleRequest({
      model: "claude-3-7-sonnet",
      system: "You are a code reviewer.",
      messages: [{ role: "user", content: "Check this TypeScript function." }],
    });

    expect(response.type).toBe("message");
    expect(response.role).toBe("assistant");
    expect(response.model).toBe("claude-3-7-sonnet");
    expect(response.content[0].text).toContain("Anthropic response");
    expect(response.usage.input_tokens).toBeGreaterThan(0);
  });
});

describe("Google Gemini API Handler (GeminiGenerateContentHandler)", () => {
  it("processes :generateContent request and returns compliant Gemini envelope", async () => {
    const response = await GeminiGenerateContentHandler.handleRequest("gemini-2.5-flash", {
      contents: [
        {
          role: "user",
          parts: [{ text: "Explain quantum computing in 2 sentences." }],
        },
      ],
    });

    expect(response.candidates.length).toBe(1);
    expect(response.candidates[0].content.role).toBe("model");
    expect(response.candidates[0].content.parts[0].text).toContain("Gemini response");
    expect(response.usageMetadata.totalTokenCount).toBeGreaterThan(0);
  });
});
