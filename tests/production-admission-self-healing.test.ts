import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, ChatResult } from "@npati/omniroute-adapter";
import { AdaptiveAdmissionQueue, AdmissionError } from "../apps/agent-api/src/resilience-admission-queue";
import { createProductionResilientAIEngine, InferenceRouteFailure } from "../apps/agent-api/src/production-resilient-ai-engine";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function fakeEngine(overrides: Partial<AIEngine>): AIEngine {
  return {
    chat: async (request: ChatRequest): Promise<ChatResult> => ({ content: String(request.model), model: request.model }),
    stream: async function* (request: ChatRequest) { yield String(request.model); },
    listModels: async () => [],
    getModel: async () => undefined,
    executeTool: async () => ({}),
    searchMemory: async () => [],
    saveMemory: async () => undefined,
    getCapabilities: async () => [],
    healthCheck: async () => ({ status: "ok", service: "fake", timestamp: new Date().toISOString() }),
    ...overrides,
  };
}

describe("Production adaptive admission and self-healing", () => {
  it("enforces concurrency, orders queued work by priority and hard-bounds every tier", async () => {
    const queue = new AdaptiveAdmissionQueue({ maxConcurrent: 1, maxQueueLength: 3, freeShedThreshold: 1 });
    const gate = deferred();
    const order: string[] = [];
    const active = queue.enqueue(async () => { await gate.promise; order.push("active"); return "active"; }, "pro");
    const free = queue.enqueue(async () => { order.push("free"); return "free"; }, "free");
    const pro = queue.enqueue(async () => { order.push("pro"); return "pro"; }, "pro");
    const enterprise = queue.enqueue(async () => { order.push("enterprise"); return "enterprise"; }, "enterprise");
    await expect(queue.enqueue(async () => "overflow", "critical-orchestration")).rejects.toMatchObject({
      code: "ADMISSION_QUEUE_FULL",
    });
    gate.release();
    await Promise.all([active, free, pro, enterprise]);
    expect(order).toEqual(["active", "enterprise", "pro", "free"]);
    expect(queue.snapshot()).toMatchObject({ inFlight: 0, queued: 0, admitted: 4, completed: 4, shed: 1 });
  });

  it("cancels and times out queued requests without executing them", async () => {
    const queue = new AdaptiveAdmissionQueue({ maxConcurrent: 1, maxQueueLength: 4 });
    const gate = deferred();
    const active = queue.enqueue(async () => { await gate.promise; }, "pro");
    let executed = false;
    const controller = new AbortController();
    const cancelled = queue.enqueue(async () => { executed = true; }, "pro", { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(AdmissionError);
    await expect(queue.enqueue(async () => { executed = true; }, "pro", { queueTimeoutMs: 10 })).rejects.toMatchObject({
      code: "ADMISSION_QUEUE_TIMEOUT",
    });
    expect(executed).toBe(false);
    gate.release();
    await active;
    expect(queue.snapshot().cancelled).toBe(2);
  });

  it("fails over only on retryable provider failures and records telemetry", async () => {
    const calls: string[] = [];
    const base = fakeEngine({
      chat: async (request) => {
        calls.push(request.model!);
        if (request.model === "broken/primary") throw new Error("OmniRoute chat failed with HTTP 503");
        return { content: "real fallback response", model: request.model };
      },
    });
    const resilient = createProductionResilientAIEngine(base, {
      queue: new AdaptiveAdmissionQueue({ maxConcurrent: 1, maxQueueLength: 2 }),
    });
    const result = await resilient.chat({
      model: "broken/primary",
      fallbackModel: "working/fallback",
      messages: [{ role: "user", content: "hello" }],
      admission: { tenantId: "tenant-a", tier: "pro" },
    });
    expect(calls).toEqual(["broken/primary", "working/fallback"]);
    expect(result).toMatchObject({
      content: "real fallback response",
      model: "working/fallback",
      telemetry: { failoverCount: 1, routingStrategy: "self-healing-fallback" },
    });
  });

  it("skips a model rejected with HTTP 401 and uses the next fallback", async () => {
    const calls: string[] = [];
    const base = fakeEngine({
      chat: async (request) => {
        calls.push(request.model!);
        if (request.model === "working/fallback") return { content: "recovered", model: request.model };
        throw new Error("OmniRoute chat failed with HTTP 401");
      },
    });
    const resilient = createProductionResilientAIEngine(base);
    await expect(resilient.chat({
      model: "bad/primary",
      fallbackModel: "working/fallback",
      messages: [{ role: "user", content: "hello" }],
    })).resolves.toMatchObject({ content: "recovered", model: "working/fallback" });
    expect(calls).toEqual(["bad/primary", "working/fallback"]);
  });

  it("streams through the production queue and falls back only before output starts", async () => {
    const calls: string[] = [];
    const base = fakeEngine({
      stream: async function* (request) {
        calls.push(request.model!);
        if (request.model === "broken/primary") throw new Error("HTTP 503 unavailable");
        yield "first";
        yield "second";
      },
    });
    const resilient = createProductionResilientAIEngine(base);
    const chunks: string[] = [];
    for await (const chunk of resilient.stream({
      model: "broken/primary",
      fallbackModel: "working/fallback",
      messages: [{ role: "user", content: "hello" }],
    })) chunks.push(chunk);
    expect(calls).toEqual(["broken/primary", "working/fallback"]);
    expect(chunks).toEqual(["first", "second"]);
  });

  it("retains the selected model failure when its fallback also fails", async () => {
    const base = fakeEngine({
      stream: async function* (request) {
        throw new Error(`OmniRoute stream failed with HTTP ${request.model === "ollama-cloud/gemma4:31b" ? 429 : 403}`);
      },
    });
    const resilient = createProductionResilientAIEngine(base);
    const consume = async () => {
      for await (const _chunk of resilient.stream({
        model: "ollama-cloud/gemma4:31b", fallbackModel: "auto", messages: [{ role: "user", content: "hello" }],
      })) { /* consume the stream */ }
    };
    await expect(consume()).rejects.toMatchObject({
      name: "InferenceRouteFailure",
      attempts: [
        { modelId: "ollama-cloud/gemma4:31b", httpStatus: 429 },
        { modelId: "auto", httpStatus: 403 },
      ],
    } satisfies Partial<InferenceRouteFailure>);
  });
});
