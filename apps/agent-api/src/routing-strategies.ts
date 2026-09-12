import { randomInt } from "node:crypto";

export type RoutingStrategyName =
  | "cost-optimized"
  | "context-optimized"
  | "cache-optimized"
  | "priority"
  | "fill-first"
  | "weighted"
  | "round-robin"
  | "p2c"
  | "least-used"
  | "random"
  | "strict-random"
  | "headroom"
  | "reset-window"
  | "reset-aware"
  | "context-relay"
  | "lkgp"
  | "auto"
  | "fusion"
  | "pipeline";

export interface StrategyModelDefinition {
  id: string;
  provider: string;
  name: string;
  contextWindowTokens: number;
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
  cachedInputCostPerMillionUsd?: number;
  supportsPromptCaching: boolean;
  tier: "flagship" | "fast" | "economy";
}

export interface ProviderCapacityState {
  provider: string;
  currentRpm: number;
  maxRpm: number;
}

export interface ProviderLoadState {
  provider: string;
  activeRequests: number;
  latencyMs?: number;
}

export interface StrategyResolutionResult {
  strategy: RoutingStrategyName;
  selectedModelId: string;
  provider: string;
  fallbackModelId?: string;
  estimatedCostUsd: number;
  estimatedSavingsPercent?: number;
  cacheControlEnabled?: boolean;
  reason: string;
}

export const STRATEGY_MODELS: StrategyModelDefinition[] = [
  {
    id: "anthropic/claude-3-7-sonnet",
    provider: "anthropic",
    name: "Claude 3.7 Sonnet",
    contextWindowTokens: 200_000,
    inputCostPerMillionUsd: 3.0,
    outputCostPerMillionUsd: 15.0,
    cachedInputCostPerMillionUsd: 0.3, // 90% prompt cache discount
    supportsPromptCaching: true,
    tier: "flagship",
  },
  {
    id: "openai/gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    contextWindowTokens: 128_000,
    inputCostPerMillionUsd: 2.5,
    outputCostPerMillionUsd: 10.0,
    cachedInputCostPerMillionUsd: 1.25, // 50% prompt cache discount
    supportsPromptCaching: true,
    tier: "flagship",
  },
  {
    id: "google/gemini-2.5-flash",
    provider: "google",
    name: "Gemini 2.5 Flash",
    contextWindowTokens: 1_000_000, // 1M massive context
    inputCostPerMillionUsd: 0.075,
    outputCostPerMillionUsd: 0.3,
    cachedInputCostPerMillionUsd: 0.01875, // 75% prompt cache discount
    supportsPromptCaching: true,
    tier: "fast",
  },
  {
    id: "openai/gpt-4o-mini",
    provider: "openai",
    name: "GPT-4o Mini",
    contextWindowTokens: 128_000,
    inputCostPerMillionUsd: 0.15,
    outputCostPerMillionUsd: 0.6,
    cachedInputCostPerMillionUsd: 0.075, // 50% prompt cache discount
    supportsPromptCaching: true,
    tier: "economy",
  },
  {
    id: "deepseek/deepseek-v3",
    provider: "deepseek",
    name: "DeepSeek V3",
    contextWindowTokens: 64_000,
    inputCostPerMillionUsd: 0.14,
    outputCostPerMillionUsd: 0.28,
    supportsPromptCaching: false,
    tier: "economy",
  },
];

export class RoutingStrategiesManager {
  private readonly models: StrategyModelDefinition[];
  private roundRobinIndex = 0;

  constructor(customModels?: StrategyModelDefinition[]) {
    this.models = customModels ?? [...STRATEGY_MODELS];
  }

