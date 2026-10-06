import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, ChatResult } from "@npati/omniroute-adapter";
import { createProductionResilientAIEngine, NoEligibleProviderError } from "../apps/agent-api/src/production-resilient-ai-engine";

function engineWithRecorder(): { engine: AIEngine; attempted: string[] } {
  const attempted: string[] = [];
  const engine = {
    async chat(request: ChatRequest): Promise<ChatResult> {
      attempted.push(request.model ?? "auto");
      return { message: { role: "assistant", content: "ok" }, model: request.model, usage: {} } as ChatResult;
    },
    async *stream(request: ChatRequest) {
      attempted.push(request.model ?? "auto");
      yield "ok";
    },
  } as unknown as AIEngine;
  return { engine, attempted };
}

describe("security-gate: C5b routing eligibility", () => {
  it("skips a fallback model the policy forbids and uses the eligible one", async () => {
    const { engine, attempted } = engineWithRecorder();
    const resilient = createProductionResilientAIEngine(engine, {
      isModelEligible: (model) => (model.includes("forbidden") ? { eligible: false, reason: "classification_exceeds:public" } : { eligible: true }),
    });
    await resilient.chat({ messages: [{ role: "user", content: "hi" }], model: "allowed/model-a", fallbackModel: "forbidden/model-b" });
    expect(attempted).toEqual(["allowed/model-a"]);
    expect(attempted).not.toContain("forbidden/model-b");
  });

  it("stops the route with no_eligible_provider when nothing passes the gate", async () => {
    const { engine, attempted } = engineWithRecorder();
    const resilient = createProductionResilientAIEngine(engine, {
      isModelEligible: () => ({ eligible: false, reason: "policy_stale" }),
    });
    await expect(
      resilient.chat({ messages: [{ role: "user", content: "hi" }], model: "hosted/model-a", fallbackModel: "hosted/model-b" }),
    ).rejects.toThrowError(NoEligibleProviderError);
    expect(attempted).toHaveLength(0);
  });

  it("reports the rejected models and reasons so the run can explain the stop", async () => {
    const { engine } = engineWithRecorder();
    const resilient = createProductionResilientAIEngine(engine, {
      isModelEligible: (model) => ({ eligible: false, reason: model === "hosted/model-a" ? "classification_exceeds:public" : "policy_stale" }),
    });
    await resilient
      .chat({ messages: [{ role: "user", content: "hi" }], model: "hosted/model-a", fallbackModel: "hosted/model-b" })
      .then(
        () => {
          throw new Error("expected the route to fail");
        },
        (error: NoEligibleProviderError) => {
          expect(error.code).toBe("no_eligible_provider");
          expect(error.retryable).toBe(false);
          expect(error.rejected).toEqual([
            { model: "hosted/model-a", reason: "classification_exceeds:public" },
            { model: "hosted/model-b", reason: "policy_stale" },
          ]);
          expect(error.message).toContain("no_eligible_provider");
        },
      );
  });

  it("applies the same gate to the streaming path", async () => {
    const { engine, attempted } = engineWithRecorder();
    const resilient = createProductionResilientAIEngine(engine, {
      isModelEligible: (model) => (model === "forbidden/model-b" ? { eligible: false, reason: "policy_stale" } : { eligible: true }),
    });
    const chunks: string[] = [];
    for await (const chunk of resilient.stream({ messages: [{ role: "user", content: "hi" }], model: "allowed/model-a", fallbackModel: "forbidden/model-b" })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["ok"]);
    expect(attempted).toEqual(["allowed/model-a"]);
  });

  it("keeps the previous behaviour when no eligibility gate is configured", async () => {
    const { engine, attempted } = engineWithRecorder();
    const resilient = createProductionResilientAIEngine(engine, {});
    await resilient.chat({ messages: [{ role: "user", content: "hi" }], model: "plain/model-a" });
    expect(attempted).toEqual(["plain/model-a"]);
  });
});
