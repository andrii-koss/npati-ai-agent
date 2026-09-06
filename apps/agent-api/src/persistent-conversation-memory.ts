export interface ConversationMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  tokenCount: number;
}

export interface ConversationSessionState {
  sessionId: string;
  companyId: string;
  tenantId: string;
  messages: ConversationMessage[];
  summaryContext?: string;
  maxWindowTokens: number;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
}

export class PersistentConversationMemory {
  private readonly sessions = new Map<string, ConversationSessionState>();

  getOrCreateSession(
    sessionId: string,
    companyId: string,
    tenantId: string,
    maxWindowTokens?: number
  ): ConversationSessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const now = new Date().toISOString();
      session = {
        sessionId,
        companyId,
        tenantId,
        messages: [],
        maxWindowTokens: maxWindowTokens ?? 8000,
        totalTokens: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.sessions.set(sessionId, session);
    } else if (maxWindowTokens !== undefined) {
      session.maxWindowTokens = maxWindowTokens;
    }
    return session;
  }

  /**
   * Append message and apply sliding dialogue window compaction
   */
  appendMessage(
    sessionId: string,
    companyId: string,
    tenantId: string,
    role: ConversationMessage["role"],
    content: string,
    maxWindowTokens?: number
  ): ConversationMessage {
    const session = this.getOrCreateSession(sessionId, companyId, tenantId, maxWindowTokens);
    const tokenCount = Math.ceil(content.length / 4);

    const msg: ConversationMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role,
      content,
      timestamp: new Date().toISOString(),
      tokenCount,
    };

    session.messages.push(msg);
    session.totalTokens += tokenCount;
    session.updatedAt = new Date().toISOString();

    this.compactWindow(session);
    return msg;
  }

  /**
   * Compact sliding window when token limit is exceeded
   */
  private compactWindow(session: ConversationSessionState): void {
    if (session.totalTokens <= session.maxWindowTokens || session.messages.length <= 2) {
      return;
    }

    // Keep system messages and last N messages
    const systemMsgs = session.messages.filter((m) => m.role === "system");
    const nonSystemMsgs = session.messages.filter((m) => m.role !== "system");

    // Summarize older messages
    const toSummarize = nonSystemMsgs.slice(0, nonSystemMsgs.length - 2);
    const toKeep = nonSystemMsgs.slice(nonSystemMsgs.length - 2);

    if (toSummarize.length > 0) {
      const summaryFragment = toSummarize
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 80)}...`)
        .join("\n");
      session.summaryContext = session.summaryContext
        ? `${session.summaryContext}\n${summaryFragment}`
        : `Previous Discussion Summary:\n${summaryFragment}`;
    }

    session.messages = [...systemMsgs, ...toKeep];
    session.totalTokens = session.messages.reduce((sum, m) => sum + m.tokenCount, 0);
  }

  /**
   * Get formatted context messages for LLM completion
   */
  getContextMessages(
    sessionId: string,
    companyId: string,
    tenantId: string
  ): Array<{ role: string; content: string }> {
    const session = this.getOrCreateSession(sessionId, companyId, tenantId);
    const result: Array<{ role: string; content: string }> = [];

    if (session.summaryContext) {
      result.push({
        role: "system",
        content: `[Historical Context Summary]:\n${session.summaryContext}`,
      });
    }

    for (const msg of session.messages) {
      result.push({ role: msg.role, content: msg.content });
    }

    return result;
  }

  /**
   * Clear session history
   */
  clearSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }
}
