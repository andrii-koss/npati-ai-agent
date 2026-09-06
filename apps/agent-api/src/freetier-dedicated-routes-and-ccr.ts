export interface FreeTierModelInfo {
  id: string;
  provider: string;
  name: string;
  contextWindow: number;
  requestsPerMinuteLimit: number;
  tokensPerDayLimit: number;
  usedTokensToday: number;
}

export interface DirectRouteResolution {
  isDirectRoute: boolean;
  provider?: string;
  normalizedEndpoint?: string;
  bypassArbitration: boolean;
}

export interface CcrEvaluationResult {
  threadId: string;
  rawTokens: number;
  compressedTokens: number;
  compressionRatio: number; // e.g. 0.65 = 65% reduction
  meetsThreshold: boolean;
  timestamp: string;
}

export class FreeTierCatalogManager {
  private readonly catalog = new Map<string, FreeTierModelInfo>();

  constructor() {
    this.registerModel({
      id: "google/gemini-2.0-flash-free",
      provider: "google",
      name: "Gemini 2.0 Flash (Free Tier)",
      contextWindow: 1_048_576,
      requestsPerMinuteLimit: 15,
      tokensPerDayLimit: 1_000_000,
      usedTokensToday: 0,
    });
    this.registerModel({
      id: "groq/llama-3.3-70b-free",
      provider: "groq",
      name: "Llama 3.3 70B Versatile (Free Tier)",
      contextWindow: 128_000,
      requestsPerMinuteLimit: 30,
      tokensPerDayLimit: 500_000,
      usedTokensToday: 0,
    });
    this.registerModel({
      id: "cloudflare/deepseek-r1-free",
      provider: "cloudflare",
      name: "DeepSeek R1 Distill (Workers AI Free)",
      contextWindow: 32_768,
      requestsPerMinuteLimit: 50,
      tokensPerDayLimit: 250_000,
      usedTokensToday: 0,
    });
  }

  /**
   * 1. Free-Tier Catalog: Zero-cost models directory with quota guardrails
   */
  registerModel(model: FreeTierModelInfo): void {
    this.catalog.set(model.id, model);
  }

  listFreeModels(): FreeTierModelInfo[] {
    return Array.from(this.catalog.values());
  }

  recordUsage(modelId: string, tokens: number): boolean {
    const model = this.catalog.get(modelId);
    if (!model) return false;

    model.usedTokensToday += tokens;
    return true;
  }

  isQuotaAvailable(modelId: string, expectedTokens = 1000): boolean {
    const model = this.catalog.get(modelId);
    if (!model) return false;

    return model.usedTokensToday + expectedTokens <= model.tokensPerDayLimit;
  }
}

export class DedicatedProviderRouter {
  /**
   * 2. Dedicated Provider Routes: Direct provider endpoint targeting (/v1/providers/{p}/...)
   */
  static resolve(urlPath: string): DirectRouteResolution {
    const match = urlPath.match(
      /^\/v1\/providers\/([a-zA-Z0-9_-]+)\/(chat\/completions|embeddings|models)$/
    );

    if (!match) {
      return {
        isDirectRoute: false,
        bypassArbitration: false,
      };
    }

    const provider = match[1]!.toLowerCase();
    const endpoint = match[2]!;

    return {
      isDirectRoute: true,
      provider,
      normalizedEndpoint: `/v1/${endpoint}`,
      bypassArbitration: true,
    };
  }
}

export class CcrCompressionEvaluator {
  private readonly history = new Map<string, CcrEvaluationResult[]>();

  /**
   * 3. CCR (Context Compression Ratio): Evaluates and tracks token reduction ratio
   */
  evaluateTurn(
    threadId: string,
    rawTokens: number,
    compressedTokens: number,
    minRequiredCcr = 0.3
  ): CcrEvaluationResult {
    const reduction = Math.max(0, rawTokens - compressedTokens);
    const ratio = rawTokens > 0 ? Number((reduction / rawTokens).toFixed(4)) : 0;
    const meetsThreshold = ratio >= minRequiredCcr;

    const result: CcrEvaluationResult = {
      threadId,
      rawTokens,
      compressedTokens,
      compressionRatio: ratio,
      meetsThreshold,
      timestamp: new Date().toISOString(),
    };

    const threadHistory = this.history.get(threadId) ?? [];
    threadHistory.push(result);
    this.history.set(threadId, threadHistory);

    return result;
  }

  getAverageCcr(threadId: string): number {
    const list = this.history.get(threadId);
    if (!list || list.length === 0) return 0;

    const sum = list.reduce((acc, curr) => acc + curr.compressionRatio, 0);
    return Number((sum / list.length).toFixed(4));
  }
}
