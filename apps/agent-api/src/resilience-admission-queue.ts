export type PriorityTier = "enterprise" | "pro" | "free";

export interface QueuedTask<T = any> {
  id: string;
  tier: PriorityTier;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  enqueuedAt: number;
}

export class AdaptiveAdmissionQueue {
  private readonly maxConcurrent: number;
  private readonly maxQueueLength: number;
  private activeCount = 0;
  private readonly queue: QueuedTask[] = [];

  constructor(options: { maxConcurrent?: number; maxQueueLength?: number } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 10;
    this.maxQueueLength = options.maxQueueLength ?? 100;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get inFlightCount(): number {
    return this.activeCount;
  }

  /**
   * 1. Adaptive Admission Control: Priority-weighted enqueue
   */
  async enqueue<T>(task: () => Promise<T>, tier: PriorityTier = "pro"): Promise<T> {
    if (this.queue.length >= this.maxQueueLength) {
      // Shed load for free tier if overloaded
      if (tier === "free") {
        throw new Error("ADMISSION_QUEUE_SHED: System is at peak capacity. Free tier request rejected.");
      }
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueuedTask<T> = {
        id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        tier,
        task,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      };

      // Priority ordering: enterprise > pro > free
      const tierWeights: Record<PriorityTier, number> = { enterprise: 3, pro: 2, free: 1 };
      const insertIndex = this.queue.findIndex((q) => tierWeights[q.tier] < tierWeights[tier]);

      if (insertIndex === -1) {
        this.queue.push(item);
      } else {
        this.queue.splice(insertIndex, 0, item);
      }

      this.processNext();
    });
  }

  private processNext(): void {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.activeCount++;

    item
      .task()
      .then((res) => {
        item.resolve(res);
      })
      .catch((err) => {
        item.reject(err);
      })
      .finally(() => {
        this.activeCount--;
        this.processNext();
      });
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

export class SelfHealingAutoCombo {
  /**
   * 2. Self-Healing Auto-Combo: Transparent failover across candidate models
   */
  static async executeWithHealing<T>(
    candidates: Array<{ modelId: string; provider: string; execute: () => Promise<T> }>
  ): Promise<SelfHealingExecutionResult<T>> {
    const attempts: SelfHealingAttempt[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const start = Date.now();

      try {
        const result = await candidate.execute();
        const durationMs = Date.now() - start;

        attempts.push({
          modelId: candidate.modelId,
          provider: candidate.provider,
          durationMs,
          success: true,
        });

        return {
          result,
          wasHealed: i > 0, // Healed if it succeeded on fallback index > 0
          attempts,
          finalModelId: candidate.modelId,
        };
      } catch (err: any) {
        const durationMs = Date.now() - start;
        attempts.push({
          modelId: candidate.modelId,
          provider: candidate.provider,
          durationMs,
          success: false,
          error: err?.message || String(err),
        });
      }
    }

    throw new Error(
      `SELF_HEALING_EXHAUSTED: All ${candidates.length} candidate models failed.\nAttempts: ${JSON.stringify(attempts)}`
    );
  }
}
