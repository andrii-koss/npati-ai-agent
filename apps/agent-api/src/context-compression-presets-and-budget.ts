import {
  AggressivePromptCompressor,
  LlmLingua2Compressor,
  RelevancePromptCompressor,
} from "./prompt-compression-algorithms";

export type CompressionPresetName =
  | "minimal"
  | "balanced"
  | "extreme"
  | "code-safe"
  | "rag-optimized";

export interface CompressionPresetConfig {
  name: CompressionPresetName;
  description: string;
  targetRatio: number;
  preserveCodeBlocks: boolean;
  useRelevanceFilter: boolean;
  useEntropyPruning: boolean;
}

export interface AdaptiveBudgetResolution {
  currentTokens: number;
  maxContextTokens: number;
  utilizationRatio: number;
  suggestedPreset: CompressionPresetName | "none";
  targetBudgetTokens: number;
  actionRequired: boolean;
  reason: string;
}

export interface RequestCompressionOverrideOptions {
  enabled?: boolean;
  preset?: CompressionPresetName;
  bypass?: boolean;
  maxBudgetTokens?: number;
}

export const COMPRESSION_PRESETS: Record<CompressionPresetName, CompressionPresetConfig> = {
  minimal: {
    name: "minimal",
    description: "Light whitespace and newline cleanup, preserving 95% of content",
    targetRatio: 0.95,
    preserveCodeBlocks: true,
    useRelevanceFilter: false,
    useEntropyPruning: false,
  },
  balanced: {
    name: "balanced",
    description: "Removes conversational fillers and redundant system repeats (~30% savings)",
    targetRatio: 0.7,
    preserveCodeBlocks: true,
    useRelevanceFilter: true,
    useEntropyPruning: false,
  },
  extreme: {
    name: "extreme",
    description: "Aggressive stripping with entropy pruning for maximum context reduction (~50-60% savings)",
    targetRatio: 0.45,
    preserveCodeBlocks: true,
    useRelevanceFilter: true,
    useEntropyPruning: true,
  },
  "code-safe": {
    name: "code-safe",
    description: "Strictly protects all syntax, code blocks, diffs and backticks from modification",
    targetRatio: 0.8,
    preserveCodeBlocks: true,
    useRelevanceFilter: false,
    useEntropyPruning: false,
  },
  "rag-optimized": {
    name: "rag-optimized",
    description: "Filters low-relevance knowledge chunks while maintaining exact citations",
    targetRatio: 0.6,
    preserveCodeBlocks: true,
    useRelevanceFilter: true,
    useEntropyPruning: true,
  },
};

export class CompressionPresetManager {
  /**
   * 1. Compression Presets: Applies pre-configured compression profiles
   */
  static applyPreset(
    text: string,
    presetName: CompressionPresetName = "balanced"
  ): { compressedText: string; preset: CompressionPresetName; tokensSaved: number } {
    const preset = COMPRESSION_PRESETS[presetName] || COMPRESSION_PRESETS.balanced;
    const initialTokens = Math.ceil(text.length / 4);

    let output = text;

    if (preset.name === "minimal") {
      output = output.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
    } else if (preset.name === "balanced") {
      output = AggressivePromptCompressor.compress(output, {
        preserveCodeBlocks: preset.preserveCodeBlocks,
      }).compressedText;
    } else if (preset.name === "extreme" || preset.name === "rag-optimized") {
      const aggressive = AggressivePromptCompressor.compress(output, {
        preserveCodeBlocks: preset.preserveCodeBlocks,
      }).compressedText;
      output = LlmLingua2Compressor.compressWithLingua(
        aggressive,
        preset.targetRatio
      ).compressedText;
    } else if (preset.name === "code-safe") {
      output = AggressivePromptCompressor.compress(output, {
        preserveCodeBlocks: true,
      }).compressedText;
    }

    const finalTokens = Math.ceil(output.length / 4);

    return {
      compressedText: output,
      preset: preset.name,
      tokensSaved: Math.max(0, initialTokens - finalTokens),
    };
  }
}

export class AdaptiveContextBudgetManager {
  /**
   * 2. Adaptive Context Budget: Dynamically scales compression depending on context limits
   */
  static evaluateBudget(
    currentTokens: number,
    maxContextTokens = 128_000
  ): AdaptiveBudgetResolution {
    const ratio = currentTokens / maxContextTokens;

    if (ratio < 0.6) {
      return {
        currentTokens,
        maxContextTokens,
        utilizationRatio: Number(ratio.toFixed(2)),
        suggestedPreset: "none",
        targetBudgetTokens: currentTokens,
        actionRequired: false,
        reason: `Context usage is healthy (${Math.round(ratio * 100)}% of limit). No compression required.`,
      };
    }

    if (ratio < 0.8) {
      return {
        currentTokens,
        maxContextTokens,
        utilizationRatio: Number(ratio.toFixed(2)),
        suggestedPreset: "balanced",
        targetBudgetTokens: Math.floor(maxContextTokens * 0.55),
        actionRequired: true,
        reason: `Approaching context threshold (${Math.round(ratio * 100)}%). Applying 'balanced' compression.`,
      };
    }

    return {
      currentTokens,
      maxContextTokens,
      utilizationRatio: Number(ratio.toFixed(2)),
      suggestedPreset: "extreme",
      targetBudgetTokens: Math.floor(maxContextTokens * 0.65),
      actionRequired: true,
      reason: `Critical context usage (${Math.round(ratio * 100)}%). Applying 'extreme' compression to prevent overflow.`,
    };
  }
}

export class PerRequestCompressionOverrideManager {
  /**
   * 3. Per-Request Compression Override: Allows API clients to override via headers or body
   */
  static resolveOverride(
    headers: Record<string, string | string[] | undefined> = {},
    bodyOptions?: RequestCompressionOverrideOptions
  ): {
    enabled: boolean;
    preset: CompressionPresetName;
    bypass: boolean;
    maxBudgetTokens?: number;
  } {
    const headerValue = String(
      headers["x-npati-compression"] || headers["x-compression"] || ""
    ).toLowerCase();

    // Explicit bypass via header or payload
    if (headerValue === "bypass" || headerValue === "none" || bodyOptions?.bypass) {
      return {
        enabled: false,
        preset: "minimal",
        bypass: true,
      };
    }

    // Explicit preset in header e.g. "x-npati-compression: extreme"
    if (["minimal", "balanced", "extreme", "code-safe", "rag-optimized"].includes(headerValue)) {
      return {
        enabled: true,
        preset: headerValue as CompressionPresetName,
        bypass: false,
      };
    }

    // Body payload override
    if (bodyOptions?.preset) {
      return {
        enabled: bodyOptions.enabled ?? true,
        preset: bodyOptions.preset,
        bypass: false,
        maxBudgetTokens: bodyOptions.maxBudgetTokens,
      };
    }

    // Default configuration
    return {
      enabled: true,
      preset: "balanced",
      bypass: false,
    };
  }
}
