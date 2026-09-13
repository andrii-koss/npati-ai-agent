export type OutputStyleType = "concise" | "bulleted" | "minimal-json" | "executive";

export interface OutputStyleDescriptor {
  id: OutputStyleType;
  name: string;
  description: string;
  instruction: string;
  expectedTokenSavingsPercent: number;
}

export interface CompressionEvalOptions {
  minReductionPercent?: number;
  minEntityRetentionRate?: number;
  minSemanticOverlapScore?: number;
}

export interface CompressionEvalReport {
  originalLength: number;
  compressedLength: number;
  reductionPercent: number;
  entityRetentionRate: number; // 0.0 - 1.0
  semanticOverlapScore: number; // 0.0 - 1.0
  passedValidation: boolean;
  notes: string;
  entitiesRetainedCount?: number;
  totalEntitiesCount?: number;
}

export interface CacheStatistics {
  hits: number;
  misses: number;
  hitRatio: number;
  totalKeys: number;
  memoryBytesEstimate: number;
  scope: string;
}

export class OutputStyleModifier {
  private static readonly STYLE_INSTRUCTIONS: Record<OutputStyleType, string> = {
    concise:
      "Output style: Extremely concise and direct. Omit conversational greetings, pleasantries, and filler words. Answer in maximum 2-3 dense sentences.",
    bulleted:
      "Output style: Concise bulleted points. Present findings as structured list items with bold takeaways. No introductory fluff.",
    "minimal-json":
      "Output style: Valid compact JSON only. No markdown formatting, backticks, comments, or extra whitespace.",
    executive:
      "Output style: Executive briefing. Exactly 1 summary paragraph (max 3 sentences) followed by high-priority Action Items.",
  };

  private static readonly STYLE_DESCRIPTORS: Record<OutputStyleType, { name: string; description: string; expectedSavings: number }> = {
    concise: {
      name: "Ultra Concise",
      description: "Direct answers in 2-3 dense sentences, stripping conversational filler and pleasantries.",
      expectedSavings: 45,
    },
    bulleted: {
      name: "Bulleted Key Points",
      description: "Findings presented as punchy, high-signal bulleted list items with bold takeaways.",
      expectedSavings: 35,
    },
    "minimal-json": {
      name: "Compact JSON Only",
      description: "Strictly valid minimal JSON without markdown wrappers or decorative whitespace.",
      expectedSavings: 50,
    },
    executive: {
      name: "Executive Briefing",
      description: "Single-paragraph summary followed directly by prioritized action items.",
      expectedSavings: 40,
    },
  };

  /**
   * Returns list of all available output style descriptors with instructions and expected savings
   */
  static getAvailableStyles(): OutputStyleDescriptor[] {
    return (Object.keys(this.STYLE_INSTRUCTIONS) as OutputStyleType[]).map((id) => {
      const meta = this.STYLE_DESCRIPTORS[id];
      return {
        id,
        name: meta.name,
        description: meta.description,
        instruction: this.STYLE_INSTRUCTIONS[id],
        expectedTokenSavingsPercent: meta.expectedSavings,
      };
    });
  }

  /**
   * Checks whether the given string is a valid OutputStyleType
   */
  static isValidStyle(style: unknown): style is OutputStyleType {
    return typeof style === "string" && style in this.STYLE_INSTRUCTIONS;
  }

  /**
   * Retrieves the raw instruction for a style
   */
  static getInstruction(style: OutputStyleType): string {
    return this.STYLE_INSTRUCTIONS[style] || "";
  }

  /**
   * Injects formatting and compression constraints to trim generated tokens in message history
   */
  static applyOutputStyle(
    messages: Array<{ role: string; content: string }>,
    style: OutputStyleType
  ): Array<{ role: string; content: string }> {
    const instruction = this.STYLE_INSTRUCTIONS[style];
    if (!instruction) return messages;

    const modified = [...messages];
    const systemIndex = modified.findIndex((m) => m.role === "system");

    if (systemIndex >= 0) {
      modified[systemIndex] = {
        role: "system",
        content: `${modified[systemIndex]!.content}\n\n${instruction}`,
      };
    } else {
      modified.unshift({ role: "system", content: instruction });
    }

    return modified;
  }

  /**
   * Injects style instructions into a single prompt string
   */
  static applyOutputStyleToPrompt(prompt: string, style: OutputStyleType): string {
    const instruction = this.STYLE_INSTRUCTIONS[style];
    if (!instruction) return prompt;
    return `${instruction}\n\n${prompt}`;
  }
}