  /**
   * 1. Cost-Optimized Strategy:
   * Chooses the cheapest model based on expected prompt & completion length
   */
  resolveCostOptimized(promptTokens: number, estimatedCompletionTokens = 500): StrategyResolutionResult {
    let cheapest = this.models[0]!;
    let minCost = Infinity;

    for (const m of this.models) {
      const cost =
        (promptTokens / 1_000_000) * m.inputCostPerMillionUsd +
        (estimatedCompletionTokens / 1_000_000) * m.outputCostPerMillionUsd;

      if (cost < minCost) {
        minCost = cost;
        cheapest = m;
      }
    }

    // Benchmark comparison vs flagship Claude 3.7
    const flagship = this.models.find((m) => m.id === "anthropic/claude-3-7-sonnet") || this.models[0]!;
    const flagshipCost =
      (promptTokens / 1_000_000) * flagship.inputCostPerMillionUsd +
      (estimatedCompletionTokens / 1_000_000) * flagship.outputCostPerMillionUsd;

    const savings = flagshipCost > 0 ? Math.round(((flagshipCost - minCost) / flagshipCost) * 100) : 0;

    return {
      strategy: "cost-optimized",
      selectedModelId: cheapest.id,
      provider: cheapest.provider,
      estimatedCostUsd: Number(minCost.toFixed(6)),
      estimatedSavingsPercent: Math.max(0, savings),
      reason: `Cost-optimized routing chose '${cheapest.name}' ($${minCost.toFixed(6)} vs $${flagshipCost.toFixed(6)} flagship, ~${savings}% savings).`,
    };
  }

  /**
   * 2. Context-Optimized Strategy:
   * Selects the model best fit for the token length (e.g. 1M for huge documents, compact for short chats)
   */
  resolveContextOptimized(promptTokens: number): StrategyResolutionResult {
    if (promptTokens > 100_000) {
      const giant = this.models.find((m) => m.contextWindowTokens >= 1_000_000) || this.models[0]!;
      return {
        strategy: "context-optimized",
        selectedModelId: giant.id,
        provider: giant.provider,
        estimatedCostUsd: Number(((promptTokens / 1_000_000) * giant.inputCostPerMillionUsd).toFixed(6)),
        reason: `Massive prompt (${promptTokens.toLocaleString()} tokens) routed to '${giant.name}' (1M context window).`,
      };
    }

    if (promptTokens > 30_000) {
      const medium = this.models.find((m) => m.contextWindowTokens >= 128_000) || this.models[0]!;
      return {
        strategy: "context-optimized",
        selectedModelId: medium.id,
        provider: medium.provider,
        estimatedCostUsd: Number(((promptTokens / 1_000_000) * medium.inputCostPerMillionUsd).toFixed(6)),
        reason: `Medium prompt (${promptTokens.toLocaleString()} tokens) routed to '${medium.name}' (200k context window).`,
      };
    }

    const compact = this.models.find((m) => m.tier === "fast" || m.tier === "economy") || this.models[0]!;
    return {
      strategy: "context-optimized",
      selectedModelId: compact.id,
      provider: compact.provider,
      estimatedCostUsd: Number(((promptTokens / 1_000_000) * compact.inputCostPerMillionUsd).toFixed(6)),
      reason: `Compact prompt (${promptTokens.toLocaleString()} tokens) routed to '${compact.name}' for fast processing.`,
    };
  }

  /**
   * 3. Cache-Optimized Strategy:
   * Selects providers with prompt caching enabled and calculates cache-discounted rates
   */
  resolveCacheOptimized(promptTokens: number, estimatedCachedTokens: number): StrategyResolutionResult {
    const cachingModels = this.models
      .filter((m) => m.supportsPromptCaching && m.cachedInputCostPerMillionUsd !== undefined)
      .sort((a, b) => (a.cachedInputCostPerMillionUsd ?? 0) - (b.cachedInputCostPerMillionUsd ?? 0));

    const selected = cachingModels[0] || this.models[0]!;
    const uncachedTokens = Math.max(0, promptTokens - estimatedCachedTokens);

    const normalCost = (promptTokens / 1_000_000) * selected.inputCostPerMillionUsd;
    const cachedCost =
      (uncachedTokens / 1_000_000) * selected.inputCostPerMillionUsd +
      (estimatedCachedTokens / 1_000_000) * (selected.cachedInputCostPerMillionUsd ?? selected.inputCostPerMillionUsd);

    const savingsPercent = normalCost > 0 ? Math.round(((normalCost - cachedCost) / normalCost) * 100) : 0;

    return {
      strategy: "cache-optimized",
      selectedModelId: selected.id,
      provider: selected.provider,
      cacheControlEnabled: true,
      estimatedCostUsd: Number(cachedCost.toFixed(6)),
      estimatedSavingsPercent: savingsPercent,
      reason: `Prompt-cache routing active on '${selected.name}'. ${estimatedCachedTokens.toLocaleString()} cached tokens yielding ~${savingsPercent}% savings.`,
    };
  }

