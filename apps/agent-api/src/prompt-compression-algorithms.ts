export interface CompressionResult {
  compressedText: string;
  originalTokens: number;
  compressedTokens: number;
  reductionPercent: number;
  method: "relevance" | "aggressive" | "llmlingua-2";
}

export interface RelevanceTurnCompressionResult {
  compressedTurns: Array<{ role: string; content: string; relevanceScore?: number }>;
  originalTurnsCount: number;
  retainedTurnsCount: number;
  estimatedTokensSaved: number;
}

export class RelevancePromptCompressor {
  /**
   * 1. Relevance Compression: Filters out past conversation turns with low semantic relevance
   */
  static compressByRelevance(
    query: string,
    turns: Array<{ role: string; content: string }>,
    minRelevanceScore = 0.2
  ): RelevanceTurnCompressionResult {
    const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const compressedTurns: Array<{ role: string; content: string; relevanceScore: number }> = [];

    let originalLength = 0;
    let retainedLength = 0;

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      originalLength += turn.content.length;

      // Always preserve system prompts and the immediate last user/assistant turn
      if (turn.role === "system" || i >= turns.length - 2) {
        compressedTurns.push({ ...turn, relevanceScore: 1.0 });
        retainedLength += turn.content.length;
        continue;
      }

      // Calculate term overlap
      const turnLower = turn.content.toLowerCase();
      let matches = 0;
      for (const term of queryTerms) {
        if (turnLower.includes(term)) matches++;
      }

      const score = queryTerms.length > 0 ? matches / queryTerms.length : 1.0;

      if (score >= minRelevanceScore) {
        compressedTurns.push({ ...turn, relevanceScore: Number(score.toFixed(2)) });
        retainedLength += turn.content.length;
      }
    }

    const tokensSaved = Math.max(0, Math.ceil((originalLength - retainedLength) / 4));

    return {
      compressedTurns,
      originalTurnsCount: turns.length,
      retainedTurnsCount: compressedTurns.length,
      estimatedTokensSaved: tokensSaved,
    };
  }
}

export class AggressivePromptCompressor {
  private static readonly FILLER_REGEX =
    /\b(please note that|it is important to remember that|as an ai language model|as previously mentioned|needless to say|furthermore|in order to)\b/gi;

  /**
   * 2. Aggressive Compression: Prunes conversational fillers, verbose whitespace, and repetitive formatting
   */
  static compress(
    text: string,
    options: { preserveCodeBlocks?: boolean } = {}
  ): CompressionResult {
    const originalTokens = Math.ceil(text.length / 4);

    let result = text;

    // Isolate and protect code blocks
    const codeBlocks: string[] = [];
    if (options.preserveCodeBlocks ?? true) {
      result = result.replace(/```[\s\S]*?```/g, (match) => {
        codeBlocks.push(match);
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
      });
    }

    // Strip filler phrases
    result = result.replace(this.FILLER_REGEX, "");

    // Collapse multiple blank lines to a single newline
    result = result.replace(/\n\s*\n\s*\n+/g, "\n\n");

    // Collapse multi-spaces
    result = result.replace(/[ \t]{2,}/g, " ");

    // Restore protected code blocks
    for (let i = 0; i < codeBlocks.length; i++) {
      result = result.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]!);
    }

    const compressedTokens = Math.ceil(result.length / 4);
    const reductionPercent =
      originalTokens > 0
        ? Math.round(((originalTokens - compressedTokens) / originalTokens) * 100)
        : 0;

    return {
      compressedText: result.trim(),
      originalTokens,
      compressedTokens,
      reductionPercent: Math.max(0, reductionPercent),
      method: "aggressive",
    };
  }
}

export class LlmLingua2Compressor {
  private static readonly LOW_ENTROPY_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "so", "very", "really",
    "just", "quite", "basically", "actually", "literally", "simply",
  ]);

  /**
   * 3. LLMLingua-2: Token-level entropy and information density pruning
   */
  static compressWithLingua(
    text: string,
    targetRetentionRatio = 0.6
  ): CompressionResult {
    const originalTokens = Math.ceil(text.length / 4);
    const words = text.split(/\s+/);

    if (words.length <= 5) {
      return {
        compressedText: text,
        originalTokens,
        compressedTokens: originalTokens,
        reductionPercent: 0,
        method: "llmlingua-2",
      };
    }

    const retainedWords: string[] = [];
    for (const word of words) {
      const cleanWord = word.toLowerCase().replace(/[^a-z0-9]/g, "");

      // If low entropy word and we need to reduce size -> drop it
      if (
        this.LOW_ENTROPY_WORDS.has(cleanWord) &&
        retainedWords.length / words.length > targetRetentionRatio
      ) {
        continue;
      }

      retainedWords.push(word);
    }

    const compressedText = retainedWords.join(" ");
    const compressedTokens = Math.ceil(compressedText.length / 4);
    const reductionPercent =
      originalTokens > 0
        ? Math.round(((originalTokens - compressedTokens) / originalTokens) * 100)
        : 0;

    return {
      compressedText,
      originalTokens,
      compressedTokens,
      reductionPercent: Math.max(0, reductionPercent),
      method: "llmlingua-2",
    };
  }
}
