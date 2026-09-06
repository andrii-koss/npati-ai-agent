import { describe, expect, it } from "vitest";
import {
  A2ACapabilitiesRegistry,
  AgentEvaluationFramework,
  WebhookRetryDeliveryEngine,
} from "../apps/agent-api/src/evaluation-and-webhook-retries";

describe("A2A Capabilities Registry (A2ACapabilitiesRegistry)", () => {
  it("registers and lists agent capability manifests", () => {
    const registry = new A2ACapabilitiesRegistry();

    registry.registerManifest({
      agentId: "agent-multimodal-1",
      protocolVersion: "1.0.0",
      modalities: ["text", "image"],
      maxContextTokens: 128000,
      supportedTools: ["ocr", "image_generation", "web_search"],
      supportedInputFormats: ["json", "markdown"],
      supportedSchemas: ["anthropic_v1", "openai_v1"],
    });

    const manifest = registry.getCapabilities("agent-multimodal-1");
    expect(manifest).not.toBeNull();
    expect(manifest?.modalities).toContain("image");
    expect(manifest?.supportedTools).toContain("ocr");
  });
});

describe("Agent Evaluation Framework (AgentEvaluationFramework)", () => {
  it("evaluates response against JSON format and required instructions", () => {
    const validJson = JSON.stringify({ summary: "Quarterly earnings increased by 15%", status: "success" });
    const result = AgentEvaluationFramework.evaluate(
      "Generate a JSON summary with earnings",
      validJson,
      {
        checkJsonFormat: true,
        requiredSubstrings: ["earnings", "15%"],
        checkSafety: true,
      }
    );

    expect(result.passed).toBe(true);
    expect(result.overallScore).toBe(1.0);
    expect(result.metrics.formatCompliance).toBe(1.0);
    expect(result.metrics.instructionFollowing).toBe(1.0);
  });

  it("penalizes invalid JSON and missing keywords", () => {
    const invalidOutput = "Here is the summary without JSON format.";
    const result = AgentEvaluationFramework.evaluate(
      "Generate a JSON summary with metrics",
      invalidOutput,
      {
        checkJsonFormat: true,
        requiredSubstrings: ["revenue", "growth"],
      }
    );

    expect(result.passed).toBe(false);
    expect(result.metrics.formatCompliance).toBe(0.0);
    expect(result.metrics.instructionFollowing).toBe(0.0);
  });
});

describe("Webhook Retry & DLQ Engine (WebhookRetryDeliveryEngine)", () => {
  it("retries failures and sends to Dead Letter Queue (DLQ), then replays successfully", async () => {
    const engine = new WebhookRetryDeliveryEngine();
    let attemptCounter = 0;

    const mockSenderFailThenPass = async () => {
      attemptCounter++;
      if (attemptCounter <= 3) {
        return false; // Fail first 3 attempts
      }
      return true; // Pass on replay
    };

    const payload = {
      id: "evt-99",
      companyId: "comp-dlq-1",
      url: "https://api.partner.com/webhooks",
      eventType: "order.created",
      data: { orderId: "ord-500", total: 120 },
    };

    // First run with 3 retries will fail and push to DLQ
    const res = await engine.dispatchWithRetry(payload, mockSenderFailThenPass, { maxRetries: 3 });
    expect(res.success).toBe(false);
    expect(res.attempts).toBe(3);
    expect(res.dlqEntry).toBeDefined();

    const dlqId = res.dlqEntry!.dlqId;
    const dlqItem = engine.getDlqItem(dlqId);
    expect(dlqItem).not.toBeNull();

    // Replay from DLQ
    const replayOk = await engine.replayDlq(dlqId, mockSenderFailThenPass);
    expect(replayOk).toBe(true);
    expect(engine.getDlqItem(dlqId)).toBeNull(); // Cleaned up from DLQ
  });
});