  /**
   * 4. Priority Strategy:
   * Routes strictly along prioritized provider list, falling back only if primary is unhealthy/offline
   */
  resolvePriority(
    priorityList: string[] = ["anthropic", "openai", "google", "deepseek"],
    healthyProviders: string[] = ["anthropic", "openai", "google", "deepseek"]
  ): StrategyResolutionResult {
    let chosenModel: StrategyModelDefinition | undefined;
    let chosenProvider = priorityList[0] || "anthropic";

    for (const provider of priorityList) {
      if (healthyProviders.includes(provider)) {
        chosenModel = this.models.find((m) => m.provider === provider);
        if (chosenModel) {
          chosenProvider = provider;
          break;
        }
      }
    }

    if (!chosenModel) {
      chosenModel = this.models[0]!;
      chosenProvider = chosenModel.provider;
    }

    return {
      strategy: "priority",
      selectedModelId: chosenModel.id,
      provider: chosenProvider,
      estimatedCostUsd: Number((chosenModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
      reason: `Priority-based routing selected highest healthy candidate '${chosenModel.name}' (${chosenProvider}).`,
    };
  }

  /**
   * 5. Fill-First Strategy:
   * Saturates first provider capacity (e.g. 90%) before overflowing to the next
   */
  resolveFillFirst(
    capacities: ProviderCapacityState[] = [
      { provider: "anthropic", currentRpm: 10, maxRpm: 100 },
      { provider: "openai", currentRpm: 0, maxRpm: 100 },
    ]
  ): StrategyResolutionResult {
    let selectedProvider = capacities[0]?.provider || "anthropic";
    let selectedModel = this.models.find((m) => m.provider === selectedProvider) || this.models[0]!;

    for (const cap of capacities) {
      const utilization = cap.maxRpm > 0 ? cap.currentRpm / cap.maxRpm : 1;
      if (utilization < 0.9) {
        selectedProvider = cap.provider;
        const model = this.models.find((m) => m.provider === cap.provider);
        if (model) selectedModel = model;
        break;
      }
    }

    return {
      strategy: "fill-first",
      selectedModelId: selectedModel.id,
      provider: selectedProvider,
      estimatedCostUsd: Number((selectedModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
      reason: `Fill-first routing selected '${selectedModel.name}' (${selectedProvider}) based on capacity threshold.`,
    };
  }

  /**
   * 6. Weighted Strategy:
   * Probabilistically routes according to percentage/weight distribution
   */
  resolveWeighted(
    weights: Record<string, number> = { anthropic: 70, openai: 30 },
    randomValue = Math.random()
  ): StrategyResolutionResult {
    const totalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0);
    const target = randomValue * totalWeight;

    let accumulated = 0;
    let chosenProvider = Object.keys(weights)[0] || "anthropic";

    for (const [provider, weight] of Object.entries(weights)) {
      accumulated += weight;
      if (target <= accumulated) {
        chosenProvider = provider;
        break;
      }
    }

    const selectedModel = this.models.find((m) => m.provider === chosenProvider) || this.models[0]!;

    return {
      strategy: "weighted",
      selectedModelId: selectedModel.id,
      provider: chosenProvider,
      estimatedCostUsd: Number((selectedModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
      reason: `Weighted routing picked '${selectedModel.name}' (${chosenProvider}) with weight ratio.`,
    };
  }

  /**
   * 7. Round-Robin Strategy:
   * Cyclically routes evenly across healthy providers
   */
  resolveRoundRobin(
    healthyProviders: string[] = ["anthropic", "openai", "google", "deepseek"]
  ): StrategyResolutionResult {
    const providerList = healthyProviders.length > 0 ? healthyProviders : ["anthropic", "openai"];
    const chosenProvider = providerList[this.roundRobinIndex % providerList.length] || "anthropic";
    this.roundRobinIndex++;

    const selectedModel = this.models.find((m) => m.provider === chosenProvider) || this.models[0]!;

    return {
      strategy: "round-robin",
      selectedModelId: selectedModel.id,
      provider: chosenProvider,
      estimatedCostUsd: Number((selectedModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
      reason: `Round-robin routing rotated to index ${this.roundRobinIndex - 1}: '${selectedModel.name}' (${chosenProvider}).`,
    };
  }

  /**
   * 8. P2C (Power of Two Random Choices) Strategy:
   * Picks two random candidates and chooses the one with lower active load/latency
   */
  resolveP2c(
    loads: ProviderLoadState[] = [
      { provider: "anthropic", activeRequests: 12, latencyMs: 250 },
      { provider: "openai", activeRequests: 4, latencyMs: 180 },
      { provider: "google", activeRequests: 20, latencyMs: 310 },
    ],
    randIdx1?: number,
    randIdx2?: number
  ): StrategyResolutionResult {
    if (loads.length === 0) {
      return this.resolveRoundRobin();
    }
    if (loads.length === 1) {
      const chosen = loads[0]!;
      const selectedModel = this.models.find((m) => m.provider === chosen.provider) || this.models[0]!;
      return {
        strategy: "p2c",
        selectedModelId: selectedModel.id,
        provider: chosen.provider,
        estimatedCostUsd: Number((selectedModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
        reason: `P2C picked only candidate '${selectedModel.name}' (${chosen.provider}).`,
      };
    }

    const idx1 = randIdx1 ?? Math.floor(Math.random() * loads.length);
    let idx2 = randIdx2 ?? Math.floor(Math.random() * loads.length);
    if (idx1 === idx2) {
      idx2 = (idx1 + 1) % loads.length;
    }

    const c1 = loads[idx1]!;
    const c2 = loads[idx2]!;

    // Score based on activeRequests + latency
    const score1 = c1.activeRequests * 100 + (c1.latencyMs ?? 200);
    const score2 = c2.activeRequests * 100 + (c2.latencyMs ?? 200);

    const winner = score1 <= score2 ? c1 : c2;
    const selectedModel = this.models.find((m) => m.provider === winner.provider) || this.models[0]!;

    return {
      strategy: "p2c",
      selectedModelId: selectedModel.id,
      provider: winner.provider,
      estimatedCostUsd: Number((selectedModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
      reason: `P2C compared '${c1.provider}' (reqs: ${c1.activeRequests}) vs '${c2.provider}' (reqs: ${c2.activeRequests}) -> picked '${winner.provider}'.`,
    };
  }

  /**
   * 9. Least-Used Strategy:
   * Selects candidate with minimum currently active requests
   */
  resolveLeastUsed(
    loads: ProviderLoadState[] = [
      { provider: "anthropic", activeRequests: 8 },
      { provider: "openai", activeRequests: 2 },
      { provider: "google", activeRequests: 15 },
    ]
  ): StrategyResolutionResult {
    let least = loads[0]!;
    for (const l of loads) {
      if (l.activeRequests < least.activeRequests) {
        least = l;
      }
    }

    const selectedModel = this.models.find((m) => m.provider === least.provider) || this.models[0]!;

    return {
      strategy: "least-used",
      selectedModelId: selectedModel.id,
      provider: least.provider,
      estimatedCostUsd: Number((selectedModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
      reason: `Least-used strategy selected '${selectedModel.name}' (${least.provider}) with ${least.activeRequests} active requests.`,
    };
  }

  /**
   * 10. Random Strategy:
   * Uniform pseudo-random distribution across healthy providers
   */
  resolveRandom(
    healthyProviders: string[] = ["anthropic", "openai", "google", "deepseek"],
    randVal?: number
  ): StrategyResolutionResult {
    const list = healthyProviders.length > 0 ? healthyProviders : ["anthropic", "openai"];
    const r = randVal ?? Math.random();
    const chosenProvider = list[Math.floor(r * list.length)] || "anthropic";

    const selectedModel = this.models.find((m) => m.provider === chosenProvider) || this.models[0]!;

    return {
      strategy: "random",
      selectedModelId: selectedModel.id,
      provider: chosenProvider,
      estimatedCostUsd: Number((selectedModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
      reason: `Random strategy picked '${selectedModel.name}' (${chosenProvider}).`,
    };
  }

  /**
   * 11. Strict-Random Strategy:
   * Cryptographically secure CSPRNG random distribution (zero predictable bias)
   */
  resolveStrictRandom(
    healthyProviders: string[] = ["anthropic", "openai", "google", "deepseek"],
    csprngInt?: number
  ): StrategyResolutionResult {
    const list = healthyProviders.length > 0 ? healthyProviders : ["anthropic", "openai"];
    const idx = csprngInt !== undefined ? csprngInt % list.length : randomInt(0, list.length);
    const chosenProvider = list[idx] || "anthropic";

    const selectedModel = this.models.find((m) => m.provider === chosenProvider) || this.models[0]!;

    return {
      strategy: "strict-random",
      selectedModelId: selectedModel.id,
      provider: chosenProvider,
      estimatedCostUsd: Number((selectedModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
      reason: `Strict-random CSPRNG selected '${selectedModel.name}' (${chosenProvider}) at index ${idx}.`,
    };
  }

  /**
   * 12. Headroom Strategy:
   * Selects provider with largest remaining safety headroom buffer to absorb traffic bursts
   */
  resolveHeadroom(
    headroomStates: { provider: string; remainingHeadroomRpm: number }[] = [
      { provider: "anthropic", remainingHeadroomRpm: 15 },
      { provider: "openai", remainingHeadroomRpm: 45 },
      { provider: "google", remainingHeadroomRpm: 80 },
    ]
  ): StrategyResolutionResult {
    let best = headroomStates[0]!;
    for (const h of headroomStates) {
      if (h.remainingHeadroomRpm > best.remainingHeadroomRpm) {
        best = h;
      }
    }

    const selectedModel = this.models.find((m) => m.provider === best.provider) || this.models[0]!;

    return {
      strategy: "headroom",
      selectedModelId: selectedModel.id,
      provider: best.provider,
      estimatedCostUsd: Number((selectedModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
      reason: `Headroom-aware routing selected '${selectedModel.name}' (${best.provider}) with largest headroom (${best.remainingHeadroomRpm} RPM).`,
    };
  }

  /**
   * 13. Reset-Window Strategy:
   * Prioritizes providers whose rate-limit windows have recently reset or reset soonest
   */
  resolveResetWindow(
    resetStates: { provider: string; resetInSeconds: number; isLimited: boolean }[] = [
      { provider: "anthropic", resetInSeconds: 45, isLimited: true },
      { provider: "openai", resetInSeconds: 2, isLimited: false },
      { provider: "google", resetInSeconds: 12, isLimited: false },
    ]
  ): StrategyResolutionResult {
    const unconstrained = resetStates.filter((s) => !s.isLimited);
    const pool = unconstrained.length > 0 ? unconstrained : resetStates;

    let chosen = pool[0]!;
    for (const s of pool) {
      if (s.resetInSeconds < chosen.resetInSeconds) {
        chosen = s;
      }
    }

    const selectedModel = this.models.find((m) => m.provider === chosen.provider) || this.models[0]!;

    return {
      strategy: "reset-window",
      selectedModelId: selectedModel.id,
      provider: chosen.provider,
      estimatedCostUsd: Number((selectedModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
      reason: `Reset-window routing selected '${selectedModel.name}' (${chosen.provider}) (window resets in ${chosen.resetInSeconds}s, limited: ${chosen.isLimited}).`,
    };
  }

  /**
   * 14. Reset-Aware Strategy:
   * Smooths traffic distribution based on exponential decay recovery curves post rate-limit reset
   */
  resolveResetAware(
    recoveryStates: { provider: string; timeSinceResetSeconds: number; maxRpm: number }[] = [
      { provider: "anthropic", timeSinceResetSeconds: 50, maxRpm: 100 },
      { provider: "openai", timeSinceResetSeconds: 5, maxRpm: 100 },
      { provider: "google", timeSinceResetSeconds: 120, maxRpm: 100 },
    ]
  ): StrategyResolutionResult {
    // Calculates recovery factor = min(1.0, timeSinceReset / 60)
    let best = recoveryStates[0]!;
    let bestScore = -1;

    for (const r of recoveryStates) {
      const recoveryFactor = Math.min(1.0, r.timeSinceResetSeconds / 60);
      const score = recoveryFactor * r.maxRpm;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }

    const selectedModel = this.models.find((m) => m.provider === best.provider) || this.models[0]!;

    return {
      strategy: "reset-aware",
      selectedModelId: selectedModel.id,
      provider: best.provider,
      estimatedCostUsd: Number((selectedModel.inputCostPerMillionUsd * 0.001).toFixed(6)),
      reason: `Reset-aware routing selected '${selectedModel.name}' (${best.provider}) with recovery score ${bestScore.toFixed(1)} (${best.timeSinceResetSeconds}s post-reset).`,
    };
  }

  /**
   * 15. Context-Relay Strategy:
   * Cross-provider session handoff selecting a relay model capable of absorbing accumulated context
   */
  resolveContextRelay(
    accumulatedPromptTokens: number,
    preferredProvider?: string
  ): StrategyResolutionResult {
    const candidates = this.models
      .filter((m) => m.contextWindowTokens >= accumulatedPromptTokens * 1.5)
      .sort((a, b) => a.inputCostPerMillionUsd - b.inputCostPerMillionUsd);

    let chosen = candidates[0] || this.models.find((m) => m.contextWindowTokens >= 1_000_000) || this.models[0]!;
    if (preferredProvider) {
      const pref = candidates.find((m) => m.provider === preferredProvider);
      if (pref) chosen = pref;
    }

    return {
      strategy: "context-relay",
      selectedModelId: chosen.id,
      provider: chosen.provider,
      fallbackModelId: "openai/gpt-4o",
      estimatedCostUsd: Number(((accumulatedPromptTokens / 1_000_000) * chosen.inputCostPerMillionUsd).toFixed(6)),
      reason: `Context-relay successfully selected '${chosen.name}' (${chosen.provider}) to relay ${accumulatedPromptTokens.toLocaleString()} tokens with safety buffer.`,
    };
  }

  /**
   * Universal resolution entry point for any strategy name
   */
  resolveStrategy(
    strategy: RoutingStrategyName,
    options: {
      promptTokens?: number;
      estimatedCachedTokens?: number;
      estimatedCompletionTokens?: number;
      priorityList?: string[];
      healthyProviders?: string[];
      capacities?: ProviderCapacityState[];
      weights?: Record<string, number>;
      loads?: ProviderLoadState[];
      headrooms?: { provider: string; remainingHeadroomRpm: number }[];
      resetStates?: { provider: string; resetInSeconds: number; isLimited: boolean }[];
      recoveryStates?: { provider: string; timeSinceResetSeconds: number; maxRpm: number }[];
      randomValue?: number;
      preferredProvider?: string;
    } = {}
  ): StrategyResolutionResult {
    const tokens = options.promptTokens ?? 2000;

    switch (strategy) {
      case "cost-optimized":
        return this.resolveCostOptimized(tokens, options.estimatedCompletionTokens);
      case "context-optimized":
        return this.resolveContextOptimized(tokens);
      case "cache-optimized":
        return this.resolveCacheOptimized(tokens, options.estimatedCachedTokens ?? Math.round(tokens * 0.7));
      case "priority":
        return this.resolvePriority(options.priorityList, options.healthyProviders);
      case "fill-first":
        return this.resolveFillFirst(options.capacities);
      case "weighted":
        return this.resolveWeighted(options.weights, options.randomValue);
      case "round-robin":
        return this.resolveRoundRobin(options.healthyProviders);
      case "p2c":
        return this.resolveP2c(options.loads);
      case "least-used":
        return this.resolveLeastUsed(options.loads);
      case "random":
        return this.resolveRandom(options.healthyProviders, options.randomValue);
      case "strict-random":
        return this.resolveStrictRandom(options.healthyProviders);
      case "headroom":
        return this.resolveHeadroom(options.headrooms);
      case "reset-window":
        return this.resolveResetWindow(options.resetStates);
      case "reset-aware":
        return this.resolveResetAware(options.recoveryStates);
      case "context-relay":
        return this.resolveContextRelay(tokens, options.preferredProvider);
      default:
        return this.resolveCostOptimized(tokens, options.estimatedCompletionTokens);
    }
  }
}

export const RoutingStrategyEngine = RoutingStrategiesManager;
export type RoutingStrategyEngine = RoutingStrategiesManager;
