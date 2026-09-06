import { ScopedMemoryEngine, type ScopedMemoryItem } from "./scoped-memory";
import { UserModelProfileManager } from "./user-model-profile";
import { MemoryMdManager } from "./memory-md-manager";

export interface MemoryInjectionOptions {
  baseSystemPrompt: string;
  companyId: string;
  tenantId: string;
  userId?: string;
  apiKeyId?: string;
  sessionId?: string;
  query?: string;
  maxMemoryTokens?: number;
}

export interface InjectedPromptResult {
  finalSystemPrompt: string;
  injectedItemsCount: number;
  userProfileIncluded: boolean;
  longTermMemoryIncluded: boolean;
  estimatedTokens: number;
}

export class MemoryInjectionEngine {
  constructor(
    private readonly scopedMemoryEngine: ScopedMemoryEngine,
    private readonly userProfileManager: UserModelProfileManager,
    private readonly memoryMdManager: MemoryMdManager
  ) {}

  /**
   * Dynamically compose and inject memory context into system prompt prefix
   */
  async injectMemory(options: MemoryInjectionOptions): Promise<InjectedPromptResult> {
    const memoryBlocks: string[] = [];
    let injectedItemsCount = 0;
    let userProfileIncluded = false;
    let longTermMemoryIncluded = false;

    // 1. Inject User Profile (USER.md) if userId is supplied
    if (options.userId) {
      const userMd = this.userProfileManager.getUserMarkdown(options.userId);
      if (userMd) {
        memoryBlocks.push("### User Profile (USER.md)\n" + userMd.trim());
        userProfileIncluded = true;
      }
    }

    // 2. Inject Company Long-Term Memory (MEMORY.md)
    const longTermMd = this.memoryMdManager.getMemoryMarkdown(options.companyId);
    if (longTermMd) {
      memoryBlocks.push("### Company Long-Term Memory (MEMORY.md)\n" + longTermMd.trim());
      longTermMemoryIncluded = true;
    }

    // 3. Inject Scoped Dynamic Memories (Scoped by API Key or Session ID)
    const scopedMemories = await this.scopedMemoryEngine.retrieveMemories({
      companyId: options.companyId,
      tenantId: options.tenantId,
      apiKeyId: options.apiKeyId,
      sessionId: options.sessionId,
      query: options.query,
      limit: 10,
    });

    if (scopedMemories.length > 0) {
      const factLines = scopedMemories.map((m) => `- [${m.category.toUpperCase()}] ${m.title}: ${m.content}`);
      memoryBlocks.push("### Relevant Knowledge & Facts\n" + factLines.join("\n"));
      injectedItemsCount = scopedMemories.length;
    }

    if (memoryBlocks.length === 0) {
      return {
        finalSystemPrompt: options.baseSystemPrompt,
        injectedItemsCount: 0,
        userProfileIncluded: false,
        longTermMemoryIncluded: false,
        estimatedTokens: Math.ceil(options.baseSystemPrompt.length / 4),
      };
    }

    const contextHeader = [
      "<context_memory>",
      "The following verified enterprise context and user preferences are provided for grounding:",
      "",
      memoryBlocks.join("\n\n"),
      "</context_memory>",
      "",
      options.baseSystemPrompt,
    ].join("\n");

    return {
      finalSystemPrompt: contextHeader,
      injectedItemsCount,
      userProfileIncluded,
      longTermMemoryIncluded,
      estimatedTokens: Math.ceil(contextHeader.length / 4),
    };
  }
}
