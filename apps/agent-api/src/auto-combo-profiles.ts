export type AutoComboProfileName =
  | "auto"
  | "auto/smart"
  | "auto/coding"
  | "auto/fast"
  | "auto/cheap"
  | "auto/offline";

export interface ModelCandidate {
  id: string;
  provider: string;
  name: string;
  costPerMillionInputTokensUsd: number;
  costPerMillionOutputTokensUsd: number;
  averageLatencyMs: number;
  isLocalOrOffline?: boolean;
  capabilities: {
    coding: number;      // 0 - 100 rating
    reasoning: number;   // 0 - 100 rating
    fastResponse: boolean;
    supportsVision: boolean;
  };
  isAvailable: boolean;
}

export interface ResolvedModelTarget {
  profile: AutoComboProfileName;
  selectedModelId: string;
  provider: string;
  fallbackModelId?: string;
  temperature: number;
  isOffline?: boolean;
  reason: string;
}

export const DEFAULT_MODEL_CANDIDATES: ModelCandidate[] = [
  // Coding / Reasoning Giants
  {
    id: "anthropic/claude-3-7-sonnet",
    provider: "anthropic",
    name: "Claude 3.7 Sonnet (Thinking)",
    costPerMillionInputTokensUsd: 3.0,
    costPerMillionOutputTokensUsd: 15.0,
    averageLatencyMs: 1100,
    capabilities: { coding: 98, reasoning: 98, fastResponse: false, supportsVision: true },
    isAvailable: true,
  },
  {
    id: "openai/gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    costPerMillionInputTokensUsd: 2.5,
    costPerMillionOutputTokensUsd: 10.0,
    averageLatencyMs: 800,
    capabilities: { coding: 92, reasoning: 94, fastResponse: false, supportsVision: true },
    isAvailable: true,
  },
  {
    id: "deepseek/deepseek-coder",
    provider: "deepseek",
    name: "DeepSeek Coder V2.5",
    costPerMillionInputTokensUsd: 0.14,
    costPerMillionOutputTokensUsd: 0.28,
    averageLatencyMs: 950,
    capabilities: { coding: 96, reasoning: 90, fastResponse: false, supportsVision: false },
    isAvailable: true,
  },
  // Fast / Low Latency
  {
    id: "google/gemini-2.5-flash",
    provider: "google",
    name: "Gemini 2.5 Flash",
    costPerMillionInputTokensUsd: 0.075,
    costPerMillionOutputTokensUsd: 0.3,
    averageLatencyMs: 220,
    capabilities: { coding: 84, reasoning: 85, fastResponse: true, supportsVision: true },
    isAvailable: true,
  },
  {
    id: "anthropic/claude-3-5-haiku",
    provider: "anthropic",
    name: "Claude 3.5 Haiku",
    costPerMillionInputTokensUsd: 0.8,
    costPerMillionOutputTokensUsd: 4.0,
    averageLatencyMs: 250,
    capabilities: { coding: 86, reasoning: 86, fastResponse: true, supportsVision: true },
    isAvailable: true,
  },
  {
    id: "openai/gpt-4o-mini",
    provider: "openai",
    name: "GPT-4o Mini",
    costPerMillionInputTokensUsd: 0.15,
    costPerMillionOutputTokensUsd: 0.6,
    averageLatencyMs: 290,
    capabilities: { coding: 82, reasoning: 84, fastResponse: true, supportsVision: true },
    isAvailable: true,
  },
  // Offline / Local Air-Gapped Models
  {
    id: "ollama/llama3.3:70b",
    provider: "ollama",
    name: "Llama 3.3 70B (Local)",
    costPerMillionInputTokensUsd: 0.0,
    costPerMillionOutputTokensUsd: 0.0,
    averageLatencyMs: 650,
    isLocalOrOffline: true,
    capabilities: { coding: 90, reasoning: 91, fastResponse: false, supportsVision: false },
    isAvailable: true,
  },
  {
    id: "ollama/qwen2.5-coder:32b",
    provider: "ollama",
    name: "Qwen 2.5 Coder 32B (Local)",
    costPerMillionInputTokensUsd: 0.0,
    costPerMillionOutputTokensUsd: 0.0,
    averageLatencyMs: 520,
    isLocalOrOffline: true,
    capabilities: { coding: 93, reasoning: 88, fastResponse: false, supportsVision: false },
    isAvailable: true,
  },
];

const fallbackDefaultCandidate: ModelCandidate = DEFAULT_MODEL_CANDIDATES[0]!;

export class AutoComboRouter {
  private readonly candidates: ModelCandidate[];

  constructor(customCandidates?: ModelCandidate[]) {
    this.candidates = customCandidates ?? [...DEFAULT_MODEL_CANDIDATES];
  }

