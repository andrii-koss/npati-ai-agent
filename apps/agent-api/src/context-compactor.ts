export interface CompactionResult {
  compacted: boolean;
  summary?: string;
  flushedMemories: string[];
  preservedMessages: Array<{ role: string; content: string }>;
  originalCount: number;
}

export class ContextCompactor {
  /**
   * Evaluates whether the message history should be compacted based on message count or token estimate.
   */
  static shouldCompact(
    messages: Array<{ role: string; content: string }>,
    maxMessages = 12,
    maxEstimatedTokens = 6000
  ): boolean {
    if (messages.length > maxMessages) return true;
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    return estimatedTokens > maxEstimatedTokens;
  }

  /**
   * Extracts high-value facts/preferences for memory flushing before history compaction.
   */
  static extractMemoriesToFlush(messages: Array<{ role: string; content: string }>): string[] {
    const flushed: string[] = [];
    const memoryTriggers = [
      /(?:я віддаю перевагу|ми використовуємо|наш бюджет|ціна продукту|клієнти хочуть|наша назва|правило:)\s*([^\n.;]{10,200})/gi,
      /(?:my preference is|we use|our budget is|product price is|clients want|rule:)\s*([^\n.;]{10,200})/gi,
    ];

    for (const msg of messages) {
      if (msg.role !== "user") continue;
      for (const trigger of memoryTriggers) {
        let match;
        while ((match = trigger.exec(msg.content)) !== null) {
          const item = match[0].trim();
          if (item.length >= 10 && !flushed.includes(item)) {
            flushed.push(item);
          }
        }
      }
    }

    return flushed;
  }

  /**
   * Compacts conversation history by summarizing older turns and keeping recent turns intact.
   */
  static compact(
    messages: Array<{ role: string; content: string }>,
    keepRecentTurns = 4
  ): CompactionResult {
    if (!this.shouldCompact(messages)) {
      return {
        compacted: false,
        flushedMemories: [],
        preservedMessages: messages,
        originalCount: messages.length,
      };
    }

    const flushedMemories = this.extractMemoriesToFlush(messages);
    const splitIndex = Math.max(0, messages.length - keepRecentTurns);
    const olderMessages = messages.slice(0, splitIndex);
    const preservedMessages = messages.slice(splitIndex);

    // Create a structured roll-up summary of older context
    const olderSummaryLines = olderMessages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 150).replace(/\n+/g, " ")}...`)
      .slice(0, 8);

    const summary = `[Previous Context Summary (${olderMessages.length} turns compacted)]:\n` + olderSummaryLines.join("\n");

    return {
      compacted: true,
      summary,
      flushedMemories,
      preservedMessages,
      originalCount: messages.length,
    };
  }
}
