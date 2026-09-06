export interface LkgpRecord {
  key: string;
  modelId: string;
  provider: string;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  lastSuccessTimestamp: number;
  lastFailureTimestamp?: number;
  isHealthy: boolean;
}

export class LkgpStrategyManager {
  private readonly registry = new Map<string, LkgpRecord>();
  private readonly defaultModelId: string;
  private readonly defaultProvider: string;

  constructor(options: { defaultModelId?: string; defaultProvider?: string } = {}) {
    this.defaultModelId = options.defaultModelId ?? "openai/gpt-4o";
    this.defaultProvider = options.defaultProvider ?? "openai";
  }

  private getKey(companyId: string, taskType = "general"): string {
    return `${companyId}:${taskType.toLowerCase()}`;
  }

  /**
   * Record a successful LLM invocation to reinforce or promote LKGP
   */
  recordSuccess(companyId: string, taskType: string, modelId: string, provider: string): void {
    const key = this.getKey(companyId, taskType);
    const existing = this.registry.get(key);

    if (existing && existing.modelId === modelId) {
      existing.consecutiveSuccesses += 1;
      existing.consecutiveFailures = 0;
      existing.lastSuccessTimestamp = Date.now();
      existing.isHealthy = true;
      return;
    }

    // New candidate or different model: if existing is unhealthy or not set, update LKGP
    if (!existing || !existing.isHealthy) {
      this.registry.set(key, {
        key,
        modelId,
        provider,
        consecutiveSuccesses: 1,
        consecutiveFailures: 0,
        lastSuccessTimestamp: Date.now(),
        isHealthy: true,
      });
    }
  }

  /**
   * Record a failed invocation to downgrade LKGP health
   */
  recordFailure(companyId: string, taskType: string, modelId: string): void {
    const key = this.getKey(companyId, taskType);
    const existing = this.registry.get(key);

    if (existing && existing.modelId === modelId) {
      existing.consecutiveFailures += 1;
      existing.consecutiveSuccesses = 0;
      existing.lastFailureTimestamp = Date.now();

      // If 2 or more consecutive failures, mark unhealthy to trigger fallback
      if (existing.consecutiveFailures >= 2) {
        existing.isHealthy = false;
      }
    }
  }

  /**
   * Resolve model target using LKGP (Last Known Good Provider) fast-path
   */
  resolveLkgp(
    companyId: string,
    taskType = "general",
    fallbackModelId = "google/gemini-2.5-flash"
  ): {
    strategy: "lkgp";
    selectedModelId: string;
    provider: string;
    isCachedLkgp: boolean;
    reason: string;
  } {
    const key = this.getKey(companyId, taskType);
    const record = this.registry.get(key);

    if (record && record.isHealthy) {
      return {
        strategy: "lkgp",
        selectedModelId: record.modelId,
        provider: record.provider,
        isCachedLkgp: true,
        reason: `LKGP fast-path resolved to '${record.modelId}' (${record.consecutiveSuccesses} consecutive successes).`,
      };
    }

    // Fallback if no healthy LKGP exists
    return {
      strategy: "lkgp",
      selectedModelId: fallbackModelId,
      provider: fallbackModelId.split("/")[0] || this.defaultProvider,
      isCachedLkgp: false,
      reason: record
        ? `Previous LKGP '${record.modelId}' degraded (${record.consecutiveFailures} failures). Falling back to '${fallbackModelId}'.`
        : `No prior LKGP recorded for category '${taskType}'. Using default fallback '${fallbackModelId}'.`,
    };
  }
}
