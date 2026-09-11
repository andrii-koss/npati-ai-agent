export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CostCalculationResult {
  promptCostUsd: number;
  completionCostUsd: number;
  totalCostUsd: number;
  formattedUsd: string;
}

// Pricing per 1,000,000 tokens (USD)
const MODEL_PRICING: Record<string, { promptPerM: number; completionPerM: number }> = {
  "openai/gpt-4o": { promptPerM: 2.5, completionPerM: 10.0 },
  "openai/gpt-4o-mini": { promptPerM: 0.15, completionPerM: 0.6 },
  "anthropic/claude-3-5-sonnet": { promptPerM: 3.0, completionPerM: 15.0 },
  "anthropic/claude-3-5-haiku": { promptPerM: 0.8, completionPerM: 4.0 },
  "google/gemini-2.0-flash": { promptPerM: 0.1, completionPerM: 0.4 },
  "text-embedding-3-small": { promptPerM: 0.02, completionPerM: 0.0 },
  default: { promptPerM: 1.0, completionPerM: 3.0 },
};

export class CostTelemetry {
  static calculate(modelId: string, usage: TokenUsage): CostCalculationResult {
    const key = Object.keys(MODEL_PRICING).find((k) => modelId.toLowerCase().includes(k)) || "default";
    const pricing = MODEL_PRICING[key] || MODEL_PRICING.default!;

    const promptCost = (usage.promptTokens / 1_000_000) * pricing.promptPerM;
    const completionCost = (usage.completionTokens / 1_000_000) * pricing.completionPerM;
    const total = promptCost + completionCost;

    return {
      promptCostUsd: Number(promptCost.toFixed(6)),
      completionCostUsd: Number(completionCost.toFixed(6)),
      totalCostUsd: Number(total.toFixed(6)),
      formattedUsd: `$${total.toFixed(4)}`,
    };
  }

  static getTelemetryHeaders(
    modelId: string,
    usage: TokenUsage
  ): Record<string, string> {
    const cost = this.calculate(modelId, usage);
    return {
      "X-NPATI-Model": modelId,
      "X-NPATI-Tokens-Prompt": String(usage.promptTokens),
      "X-NPATI-Tokens-Completion": String(usage.completionTokens),
      "X-NPATI-Tokens-Total": String(usage.totalTokens),
      "X-NPATI-Cost-USD": cost.totalCostUsd.toString(),
    };
  }

  static checkBudgetQuota(currentSpendUsd: number, budgetLimitUsd?: number): { allowed: boolean; remainingUsd?: number } {
    if (!budgetLimitUsd || budgetLimitUsd <= 0) return { allowed: true };
    const remaining = Math.max(0, budgetLimitUsd - currentSpendUsd);
    return {
      allowed: currentSpendUsd < budgetLimitUsd,
      remainingUsd: Number(remaining.toFixed(4)),
    };
  }

  static getRunTelemetryHeaders(input: {
    requestId: string;
    modelId?: string;
    strategy?: string;
    provider?: string;
    totalTokens?: number;
    totalCostUsd?: number;
    latencyMs?: number;
    cacheHit?: boolean;
    cachedTokens?: number;
    cacheSavingsUsd?: number;
    failoverCount?: number;
    costSource?: string;
  }): Record<string, string> {
    return {
      "X-NPATI-Request-ID": input.requestId,
      "X-NPATI-Selected-Model": input.modelId ?? "unknown",
      "X-NPATI-Selected-Provider": input.provider ?? "unknown",
      "X-NPATI-Routing-Strategy": input.strategy ?? "unknown",
      "X-NPATI-Tokens-Total": String(input.totalTokens ?? 0),
      "X-NPATI-Cost-USD": String(input.totalCostUsd ?? 0),
      "X-NPATI-Cost-Source": input.costSource ?? "estimated",
      "X-NPATI-Latency-MS": String(input.latencyMs ?? 0),
      "X-NPATI-Cache-Hit": input.cacheHit ? "true" : "false",
      "X-NPATI-Cached-Tokens": String(input.cachedTokens ?? 0),
      "X-NPATI-Cache-Savings-USD": String(input.cacheSavingsUsd ?? 0),
      "X-NPATI-Failover-Count": String(input.failoverCount ?? 0),
    };
  }
}
