import { randomUUID } from "node:crypto";

export interface StandingIntent {
  id: string;
  companyId: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "fulfilled" | "cancelled";
  triggerKeywords: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface WikiPage {
  path: string; // e.g. "engineering/architecture"
  companyId: string;
  title: string;
  content: string;
  tags: string[];
  outboundLinks: string[]; // paths linked via [[Path]]
  updatedAt: string;
}

export interface DreamingCycleResult {
  consolidatedFactsCount: number;
  prunedDecayedCount: number;
  resolvedContradictions: number;
  synthesizedWikiPages: string[];
  cycleTimestamp: string;
}

export class StandingIntentsTracker {
  private readonly intents = new Map<string, StandingIntent>();

  /**
   * 1. Standing Intents: Track long-running user intents across sessions
   */
  registerIntent(params: {
    companyId: string;
    title: string;
    description: string;
    triggerKeywords?: string[];
  }): StandingIntent {
    const id = `intent_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    const intent: StandingIntent = {
      id,
      companyId: params.companyId,
      title: params.title,
      description: params.description,
      status: "pending",
      triggerKeywords: params.triggerKeywords ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.intents.set(id, intent);
    return intent;
  }

  findMatchingIntents(companyId: string, messageText: string): StandingIntent[] {
    const textLower = messageText.toLowerCase();
    return Array.from(this.intents.values()).filter((intent) => {
      if (intent.companyId !== companyId || intent.status === "fulfilled" || intent.status === "cancelled") {
        return false;
      }
      if (intent.triggerKeywords.length === 0) return true;
      return intent.triggerKeywords.some((kw) => textLower.includes(kw.toLowerCase()));
    });
  }

  fulfillIntent(intentId: string): boolean {
    const intent = this.intents.get(intentId);
    if (!intent) return false;
    intent.status = "fulfilled";
    intent.resolvedAt = new Date().toISOString();
    intent.updatedAt = intent.resolvedAt;
    return true;
  }
}

export class MemoryWikiEngine {
  private readonly pages = new Map<string, WikiPage>();

  private getKey(companyId: string, path: string): string {
    return `${companyId}:${path.toLowerCase()}`;
  }

  /**
   * 2. Memory Wiki: Hierarchical Markdown Wiki with Bidirectional [[Wikilinks]]
   */
  upsertPage(params: {
    companyId: string;
    path: string;
    title: string;
    content: string;
    tags?: string[];
  }): WikiPage {
    const key = this.getKey(params.companyId, params.path);
    const outboundLinks: string[] = [];

    // Extract [[Target Page]] wikilinks
    const wikilinkRegex = /\[\[([a-zA-Z0-9_\-\/]+)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = wikilinkRegex.exec(params.content)) !== null) {
      outboundLinks.push(match[1]!.toLowerCase());
    }

    const page: WikiPage = {
      path: params.path.toLowerCase(),
      companyId: params.companyId,
      title: params.title,
      content: params.content,
      tags: params.tags ?? [],
      outboundLinks,
      updatedAt: new Date().toISOString(),
    };

    this.pages.set(key, page);
    return page;
  }

  getPage(companyId: string, path: string): WikiPage | null {
    return this.pages.get(this.getKey(companyId, path)) || null;
  }

  getBacklinks(companyId: string, targetPath: string): string[] {
    const target = targetPath.toLowerCase();
    const backlinks: string[] = [];

    for (const page of this.pages.values()) {
      if (page.companyId === companyId && page.outboundLinks.includes(target)) {
        backlinks.push(page.path);
      }
    }

    return backlinks;
  }
}

export class DreamingConsolidationEngine {
  /**
   * 3. Dreaming: Background memory synthesis, deduplication, and decay pruning
   */
  static runConsolidationCycle(
    memoryItems: Array<{ id: string; title: string; content: string; weight: number }>,
    wikiEngine?: MemoryWikiEngine,
    companyId = "comp-default"
  ): DreamingCycleResult {
    let prunedDecayedCount = 0;
    const activeFacts: Array<{ id: string; title: string; content: string }> = [];

    // 1. Prune zero or near-zero decayed items
    for (const item of memoryItems) {
      if (item.weight < 0.05) {
        prunedDecayedCount++;
      } else {
        activeFacts.push(item);
      }
    }

    // 2. Synthesize consolidated wiki overview page
    const synthesizedWikiPages: string[] = [];
    if (wikiEngine && activeFacts.length > 0) {
      const summaryMarkdown = [
        "# Consolidated Enterprise Knowledge (Dreaming Cycle)",
        "",
        "## Active Working Facts",
        ...activeFacts.map((f) => `- **${f.title}**: ${f.content}`),
      ].join("\n");

      wikiEngine.upsertPage({
        companyId,
        path: "consolidated/dreaming-summary",
        title: "Consolidated Enterprise Knowledge",
        content: summaryMarkdown,
        tags: ["dreaming", "auto-consolidated"],
      });

      synthesizedWikiPages.push("consolidated/dreaming-summary");
    }

    return {
      consolidatedFactsCount: activeFacts.length,
      prunedDecayedCount,
      resolvedContradictions: 0,
      synthesizedWikiPages,
      cycleTimestamp: new Date().toISOString(),
    };
  }
}
