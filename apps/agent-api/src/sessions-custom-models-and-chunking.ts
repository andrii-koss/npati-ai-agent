export interface PrunableSession {
  sessionId: string;
  tenantId: string;
  lastActiveAt: number; // timestamp ms
  messages: Array<{ role: string; content: string }>;
  isArchived?: boolean;
}

export interface PruneResult {
  prunedSessionsCount: number;
  truncatedMessagesCount: number;
  archivedSessionsCount: number;
  remainingSessionsCount: number;
}

export interface CustomModelEndpoint {
  id: string;
  name: string;
  tenantId?: string;
  baseUrl: string;
  apiKey?: string;
  format: "openai" | "vllm" | "ollama" | "tgi";
  contextWindowTokens: number;
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
  isSelfHosted: boolean;
  createdAt: string;
}

export class SessionPruningManager {
  /**
   * 1. Session Pruning: Cleans up expired sessions and truncates oversized message logs
   */
  static prune(
    sessions: PrunableSession[],
    options: {
      maxInactiveDays?: number;
      maxMessagesPerSession?: number;
      archiveBeforeDelete?: boolean;
    } = {}
  ): { activeSessions: PrunableSession[]; result: PruneResult } {
    const maxInactiveMs = (options.maxInactiveDays ?? 30) * 86_400_000;
    const maxMessages = options.maxMessagesPerSession ?? 100;
    const now = Date.now();

    const activeSessions: PrunableSession[] = [];
    let prunedCount = 0;
    let truncatedCount = 0;
    let archivedCount = 0;

    for (const session of sessions) {
      const isInactive = now - session.lastActiveAt > maxInactiveMs;

      if (isInactive) {
        if (options.archiveBeforeDelete) {
          session.isArchived = true;
          archivedCount++;
          activeSessions.push(session);
        } else {
          prunedCount++;
          continue; // Delete/drop
        }
      } else {
        // Truncate message history if exceeding limits
        if (session.messages.length > maxMessages) {
          const systemMsg = session.messages.find((m) => m.role === "system");
          const recent = session.messages.slice(-maxMessages + (systemMsg ? 1 : 0));
          const removed = session.messages.length - (recent.length + (systemMsg ? 1 : 0));
          truncatedCount += removed;

          session.messages = systemMsg ? [systemMsg, ...recent] : recent;
        }
        activeSessions.push(session);
      }
    }

    return {
      activeSessions,
      result: {
        prunedSessionsCount: prunedCount,
        truncatedMessagesCount: truncatedCount,
        archivedSessionsCount: archivedCount,
        remainingSessionsCount: activeSessions.length,
      },
    };
  }
}

export class CustomModelRegistry {
  private readonly customModels = new Map<string, CustomModelEndpoint>();

  /**
   * 2. Custom / Self-Hosted Models: Registers private vLLM, Ollama, or custom endpoints
   */
  registerModel(params: {
    id: string;
    name: string;
    baseUrl: string;
    tenantId?: string;
    apiKey?: string;
    format?: "openai" | "vllm" | "ollama" | "tgi";
    contextWindowTokens?: number;
    inputCostPerMillionUsd?: number;
    outputCostPerMillionUsd?: number;
  }): CustomModelEndpoint {
    const endpoint: CustomModelEndpoint = {
      id: params.id,
      name: params.name,
      tenantId: params.tenantId,
      baseUrl: params.baseUrl.replace(/\/+$/, ""),
      apiKey: params.apiKey,
      format: params.format ?? "openai",
      contextWindowTokens: params.contextWindowTokens ?? 32_768,
      inputCostPerMillionUsd: params.inputCostPerMillionUsd ?? 0.0, // Private models typically 0 inference cost
      outputCostPerMillionUsd: params.outputCostPerMillionUsd ?? 0.0,
      isSelfHosted: true,
      createdAt: new Date().toISOString(),
    };

    this.customModels.set(params.id, endpoint);
    return endpoint;
  }

  getModel(id: string): CustomModelEndpoint | undefined {
    return this.customModels.get(id);
  }

  listModels(tenantId?: string): CustomModelEndpoint[] {
    const all = Array.from(this.customModels.values());
    return tenantId ? all.filter((m) => !m.tenantId || m.tenantId === tenantId) : all;
  }

  deleteModel(id: string): boolean {
    return this.customModels.delete(id);
  }
}

export class ResponseChunkingEngine {
  /**
   * 3. Response Chunking: Splits large AI messages at paragraphs without breaking code blocks
   */
  static chunk(
    text: string,
    maxChunkSize = 1000
  ): string[] {
    if (text.length <= maxChunkSize) {
      return [text];
    }

    const paragraphs = text.split("\n\n");
    const chunks: string[] = [];
    let currentChunk = "";
    let insideCodeBlock = false;
    let codeLanguage = "";

    for (const para of paragraphs) {
      // Check if this paragraph alters code block state
      const codeMatches = para.match(/```([a-zA-Z0-9_-]*)/g);
      const toggleCount = codeMatches ? codeMatches.length : 0;

      const proposed = currentChunk ? `${currentChunk}\n\n${para}` : para;

      if (proposed.length <= maxChunkSize) {
        currentChunk = proposed;
        if (toggleCount % 2 !== 0) {
          insideCodeBlock = !insideCodeBlock;
          if (insideCodeBlock && codeMatches) {
            codeLanguage = codeMatches[codeMatches.length - 1]!.replace("```", "");
          }
        }
      } else {
        // Must flush current chunk
        if (insideCodeBlock) {
          // Close fence in current chunk, reopen in next
          currentChunk += "\n```";
          chunks.push(currentChunk);
          currentChunk = `\`\`\`${codeLanguage}\n${para}`;
        } else {
          chunks.push(currentChunk);
          currentChunk = para;
        }

        if (toggleCount % 2 !== 0) {
          insideCodeBlock = !insideCodeBlock;
          if (insideCodeBlock && codeMatches) {
            codeLanguage = codeMatches[codeMatches.length - 1]!.replace("```", "");
          }
        }
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk);
    }

    return chunks;
  }
}
