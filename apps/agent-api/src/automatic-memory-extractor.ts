import type { AuthContext } from "@npati/workspace";
import type { CompanyKnowledgeRepository, CompanyMemory } from "./company-knowledge";

export type ExtractedMemoryCategory = "preference" | "business_policy" | "technical_detail" | "contact";

export interface ExtractedMemoryCandidate {
  content: string;
  category: ExtractedMemoryCategory;
  confidence: number;
  provenance: {
    messageIndex: number;
    role: string;
    snippet: string;
  };
}

export class AutomaticMemoryExtractor {
  private static readonly PATTERNS: Array<{
    category: ExtractedMemoryCategory;
    regex: RegExp;
    confidence: number;
    normalizer?: (match: RegExpExecArray) => string;
  }> = [
    // 1. Business Policies & Rules
    {
      category: "business_policy",
      regex: /(?:наш(?:а|е|ий)?\s+(?:бюджет|ціна|правило|політика|ліміт|тариф)|our\s+(?:budget|price|pricing|policy|rule|limit|tier))\s*(?:є|це|is|:)?\s*([^\n\r;]{6,160})/gi,
      confidence: 0.92,
      normalizer: (m) => m[0].replace(/\.+$/, "").trim(),
    },
    {
      category: "business_policy",
      regex: /(?:повернення коштів|гарантійний термін|знижка|умови оплати|refund policy|warranty period|payment terms|discount)\s*(?:є|це|is|:)?\s*([^\n\r;]{6,160})/gi,
      confidence: 0.90,
      normalizer: (m) => m[0].replace(/\.+$/, "").trim(),
    },
    // 2. Preferences
    {
      category: "preference",
      regex: /(?:я\s+(?:віддаю перевагу|надаю перевагу|люблю|вимагаю)|ми\s+використовуємо|my\s+preference\s+is|i\s+prefer|we\s+prefer|we\s+use)\s+([^\n\r;]{6,160})/gi,
      confidence: 0.88,
      normalizer: (m) => m[0].replace(/\.+$/, "").trim(),
    },
    // 3. Technical Details & Infrastructure
    {
      category: "technical_detail",
      regex: /(?:стек|архітектура|база даних|сервер|crm|api|framework|database|stack|engine)\s*(?:є|це|is|:)?\s*([^\n\r;]{6,160})/gi,
      confidence: 0.85,
      normalizer: (m) => m[0].replace(/\.+$/, "").trim(),
    },
    // 4. Contacts & Entities
    {
      category: "contact",
      regex: /(?:контакт(?:на особа|ний email|ний телефон)?|contact\s+(?:person|email|phone))\s*(?:є|це|is|:)?\s*([^\n\r;]{6,160})/gi,
      confidence: 0.87,
      normalizer: (m) => m[0].replace(/\.+$/, "").trim(),
    },
  ];

  /**
   * 1. Extract memory candidates from message turns
   */
  static extractFacts(messages: Array<{ role: string; content: string }>): ExtractedMemoryCandidate[] {
    const candidates: ExtractedMemoryCandidate[] = [];
    const seenContent = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      // Analyze user messages with highest priority, and assistant commitments
      if (!msg.content || typeof msg.content !== "string") continue;

      for (const pattern of this.PATTERNS) {
        // Reset regex state
        pattern.regex.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = pattern.regex.exec(msg.content)) !== null) {
          const rawContent = pattern.normalizer ? pattern.normalizer(match) : match[0].trim();
          const cleanContent = rawContent.replace(/\s+/g, " ").trim();

          if (cleanContent.length >= 8 && !seenContent.has(cleanContent.toLowerCase())) {
            seenContent.add(cleanContent.toLowerCase());
            candidates.push({
              content: cleanContent,
              category: pattern.category,
              confidence: pattern.confidence,
              provenance: {
                messageIndex: i,
                role: msg.role,
                snippet: msg.content.slice(Math.max(0, match.index - 20), Math.min(msg.content.length, match.index + match[0].length + 20)),
              },
            });
          }
        }
      }
    }

    return candidates;
  }

  /**
   * 2. Deduplicate extracted candidates against existing memories
   */
  static deduplicate(
    candidates: ExtractedMemoryCandidate[],
    existingMemories: Array<{ content: string }>,
    similarityThreshold = 0.7
  ): ExtractedMemoryCandidate[] {
    const existingNormalized = existingMemories.map((m) => this.tokenize(m.content));

    return candidates.filter((candidate) => {
      const candidateTokens = this.tokenize(candidate.content);
      if (candidateTokens.size === 0) return false;

      for (const existingTokens of existingNormalized) {
        const similarity = this.jaccardSimilarity(candidateTokens, existingTokens);
        if (similarity >= similarityThreshold) {
          return false; // Duplicate detected
        }
      }
      return true;
    });
  }

  /**
   * 3. Automatic extraction and persistence pipeline
   */
  static async autoExtractAndPersist(deps: {
    repo: CompanyKnowledgeRepository;
    ctx?: AuthContext;
    auth?: AuthContext;
    companyId: string;
    messages: Array<{ role: string; content: string }>;
    noMemory?: boolean;
    minConfidence?: number;
  }): Promise<CompanyMemory[]> {
    if (deps.noMemory) {
      return []; // Honor strict no-memory policy
    }

    const authContext = deps.ctx ?? deps.auth;
    if (!authContext) {
      throw new Error("AuthContext is required for memory persistence");
    }

    const minConf = deps.minConfidence ?? 0.8;
    const candidates = this.extractFacts(deps.messages).filter((c) => c.confidence >= minConf);
    if (candidates.length === 0) return [];

    const existing = await deps.repo.memories(authContext, deps.companyId);
    const uniqueCandidates = this.deduplicate(candidates, existing);

    const created: CompanyMemory[] = [];
    for (const item of uniqueCandidates) {
      const saved = await deps.repo.addMemory(
        authContext,
        deps.companyId,
        item.content,
        `auto_extracted:${item.category}`
      );
      created.push(saved);
    }

    return created;
  }

  private static tokenize(text: string): Set<string> {
    const words = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
    return new Set(words);
  }

  private static jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}