  private getCandidate(index: number, list: ModelCandidate[]): ModelCandidate {
    return list[index] ?? this.candidates[0] ?? fallbackDefaultCandidate;
  }

  /**
   * Resolve auto/coding profile: selects top coding benchmark model with low temperature
   */
  resolveCodingTarget(): ResolvedModelTarget {
    const available = this.candidates
      .filter((c) => c.isAvailable)
      .sort((a, b) => b.capabilities.coding - a.capabilities.coding);

    const primary = this.getCandidate(0, available);
    const fallback = this.getCandidate(1, available);

    return {
      profile: "auto/coding",
      selectedModelId: primary.id,
      provider: primary.provider,
      fallbackModelId: fallback.id !== primary.id ? fallback.id : undefined,
      temperature: 0.1, // Deterministic for code synthesis
      reason: `Selected '${primary.name}' with top coding capability score (${primary.capabilities.coding}/100).`,
    };
  }

  /**
   * Resolve auto/fast profile: selects lowest latency model (< 300ms TTFT)
   */
  resolveFastTarget(): ResolvedModelTarget {
    const available = this.candidates
      .filter((c) => c.isAvailable && c.capabilities.fastResponse)
      .sort((a, b) => a.averageLatencyMs - b.averageLatencyMs);

    const primary = this.getCandidate(0, available);
    const fallback = this.getCandidate(1, available);

    return {
      profile: "auto/fast",
      selectedModelId: primary.id,
      provider: primary.provider,
      fallbackModelId: fallback.id !== primary.id ? fallback.id : undefined,
      temperature: 0.7,
      reason: `Selected '${primary.name}' for ultra-low latency response (${primary.averageLatencyMs}ms).`,
    };
  }

  /**
   * Resolve auto/cheap profile: selects lowest blended cost per million tokens
   */
  resolveCheapTarget(): ResolvedModelTarget {
    const available = this.candidates
      .filter((c) => c.isAvailable && !c.isLocalOrOffline)
      .sort((a, b) => {
        const costA = a.costPerMillionInputTokensUsd * 0.75 + a.costPerMillionOutputTokensUsd * 0.25;
        const costB = b.costPerMillionInputTokensUsd * 0.75 + b.costPerMillionOutputTokensUsd * 0.25;
        return costA - costB;
      });

    const primary = this.getCandidate(0, available);
    const fallback = this.getCandidate(1, available);

    return {
      profile: "auto/cheap",
      selectedModelId: primary.id,
      provider: primary.provider,
      fallbackModelId: fallback.id !== primary.id ? fallback.id : undefined,
      temperature: 0.5,
      reason: `Selected '${primary.name}' for minimum USD cost ($${primary.costPerMillionInputTokensUsd}/M in, $${primary.costPerMillionOutputTokensUsd}/M out).`,
    };
  }

  /**
   * Resolve auto/offline profile: selects locally running air-gapped models (e.g. Ollama/LocalAI)
   */
  resolveOfflineTarget(): ResolvedModelTarget {
    const available = this.candidates
      .filter((c) => c.isAvailable && c.isLocalOrOffline)
      .sort((a, b) => b.capabilities.reasoning - a.capabilities.reasoning);

    const primary = available[0] || this.candidates.find((c) => c.isLocalOrOffline) || fallbackDefaultCandidate;
    const fallback = available[1] || primary;

    return {
      profile: "auto/offline",
      selectedModelId: primary.id,
      provider: primary.provider,
      fallbackModelId: fallback.id !== primary.id ? fallback.id : undefined,
      temperature: 0.7,
      isOffline: true,
      reason: `Selected local offline model '${primary.name}' ($0.00/M tokens, air-gapped execution).`,
    };
  }

  /**
   * Universal resolution entry point for any requested model / profile
   */
  resolve(requestedProfile: string): ResolvedModelTarget {
    const normalized = requestedProfile.trim().toLowerCase();

    switch (normalized) {
      case "auto/coding":
        return this.resolveCodingTarget();
      case "auto/fast":
        return this.resolveFastTarget();
      case "auto/cheap":
        return this.resolveCheapTarget();
      case "auto/offline":
        return this.resolveOfflineTarget();
      case "auto":
      case "auto/smart":
      default: {
        const smartCandidates = this.candidates
          .filter((c) => c.isAvailable && !c.isLocalOrOffline)
          .sort((a, b) => b.capabilities.reasoning - a.capabilities.reasoning);
        const primary = this.getCandidate(0, smartCandidates);
        const fallback = this.getCandidate(1, smartCandidates);
        return {
          profile: "auto/smart",
          selectedModelId: primary.id,
          provider: primary.provider,
          fallbackModelId: fallback.id !== primary.id ? fallback.id : undefined,
          temperature: 0.7,
          reason: `Selected '${primary.name}' for optimal general intelligence and reasoning.`,
        };
      }
    }
  }
}