export class CompressionEvalHarness {
  /**
   * Measures compression ratio, entity retention, and semantic fidelity for raw text
   */
  static evaluate(
    original: string,
    compressed: string,
    options?: CompressionEvalOptions
  ): CompressionEvalReport {
    const minReduction = options?.minReductionPercent ?? 10;
    const minRetention = options?.minEntityRetentionRate ?? 0.4;
    const minSemanticOverlap = options?.minSemanticOverlapScore ?? 0.2;

    const originalLength = original.length;
    const compressedLength = compressed.length;

    const reductionPercent =
      originalLength > 0
        ? Math.round(((originalLength - compressedLength) / originalLength) * 100)
        : 0;

    // Detect entities (words with alphanumeric and underscores, length >= 3)
    const extractTokens = (txt: string) =>
      new Set(
        txt
          .toLowerCase()
          .split(/[\s,.;:!?()[\]{}"'`]+/)
          .filter((w) => w.length >= 3)
      );

    const origTokens = extractTokens(original);
    const compTokens = extractTokens(compressed);

    let retainedCount = 0;
    for (const t of origTokens) {
      if (compTokens.has(t)) retainedCount++;
    }

    const entityRetentionRate =
      origTokens.size > 0 ? Number((retainedCount / origTokens.size).toFixed(2)) : 1.0;

    // Jaccard similarity
    let intersection = 0;
    for (const t of compTokens) {
      if (origTokens.has(t)) intersection++;
    }
    const union = new Set([...origTokens, ...compTokens]).size;
    const semanticOverlapScore =
      union > 0 ? Number((intersection / union).toFixed(2)) : 1.0;

    const passedValidation =
      reductionPercent >= minReduction &&
      entityRetentionRate >= minRetention &&
      semanticOverlapScore >= minSemanticOverlap;

    return {
      originalLength,
      compressedLength,
      reductionPercent: Math.max(0, reductionPercent),
      entityRetentionRate,
      semanticOverlapScore,
      passedValidation,
      entitiesRetainedCount: retainedCount,
      totalEntitiesCount: origTokens.size,
      notes: passedValidation
        ? `Passed evaluation: ${reductionPercent}% reduction with ${(entityRetentionRate * 100).toFixed(0)}% key entities retained.`
        : `Failed evaluation: reduction (${reductionPercent}% vs min ${minReduction}%), retention (${entityRetentionRate} vs min ${minRetention}), or semantic overlap (${semanticOverlapScore} vs min ${minSemanticOverlap}).`,
    };
  }

  /**
   * Evaluates compression across structured message arrays
   */
  static evaluateMessages(
    originalMessages: Array<{ role: string; content: string }>,
    compressedMessages: Array<{ role: string; content: string }>,
    options?: CompressionEvalOptions
  ): CompressionEvalReport {
    const origText = originalMessages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const compText = compressedMessages.map((m) => `${m.role}: ${m.content}`).join("\n");
    return this.evaluate(origText, compText, options);
  }
}

export class CacheManagementService {
  private readonly store = new Map<string, { value: unknown; sizeBytes: number }>();
  private hits = 0;
  private misses = 0;

  /**
   * Sets a cache key with serialized byte estimate
   */
  set(key: string, value: unknown): void {
    const sizeBytes = JSON.stringify(value).length;
    this.store.set(key, { value, sizeBytes });
  }

  /**
   * Retrieves a cache key, updating hit/miss statistics
   */
  get(key: string): unknown | undefined {
    const entry = this.store.get(key);
    if (entry) {
      this.hits++;
      return entry.value;
    }
    this.misses++;
    return undefined;
  }

  /**
   * Checks whether a cache key exists without affecting hit/miss statistics
   */
  has(key: string): boolean {
    return this.store.has(key);
  }

  /**
   * Removes a single cache key
   */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * Clears all entries and resets metrics
   */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Returns cache metrics optionally scoped by tenant
   */
  getStats(tenantId?: string): CacheStatistics {
    const prefix = tenantId ? `${tenantId}:` : "";
    let count = 0;
    let memoryBytes = 0;

    for (const [k, v] of this.store.entries()) {
      if (!prefix || k.startsWith(prefix)) {
        count++;
        memoryBytes += v.sizeBytes;
      }
    }

    const total = this.hits + this.misses;
    const hitRatio = total > 0 ? Number((this.hits / total).toFixed(2)) : 0;

    return {
      hits: this.hits,
      misses: this.misses,
      hitRatio,
      totalKeys: count,
      memoryBytesEstimate: memoryBytes,
      scope: tenantId || "global",
    };
  }

  /**
   * Flushes cache entries by tenant and/or prefix
   */
  flush(options?: { tenantId?: string; prefix?: string }): {
    flushedCount: number;
    remainingKeys: number;
  } {
    const targetPrefix = options?.tenantId
      ? `${options.tenantId}:${options?.prefix || ""}`
      : options?.prefix;

    if (!targetPrefix) {
      const flushedCount = this.store.size;
      this.store.clear();
      this.hits = 0;
      this.misses = 0;
      return { flushedCount, remainingKeys: 0 };
    }

    let flushedCount = 0;
    for (const key of Array.from(this.store.keys())) {
      if (key.startsWith(targetPrefix)) {
        this.store.delete(key);
        flushedCount++;
      }
    }

    return { flushedCount, remainingKeys: this.store.size };
  }
}
