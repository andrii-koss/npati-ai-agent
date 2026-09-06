export interface LiteCompressionResult {
  compressedText: string;
  originalTokens: number;
  compressedTokens: number;
  reductionPercentage: number;
  durationMs: number;
}

export interface ToolOutputCompressionResult {
  compressedOutput: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  isTruncated: boolean;
}

export interface HeadroomEnforcementResult {
  messages: Array<{ role: string; content: string }>;
  headroomReservedTokens: number;
  trimmedTurnsCount: number;
  totalTokens: number;
}

export class LitePromptCompressor {
  /**
   * 1. Lite: Sub-millisecond rule-based prompt compression
   */
  static compress(text: string): LiteCompressionResult {
    const start = performance.now();
    const originalTokens = Math.ceil(text.length / 4);

    // Fast rule-based reductions:
    // - Collapse multiple blank lines into one
    // - Strip redundant markdown bold/italic tags if purely cosmetic
    // - Remove leading/trailing trailing whitespace per line
    const compressed = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
      .join("\n")
      .replace(/(\*\*|__)(.*?)\1/g, "$2") // Remove cosmetic markdown bold
      .trim();

    const compressedTokens = Math.ceil(compressed.length / 4);
    const reductionPercentage =
      originalTokens > 0
        ? Number((((originalTokens - compressedTokens) / originalTokens) * 100).toFixed(1))
        : 0;

    const durationMs = Number((performance.now() - start).toFixed(3));

    return {
      compressedText: compressed,
      originalTokens,
      compressedTokens,
      reductionPercentage,
      durationMs,
    };
  }
}

export class ToolOutputCompressor {
  /**
   * 2. Responses Tool Output: Compacts verbose JSON arrays, tables, and tool outputs
   */
  static compress(output: unknown, maxTokens = 200): ToolOutputCompressionResult {
    const rawString = typeof output === "string" ? output : JSON.stringify(output);
    const originalSizeBytes = Buffer.byteLength(rawString);
    const maxChars = maxTokens * 4;

    if (originalSizeBytes <= maxChars) {
      return {
        compressedOutput: rawString,
        originalSizeBytes,
        compressedSizeBytes: originalSizeBytes,
        isTruncated: false,
      };
    }

    // Structured JSON compaction
    if (typeof output === "object" && output !== null) {
      if (Array.isArray(output)) {
        const sampleSize = Math.min(3, output.length);
        const sampled = output.slice(0, sampleSize);
        const compacted = JSON.stringify({
          sample: sampled,
          totalCount: output.length,
          omittedCount: output.length - sampleSize,
          summary: `Truncated ${output.length - sampleSize} array items to preserve context.`,
        });

        return {
          compressedOutput: compacted,
          originalSizeBytes,
          compressedSizeBytes: Buffer.byteLength(compacted),
          isTruncated: true,
        };
      } else {
        const keys = Object.keys(output);
        const sampleObj: Record<string, unknown> = {};
        for (const k of keys.slice(0, 5)) {
          sampleObj[k] = (output as Record<string, unknown>)[k];
        }
        const compacted = JSON.stringify({
          ...sampleObj,
          _omittedKeys: keys.slice(5),
        });

        return {
          compressedOutput: compacted,
          originalSizeBytes,
          compressedSizeBytes: Buffer.byteLength(compacted),
          isTruncated: true,
        };
      }
    }

    // Raw text truncation (head + tail)
    const half = Math.floor(maxChars / 2);
    const compacted = `${rawString.slice(0, half)}\n\n[... Truncated ${rawString.length - maxChars} characters ...]\n\n${rawString.slice(-half)}`;

    return {
      compressedOutput: compacted,
      originalSizeBytes,
      compressedSizeBytes: Buffer.byteLength(compacted),
      isTruncated: true,
    };
  }
}

export class ContextHeadroomCompressor {
  /**
   * 3. Headroom: Proactively reserves token headroom for model generation
   */
  static enforce(
    messages: Array<{ role: string; content: string }>,
    maxContextTokens: number,
    targetHeadroomTokens = 4096
  ): HeadroomEnforcementResult {
    const maxAllowedPromptTokens = Math.max(1000, maxContextTokens - targetHeadroomTokens);
    let currentTokens = messages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0);

    if (currentTokens <= maxAllowedPromptTokens) {
      return {
        messages,
        headroomReservedTokens: targetHeadroomTokens,
        trimmedTurnsCount: 0,
        totalTokens: currentTokens,
      };
    }

    // Preserve system message if present
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");
    let trimmedCount = 0;

    while (
      nonSystemMessages.length > 2 &&
      currentTokens > maxAllowedPromptTokens
    ) {
      const removed = nonSystemMessages.shift();
      if (removed) {
        trimmedCount++;
        currentTokens -= Math.ceil(removed.content.length / 4);
      }
    }

    const finalMessages = systemMessage
      ? [systemMessage, ...nonSystemMessages]
      : nonSystemMessages;

    return {
      messages: finalMessages,
      headroomReservedTokens: targetHeadroomTokens,
      trimmedTurnsCount: trimmedCount,
      totalTokens: currentTokens,
    };
  }
}
