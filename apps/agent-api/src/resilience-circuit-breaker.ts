export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface ProviderCircuitMetrics {
  provider: string;
  state: CircuitState;
  consecutiveFailures: number;
  currentCooldownMs: number;
  lastFailureTimestamp?: number;
  cooldownUntilTimestamp?: number;
  totalSuccesses: number;
  totalFailures: number;
}

export class ProviderCircuitBreaker {
  private readonly metrics = new Map<string, ProviderCircuitMetrics>();
  private readonly failureThreshold: number;
  private readonly initialCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly backoffMultiplier: number;

  constructor(options: {
    failureThreshold?: number;
    initialCooldownMs?: number;
    maxCooldownMs?: number;
    backoffMultiplier?: number;
  } = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.initialCooldownMs = options.initialCooldownMs ?? 10_000; // 10s
    this.maxCooldownMs = options.maxCooldownMs ?? 120_000;       // 2 min
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
  }

  private getMetrics(provider: string): ProviderCircuitMetrics {
    let m = this.metrics.get(provider.toLowerCase());
    if (!m) {
      m = {
        provider: provider.toLowerCase(),
        state: "CLOSED",
        consecutiveFailures: 0,
        currentCooldownMs: this.initialCooldownMs,
        totalSuccesses: 0,
        totalFailures: 0,
      };
      this.metrics.set(provider.toLowerCase(), m);
    }
    return m;
  }

  /**
   * 1. Circuit Breaker & Cooldown Check: Can a request be dispatched to this provider?
   */
  canAttempt(provider: string): { allowed: boolean; state: CircuitState; cooldownRemainingMs?: number } {
    const m = this.getMetrics(provider);
    const now = Date.now();

    if (m.state === "OPEN") {
      if (m.cooldownUntilTimestamp && now >= m.cooldownUntilTimestamp) {
        // Cooldown expired, transition to HALF_OPEN to test canary
        m.state = "HALF_OPEN";
        return { allowed: true, state: "HALF_OPEN" };
      }
      const remaining = Math.max(0, (m.cooldownUntilTimestamp || now) - now);
      return { allowed: false, state: "OPEN", cooldownRemainingMs: remaining };
    }

    return { allowed: true, state: m.state };
  }

  /**
   * Record success: resets circuit to CLOSED and resets cooldown
   */
  recordSuccess(provider: string): void {
    const m = this.getMetrics(provider);
    m.state = "CLOSED";
    m.consecutiveFailures = 0;
    m.currentCooldownMs = this.initialCooldownMs;
    m.cooldownUntilTimestamp = undefined;
    m.totalSuccesses++;
  }

  /**
   * Record failure: increments failure count and triggers exponential lockout cooldown
   */
  recordFailure(provider: string): void {
    const m = this.getMetrics(provider);
    m.consecutiveFailures++;
    m.totalFailures++;
    m.lastFailureTimestamp = Date.now();

    if (m.state === "HALF_OPEN" || m.consecutiveFailures >= this.failureThreshold) {
      m.state = "OPEN";
      m.cooldownUntilTimestamp = Date.now() + m.currentCooldownMs;

      // Exponentially increase cooldown for next trip up to maxCooldownMs
      m.currentCooldownMs = Math.min(this.maxCooldownMs, m.currentCooldownMs * this.backoffMultiplier);
    }
  }

  getSnapshot(provider: string): ProviderCircuitMetrics {
    return { ...this.getMetrics(provider) };
  }
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  shouldRetry?: (error: any) => boolean;
}

export interface RetryExecutionResult<T> {
  result: T;
  attemptsCount: number;
  totalDurationMs: number;
}

export class RetryBackoffRunner {
  /**
   * 3. Intelligent Exponential Jitter Backoff Retry Runner
   */
  static async executeWithRetry<T>(
    fn: (attempt: number) => Promise<T>,
    options: RetryOptions = {}
  ): Promise<RetryExecutionResult<T>> {
    const maxRetries = options.maxRetries ?? 3;
    const baseDelay = options.baseDelayMs ?? 100;
    const maxDelay = options.maxDelayMs ?? 3000;
    const useJitter = options.jitter ?? true;

    const startAll = Date.now();
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const result = await fn(attempt);
        return {
          result,
          attemptsCount: attempt,
          totalDurationMs: Date.now() - startAll,
        };
      } catch (err: any) {
        lastError = err;

        if (attempt > maxRetries) break;

        if (options.shouldRetry && !options.shouldRetry(err)) {
          break;
        }

        // Calculate exponential backoff with full jitter
        const expDelay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1));
        const actualDelay = useJitter ? Math.floor(Math.random() * expDelay) : expDelay;

        await new Promise((resolve) => setTimeout(resolve, actualDelay));
      }
    }

    throw lastError || new Error(`RETRY_EXHAUSTED: Failed after ${maxRetries} retries.`);
  }
}
