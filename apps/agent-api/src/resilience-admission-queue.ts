import { AsyncResource } from "node:async_hooks";
export type PriorityTier = "critical-orchestration" | "enterprise" | "pro" | "free";

export type AdmissionErrorCode = "ADMISSION_QUEUE_FULL" | "ADMISSION_QUEUE_SHED" | "ADMISSION_QUEUE_TIMEOUT" | "ADMISSION_CANCELLED";

export class AdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode, message: string, readonly retryAfterMs = 1_000) {
    super(`${code}: ${message}`);
    this.name = "AdmissionError";
  }
}

export interface AdmissionOptions {
  signal?: AbortSignal;
  queueTimeoutMs?: number;
  tenantId?: string;
}

export interface QueuedTask<T = unknown> {
  id: string;
  tier: PriorityTier;
  tenantId: string;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  signal?: AbortSignal;
  queueTimeout?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
}

export interface AdmissionQueueSnapshot {
  maxConcurrent: number;
  maxConcurrentPerTenant: number;
  maxQueueLength: number;
  inFlight: number;
  queued: number;
  admitted: number;
  completed: number;
  failed: number;
  cancelled: number;
  shed: number;
  queuedByTier: Record<PriorityTier, number>;
  inFlightByTenant: Record<string, number>;
}

const tierWeights: Record<PriorityTier, number> = {
  "critical-orchestration": 4,
  enterprise: 3,
  pro: 2,
  free: 1,
};

export class AdaptiveAdmissionQueue {
  private readonly maxConcurrent: number;
  private readonly maxConcurrentPerTenant: number;
  private readonly maxQueueLength: number;
  private readonly freeShedThreshold: number;
  private activeCount = 0;
  private readonly inFlightByTenant = new Map<string, number>();
  private readonly queue: QueuedTask[] = [];
  private admitted = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private shed = 0;

