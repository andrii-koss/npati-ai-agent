export interface CompressionMetrics {
  originalTokens: number;
  compressedTokens: number;
  ratio: number;
  output: string;
}

export class CavemanCompressor {
  /**
   * 1. Caveman: Telegraphic grammar compression stripping polite fluff and articles
   */
  static compress(text: string): CompressionMetrics {
    const originalTokens = Math.ceil(text.length / 4);

    // If text has code fences, preserve them intact
    const parts = text.split(/(```[\s\S]*?```)/g);

    const processedParts = parts.map((part) => {
      if (part.startsWith("```")) return part;

      return part
        .replace(/\b(could you please|would you kindly|can you please|please note that|as mentioned previously)\b/gi, "")
        .replace(/\b(a|an|the)\b/gi, "")
        .replace(/\b(is|are|was|were|being|been)\s+(able to|going to)\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    });

    const output = processedParts.join("\n").trim();
    const compressedTokens = Math.ceil(output.length / 4);
    const ratio = originalTokens > 0 ? Number(((originalTokens - compressedTokens) / originalTokens).toFixed(4)) : 0;

    return {
      originalTokens,
      compressedTokens,
      ratio,
      output,
    };
  }
}

export class UltraCompressor {
  /**
   * 2. Ultra: Maximalist token reduction engine for historical chat logs
   */
  static compress(text: string): CompressionMetrics {
    const originalTokens = Math.ceil(text.length / 4);

    // 1. First run caveman compression
    let condensed = CavemanCompressor.compress(text).output;

    // 2. Strip ISO timestamps and UUIDs in logs
    condensed = condensed
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "[TIME]")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[ID]")
      // 3. Deduplicate repeating lines
      .split("\n")
      .filter((line, index, arr) => line !== arr[index - 1])
      .join("\n")
      .trim();

    const compressedTokens = Math.ceil(condensed.length / 4);
    const ratio = originalTokens > 0 ? Number(((originalTokens - compressedTokens) / originalTokens).toFixed(4)) : 0;

    return {
      originalTokens,
      compressedTokens,
      ratio,
      output: condensed,
    };
  }
}

export class OmniGlyphCompressor {
  private static readonly GLYPH_MAP: Array<[RegExp, string, string]> = [
    [/\buser:\s*/gi, "👤", "user: "],
    [/\bassistant:\s*/gi, "🤖", "assistant: "],
    [/\bsystem:\s*/gi, "⚙️", "system: "],
    [/\b(success|completed|passed)\b/gi, "✓", "success"],
    [/\b(error|failed|failure)\b/gi, "✗", "error"],
    [/\b(warning|caution)\b/gi, "⚠️", "warning"],
    [/\b(function|tool_call)\b/gi, "⚡", "function"],
    [/\b(package|module)\b/gi, "📦", "package"],
  ];

  /**
   * 3. OmniGlyph: Compact Unicode glyph encoding for recurring prompt tokens
   */
  static encode(text: string): CompressionMetrics {
    const originalTokens = Math.ceil(text.length / 4);
    let encoded = text;

    for (const [pattern, glyph] of this.GLYPH_MAP) {
      encoded = encoded.replace(pattern, glyph);
    }

    const compressedTokens = Math.ceil(encoded.length / 4);
    const ratio = originalTokens > 0 ? Number(((originalTokens - compressedTokens) / originalTokens).toFixed(4)) : 0;

    return {
      originalTokens,
      compressedTokens,
      ratio,
      output: encoded,
    };
  }

  static decode(encodedText: string): string {
    let decoded = encodedText;
    for (const [, glyph, replacement] of this.GLYPH_MAP) {
      decoded = decoded.split(glyph).join(replacement);
    }
    return decoded;
  }
}
