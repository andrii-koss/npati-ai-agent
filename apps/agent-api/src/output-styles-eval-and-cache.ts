export type OutputStyleType = "concise" | "bulleted" | "minimal-json" | "executive";

export interface CompressionEvalReport {
  originalLength: number;
  compressedLength: number;
  reductionPercent: number;
  entityRetentionRate: number; // 0.0 - 1.0
  semanticOverlapScore: number; // 0.0 - 1.0
  passedValidation: boolean;
  notes: string;
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

  /**
   * 1. Output Styles: Injects formatting and compression constraints to trim generated tokens
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
}

export class CompressionEvalHarness {
  /**
   * 2. Compression Eval Harness: Measures compression ratio, entity retention, and semantic fidelity
   */
  static evaluate(original: string, compressed: string): CompressionEvalReport {
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

    const passedValidation = reductionPercent >= 10 && entityRetentionRate >= 0.4;

    return {
      originalLength,
      compressedLength,
      reductionPercent: Math.max(0, reductionPercent),
      entityRetentionRate,
      semanticOverlapScore,
      passedValidation,
      notes: passedValidation
        ? `Passed evaluation: ${reductionPercent}% reduction with ${(entityRetentionRate * 100).toFixed(0)}% key entities retained.`
        : `Failed evaluation: insufficient reduction or entity loss.`,
    };
  }
}

export class CacheManagementService {
  private readonly store = new Map<string, { value: unknown; sizeBytes: number }>();
  private hits = 0;
  private misses = 0;

  /**
   * 3. Cache Stats / Flush: Redis/in-memory cache monitoring and selective flushing
   */
  set(key: string, value: unknown): void {
    const sizeBytes = JSON.stringify(value).length;
    this.store.set(key, { value, sizeBytes });
  }

  get(key: string): unknown | undefined {
    const entry = this.store.get(key);
    if (entry) {
      this.hits++;
      return entry.value;
    }
    this.misses++;
    return undefined;
  }

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
