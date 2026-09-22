import type { AIEngine, ChatRequest, ChatResult } from "@npati/omniroute-adapter";
import { AdaptiveAdmissionQueue, SelfHealingAutoCombo, SelfHealingExhaustedError, type PriorityTier } from "./resilience-admission-queue";

function providerFromModel(model: string) {
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(0, separator) : "npati-auto";
}

export interface InferenceRouteAttempt {
  modelId: string;
  httpStatus?: number;
}

export class InferenceRouteFailure extends Error {
  constructor(readonly attempts: InferenceRouteAttempt[], cause: unknown) {
    super(`AI inference failed for ${attempts.map((attempt) => `${attempt.modelId}${attempt.httpStatus ? ` (HTTP ${attempt.httpStatus})` : ""}`).join(", then ")}`, { cause });
    this.name = "InferenceRouteFailure";
  }
}

function failedAttempt(modelId: string, error: unknown): InferenceRouteAttempt {
  const message = error instanceof Error ? error.message : String(error);
  const status = /\bHTTP\s+(\d{3})\b/i.exec(message);
  return { modelId, httpStatus: status ? Number(status[1]) : undefined };
}

export function isRetryableInferenceFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (?:404|408|409|429|5\d\d)|quota|rate.?limit|timeout|timed out|unavailable|overload|model.*(?:missing|disabled|locked)|ECONNRESET|ECONNREFUSED|fetch failed/i.test(message);
}

class AsyncChunkChannel {
  private chunks: string[] = [];
  private waiters: Array<() => void> = [];
  private ended = false;
  private failure: unknown;

  push(chunk: string) {
    this.chunks.push(chunk);
    this.wake();
  }

  close() {
    this.ended = true;
    this.wake();
  }

  fail(error: unknown) {
    this.failure = error;
    this.ended = true;
    this.wake();
  }

  private wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async *read(): AsyncIterable<string> {
    while (true) {
      if (this.chunks.length) {
        yield this.chunks.shift()!;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

export interface ResilientEngineOptions {
  queue?: AdaptiveAdmissionQueue;
  defaultTier?: PriorityTier;
  queueTimeoutMs?: number;
}

export function createProductionResilientAIEngine(base: AIEngine, options: ResilientEngineOptions = {}): AIEngine {
  const queue = options.queue ?? new AdaptiveAdmissionQueue();
  const defaultTier = options.defaultTier ?? "pro";
  const defaultQueueTimeoutMs = options.queueTimeoutMs ?? 30_000;

  const healChat = async (request: ChatRequest): Promise<ChatResult> => {
    const models = [
      request.model ?? "auto",
      request.fallbackModel,
      ...(request.model && request.model !== "auto" && !request.fallbackModel ? ["auto"] : []),
    ]
      .filter((model): model is string => Boolean(model))
      .filter((model, index, values) => values.indexOf(model) === index);
    const startedAt = Date.now();
    const healed = await SelfHealingAutoCombo.executeWithHealing(
      models.map((model) => ({
        modelId: model,
        provider: providerFromModel(model),
        execute: () => base.chat({ ...request, model, fallbackModel: undefined }),
      })),
      { shouldRetry: isRetryableInferenceFailure, signal: request.signal },
    ).catch((error: unknown) => {
      if (request.signal?.aborted || error instanceof SelfHealingExhaustedError) throw error;
      throw new InferenceRouteFailure([failedAttempt(models[0] ?? "auto", error)], error);
    });
    const telemetry = healed.result.telemetry;
    return {
      ...healed.result,
      telemetry: {
        requestId: telemetry?.requestId,
        provider: telemetry?.provider ?? providerFromModel(healed.finalModelId),
        routingStrategy: telemetry?.routingStrategy ?? (healed.wasHealed ? "self-healing-fallback" : "direct"),
        latencyMs: Math.max(telemetry?.latencyMs ?? 0, Date.now() - startedAt),
        costUsd: telemetry?.costUsd,
        costSource: telemetry?.costSource,
        cacheHit: telemetry?.cacheHit ?? false,
        cacheSavingsUsd: telemetry?.cacheSavingsUsd,
        failoverCount: (telemetry?.failoverCount ?? 0) + (healed.wasHealed ? 1 : 0),
      },
    };
  };

  const overrides: Pick<AIEngine, "chat" | "stream"> = {
    chat(request) {
      const admission = request.admission;
      return queue.enqueue(
        () => healChat(request),
        admission?.tier ?? defaultTier,
        { signal: request.signal, queueTimeoutMs: admission?.queueTimeoutMs ?? defaultQueueTimeoutMs, tenantId: admission?.tenantId },
      );
    },

    async *stream(request) {
      const channel = new AsyncChunkChannel();
      const admission = request.admission;
      const completion = queue.enqueue(async () => {
        const models = [
          request.model ?? "auto",
          request.fallbackModel,
          ...(request.model && request.model !== "auto" && !request.fallbackModel ? ["auto"] : []),
        ]
          .filter((model): model is string => Boolean(model))
          .filter((model, index, values) => values.indexOf(model) === index);
        let emitted = false;
        let lastError: unknown;
        const failedRoutes: InferenceRouteAttempt[] = [];
        try {
          for (let index = 0; index < models.length; index += 1) {
            const model = models[index]!;
            try {
              for await (const chunk of base.stream({ ...request, model, fallbackModel: undefined })) {
                emitted = true;
                channel.push(chunk);
              }
              channel.close();
              return;
            } catch (error) {
              lastError = error;
              failedRoutes.push(failedAttempt(model, error));
              if (request.signal?.aborted) throw request.signal.reason ?? error;
              if (emitted || index === models.length - 1 || !isRetryableInferenceFailure(error)) {
                throw new InferenceRouteFailure(failedRoutes, error);
              }
            }
          }
          throw lastError ?? new Error("SELF_HEALING_EXHAUSTED");
        } catch (error) {
          channel.fail(error);
          throw error;
        }
      }, admission?.tier ?? defaultTier, {
        signal: request.signal,
        queueTimeoutMs: admission?.queueTimeoutMs ?? defaultQueueTimeoutMs,
        tenantId: admission?.tenantId,
      });
      completion.catch((error) => channel.fail(error));
      yield* channel.read();
      await completion;
    },
  };

  return new Proxy(base, {
    get(target, property) {
      if (property === "chat") return overrides.chat;
      if (property === "stream") return overrides.stream;
      if (property === "admissionQueue") return queue;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