  constructor(options: { maxConcurrent?: number; maxConcurrentPerTenant?: number; maxQueueLength?: number; freeShedThreshold?: number } = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 10);
    this.maxConcurrentPerTenant = Math.max(1, options.maxConcurrentPerTenant ?? Math.max(1, Math.floor(this.maxConcurrent / 2)));
    this.maxQueueLength = Math.max(1, options.maxQueueLength ?? 100);
    this.freeShedThreshold = Math.min(1, Math.max(0, options.freeShedThreshold ?? 0.75));
  }

  get queueLength() { return this.queue.length; }
  get inFlightCount() { return this.activeCount; }
  get inFlightTenants() { return new Map(this.inFlightByTenant); }

  snapshot(): AdmissionQueueSnapshot {
    const queuedByTier: Record<PriorityTier, number> = { "critical-orchestration": 0, enterprise: 0, pro: 0, free: 0 };
    for (const item of this.queue) queuedByTier[item.tier] += 1;
    const inFlightByTenant: Record<string, number> = {};
    for (const [tenant, count] of this.inFlightByTenant.entries()) {
      inFlightByTenant[tenant] = count;
    }
    return {
      maxConcurrent: this.maxConcurrent,
      maxConcurrentPerTenant: this.maxConcurrentPerTenant,
      maxQueueLength: this.maxQueueLength,
      inFlight: this.activeCount,
      queued: this.queue.length,
      admitted: this.admitted,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      shed: this.shed,
      queuedByTier,
      inFlightByTenant,
    };
  }

  async enqueue<T>(task: () => Promise<T>, tier: PriorityTier = "pro", options: AdmissionOptions = {}): Promise<T> {
    if (options.signal?.aborted) throw new AdmissionError("ADMISSION_CANCELLED", "Request was cancelled before admission", 0);
    const saturation = this.queue.length / this.maxQueueLength;
    if (tier === "free" && saturation >= this.freeShedThreshold && this.activeCount >= this.maxConcurrent) {
      this.shed += 1;
      throw new AdmissionError("ADMISSION_QUEUE_SHED", "System is at peak capacity. Free tier request rejected.", 5_000);
    }
    if (this.queue.length >= this.maxQueueLength) {
      this.shed += 1;
      throw new AdmissionError("ADMISSION_QUEUE_FULL", "Admission queue is full. Retry later.", 5_000);
    }

    this.admitted += 1;
    return new Promise<T>((resolve, reject) => {
      const item: QueuedTask<T> = {
        id: crypto.randomUUID(),
        tier,
        tenantId: options.tenantId ?? "anonymous",
        // A queued task is started later from whichever task just finished (processNext runs in its .finally). Bound
        // here, it keeps the async context of the request that queued it — on a hosted installation that context
        // carries the account's own AI key, which must never be another account's.
        task: AsyncResource.bind(task),
        resolve,
        reject,
        enqueuedAt: Date.now(),
        signal: options.signal,
      };
      const removeQueued = (error: AdmissionError) => {
        const index = this.queue.indexOf(item as QueuedTask);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.cancelled += 1;
        this.cleanup(item);
        reject(error);
      };
      if (options.signal) {
        item.abortListener = () => removeQueued(new AdmissionError("ADMISSION_CANCELLED", "Request was cancelled while queued", 0));
        options.signal.addEventListener("abort", item.abortListener, { once: true });
      }
      if (options.queueTimeoutMs && options.queueTimeoutMs > 0) {
        item.queueTimeout = setTimeout(() => removeQueued(new AdmissionError("ADMISSION_QUEUE_TIMEOUT", "Request timed out while waiting for admission")), options.queueTimeoutMs);
      }

      const insertIndex = this.queue.findIndex((queued) => tierWeights[queued.tier] < tierWeights[tier]);
      if (insertIndex < 0) this.queue.push(item as QueuedTask);
      else this.queue.splice(insertIndex, 0, item as QueuedTask);
      this.processNext();
    });
  }

  private cleanup(item: QueuedTask<any>) {
    if (item.queueTimeout) clearTimeout(item.queueTimeout);
    if (item.signal && item.abortListener) item.signal.removeEventListener("abort", item.abortListener);
  }

  private processNext(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const candidateIndex = this.queue.findIndex((item) => {
        const activeForTenant = this.inFlightByTenant.get(item.tenantId) ?? 0;
        return activeForTenant < this.maxConcurrentPerTenant;
      });

      if (candidateIndex < 0) {
        // All pending items belong to tenants already at their concurrency cap
        break;
      }

      const item = this.queue.splice(candidateIndex, 1)[0]!;
      this.cleanup(item);
      if (item.signal?.aborted) {
        this.cancelled += 1;
        item.reject(new AdmissionError("ADMISSION_CANCELLED", "Request was cancelled before execution", 0));
        continue;
      }

      this.activeCount += 1;
      const tenantActive = this.inFlightByTenant.get(item.tenantId) ?? 0;
      this.inFlightByTenant.set(item.tenantId, tenantActive + 1);

      item.task()
        .then((result) => { this.completed += 1; item.resolve(result); })
        .catch((error) => { this.failed += 1; item.reject(error); })
        .finally(() => {
          this.activeCount -= 1;
          const currentTenantActive = this.inFlightByTenant.get(item.tenantId) ?? 1;
          if (currentTenantActive <= 1) {
            this.inFlightByTenant.delete(item.tenantId);
          } else {
            this.inFlightByTenant.set(item.tenantId, currentTenantActive - 1);
          }
          this.processNext();
        });
    }
  }
}

export interface SelfHealingAttempt {
  modelId: string;
  provider: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface SelfHealingExecutionResult<T> {
  result: T;
  wasHealed: boolean;
  attempts: SelfHealingAttempt[];
  finalModelId: string;
}

export class SelfHealingExhaustedError extends Error {
  constructor(readonly attempts: SelfHealingAttempt[]) {
    super(attempts.at(-1)?.error ?? ("SELF_HEALING_EXHAUSTED: All " + attempts.length + " candidate models failed"));
    this.name = "SelfHealingExhaustedError";
  }
}

export class SelfHealingAutoCombo {
  static async executeWithHealing<T>(
    candidates: Array<{ modelId: string; provider: string; execute: () => Promise<T> }>,
    options: { shouldRetry?: (error: unknown) => boolean; signal?: AbortSignal } = {},
  ): Promise<SelfHealingExecutionResult<T>> {
    if (!candidates.length) throw new SelfHealingExhaustedError([]);
    const attempts: SelfHealingAttempt[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Cancelled", "AbortError");
      const candidate = candidates[index]!;
      const startedAt = Date.now();
      try {
        const result = await candidate.execute();
        attempts.push({ modelId: candidate.modelId, provider: candidate.provider, durationMs: Date.now() - startedAt, success: true });
        return { result, wasHealed: index > 0, attempts, finalModelId: candidate.modelId };
      } catch (error) {
        attempts.push({ modelId: candidate.modelId, provider: candidate.provider, durationMs: Date.now() - startedAt, success: false, error: error instanceof Error ? error.message : String(error) });
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (index < candidates.length - 1 && options.shouldRetry && !options.shouldRetry(error)) throw error;
      }
    }
    throw new SelfHealingExhaustedError(attempts);
  }
}