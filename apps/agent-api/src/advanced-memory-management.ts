import { randomUUID } from "node:crypto";

export type MemoryDecayType = "ephemeral" | "operational" | "project_rule" | "immutable";

export interface DecayingMemoryItem {
  id: string;
  type: MemoryDecayType;
  title: string;
  content: string;
  baseWeight: number; // 0.0 to 1.0
  createdAt: string;
}

export interface RankedMemoryFact {
  id: string;
  type: MemoryDecayType;
  title: string;
  content: string;
  effectiveWeight: number;
  rerankScore: number;
  finalScore: number;
  rank: number;
}

export interface DailyNoteEntry {
  id: string;
  companyId: string;
  date: string; // YYYY-MM-DD
  topic: string;
  text: string;
  agentId?: string;
  timestamp: string;
}

export class TypedDecayMemoryManager {
  private static readonly HALF_LIFE_HOURS: Record<MemoryDecayType, number> = {
    ephemeral: 24,         // 1 day
    operational: 24 * 7,   // 7 days
    project_rule: 24 * 60, // 60 days
    immutable: Infinity,   // Never decays
  };

  /**
   * 1. Typed Decay: Calculates time-decayed weight according to memory category
   */
  static calculateEffectiveWeight(
    item: DecayingMemoryItem,
    referenceTime: Date = new Date()
  ): number {
    if (item.type === "immutable") {
      return item.baseWeight;
    }

    const halfLife = this.HALF_LIFE_HOURS[item.type];
    const createdMs = new Date(item.createdAt).getTime();
    const elapsedHours = Math.max(0, (referenceTime.getTime() - createdMs) / (1000 * 60 * 60));

    const decayFactor = Math.pow(0.5, elapsedHours / halfLife);
    return Number((item.baseWeight * decayFactor).toFixed(4));
  }
}

export class MemoryRerankEngine {
  /**
   * 2. Memory Rerank: Re-ranks and deduplicates memories against active dialogue context
   */
  static rerankMemories(
    contextQuery: string,
    candidates: DecayingMemoryItem[],
    options: { topK?: number; minFinalScore?: number } = {}
  ): { rankedMemories: RankedMemoryFact[]; totalEvaluated: number } {
    const topK = options.topK ?? 5;
    const minFinalScore = options.minFinalScore ?? 0.1;
    const queryTerms = contextQuery.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

    const scoredList: RankedMemoryFact[] = candidates.map((item) => {
      const effectiveWeight = TypedDecayMemoryManager.calculateEffectiveWeight(item);
      const itemText = `${item.title} ${item.content}`.toLowerCase();

      let matchCount = 0;
      for (const t of queryTerms) {
        if (itemText.includes(t)) matchCount++;
      }

      const termRatio = queryTerms.length > 0 ? matchCount / queryTerms.length : 0.5;
      const rerankScore = Number((termRatio * 0.7 + 0.3).toFixed(4));
      const finalScore = Number((rerankScore * 0.6 + effectiveWeight * 0.4).toFixed(4));

      return {
        id: item.id,
        type: item.type,
        title: item.title,
        content: item.content,
        effectiveWeight,
        rerankScore,
        finalScore,
        rank: 0,
      };
    });

    // Sort descending by final combined score
    scoredList.sort((a, b) => b.finalScore - a.finalScore);

    const filtered = scoredList
      .filter((m) => m.finalScore >= minFinalScore)
      .slice(0, topK)
      .map((m, idx) => ({ ...m, rank: idx + 1 }));

    return {
      rankedMemories: filtered,
      totalEvaluated: candidates.length,
    };
  }
}

export class DailyMemoryJournal {
  private readonly notes = new Map<string, DailyNoteEntry[]>();

  private getKey(companyId: string, date: string): string {
    return `${companyId}:${date}`;
  }

  /**
   * 3. Daily Memory Notes: Appends chronological daily notes (YYYY-MM-DD)
   */
  appendNote(params: {
    companyId: string;
    date?: string;
    topic: string;
    text: string;
    agentId?: string;
  }): DailyNoteEntry {
    const date = params.date || new Date().toISOString().slice(0, 10);
    const key = this.getKey(params.companyId, date);

    const entry: DailyNoteEntry = {
      id: `note_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      companyId: params.companyId,
      date,
      topic: params.topic,
      text: params.text,
      agentId: params.agentId,
      timestamp: new Date().toISOString(),
    };

    const list = this.notes.get(key) || [];
    list.push(entry);
    this.notes.set(key, list);

    return entry;
  }

  getNotesForDate(companyId: string, date: string): DailyNoteEntry[] {
    return this.notes.get(this.getKey(companyId, date)) || [];
  }

  formatDailySummaryMarkdown(companyId: string, date: string): string {
    const notes = this.getNotesForDate(companyId, date);
    if (notes.length === 0) return `# Daily Notes (${date})\n\nNo recorded notes for this day.`;

    const lines = [`# Daily Notes (${date})`, ""];
    for (const n of notes) {
      lines.push(`### ${n.topic}`, n.text, "");
    }

    return lines.join("\n").trim();
  }
}
