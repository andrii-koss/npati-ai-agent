import type { AuthContext } from "@npati/workspace";
import type { CompanyKnowledgeRepository, CompanyMemory } from "./company-knowledge";

export type ExtractedMemoryCategory = "preference" | "business_policy" | "technical_detail" | "contact" | "constraint" | "decision";

export interface ExtractedMemoryCandidate {
  content: string;
  category: ExtractedMemoryCategory;
  confidence: number;
  provenance: { messageIndex: number; role: "user"; snippet: string };
}

export class AutomaticMemoryExtractor {
  private static readonly PATTERNS: Array<{
    category: ExtractedMemoryCategory;
    regex: RegExp;
    confidence: number;
  }> = [
    { category: "business_policy", regex: /(?:наш(?:а|е|і|ий)?\s+(?:бюджет|ціна|правило|політика|ліміт|тариф)|our\s+(?:budget|price|pricing|policy|rule|limit|tier))\s*(?:є|це|is|:)?\s*([^\n\r;]{3,160})/giu, confidence: 0.92 },
    { category: "business_policy", regex: /(?:код\s+ескалації|код\s+повернення|умови\s+оплати|повернення\s+коштів|гарантійний\s+термін|знижка|escalation\s+code|refund\s+code|payment\s+terms|refund\s+policy|warranty\s+period|discount)\s*(?:є|це|is|:)?\s*([^\n\r;]{3,160})/giu, confidence: 0.94 },
    { category: "preference", regex: /(?:я\s+(?:віддаю\s+перевагу|надаю\s+перевагу|люблю|вимагаю)|ми\s+(?:віддаємо\s+перевагу|використовуємо)|my\s+preference\s+is|i\s+prefer|we\s+prefer|we\s+use)\s+([^\n\r;]{3,160})/giu, confidence: 0.88 },
    { category: "technical_detail", regex: /(?:наш(?:а|і|ий)?\s+)?(?:стек|архітектура|база\s+даних|сервер|crm|api|framework|database|stack|engine)\s*(?:є|це|is|:)?\s*([^\n\r;]{3,160})/giu, confidence: 0.85 },
    { category: "contact", regex: /(?:контакт(?:на\s+особа|ний\s+email|ний\s+телефон)?|contact\s+(?:person|email|phone))\s*(?:є|це|is|:)?\s*([^\n\r;]{3,160})/giu, confidence: 0.87 },
    { category: "business_policy", regex: /(?:запам['’]?ятай|remember(?:\s+that)?)\s*[:,-]?\s*([^\n\r]{8,200})/giu, confidence: 0.96 },
    { category: "constraint", regex: /(?:do not|never|must not|cannot|avoid)\s+([^\.\n]+)/giu, confidence: 0.95 },
    { category: "constraint", regex: /(?:requirement is|strictly require)\s+([^\.\n]+)/giu, confidence: 0.95 },
    { category: "decision", regex: /(?:we decided to|the team agreed on|we chose|we are using|architecture uses)\s+([^\.\n]+)/giu, confidence: 0.90 },
  ];

  static extractFacts(messages: Array<{ role: string; content: string }>): ExtractedMemoryCandidate[] {
    const candidates: ExtractedMemoryCandidate[] = [];
    const seenContent = new Set<string>();
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!;
      // Only user-authored statements are durable facts. Assistant output may contain hallucinations.
      if (message.role !== "user" || typeof message.content !== "string" || !message.content.trim()) continue;
      for (const pattern of this.PATTERNS) {
        pattern.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.regex.exec(message.content)) !== null) {
          const content = match[0].replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
          const normalized = content.toLocaleLowerCase();
          if (content.length < 8 || seenContent.has(normalized)) continue;
          seenContent.add(normalized);
          candidates.push({
            content,
            category: pattern.category,
            confidence: pattern.confidence,
            provenance: {
              messageIndex: index,
              role: "user",
              snippet: message.content.slice(Math.max(0, match.index - 20), Math.min(message.content.length, match.index + match[0].length + 20)),
            },
          });
        }
      }
    }
    return candidates;
  }

  static deduplicate(candidates: ExtractedMemoryCandidate[], existingMemories: Array<{ content: string }>, similarityThreshold = 0.7): ExtractedMemoryCandidate[] {
    const existingNormalized = existingMemories.map((memory) => this.tokenize(memory.content));
    const accepted: ExtractedMemoryCandidate[] = [];
    for (const candidate of candidates) {
      const tokens = this.tokenize(candidate.content);
      if (tokens.size === 0) continue;
      const duplicate = [...existingNormalized, ...accepted.map((item) => this.tokenize(item.content))]
        .some((existing) => this.jaccardSimilarity(tokens, existing) >= similarityThreshold);
      if (!duplicate) accepted.push(candidate);
    }
    return accepted;
  }

  static async autoExtractAndPersist(deps: {
    repo: CompanyKnowledgeRepository;
    ctx?: AuthContext;
    auth?: AuthContext;
    companyId: string;
    messages: Array<{ role: string; content: string }>;
    noMemory?: boolean;
    minConfidence?: number;
  }): Promise<CompanyMemory[]> {
    if (deps.noMemory) return [];
    const authContext = deps.ctx ?? deps.auth;
    if (!authContext) throw new Error("AuthContext is required for memory persistence");
    const candidates = this.extractFacts(deps.messages).filter((candidate) => candidate.confidence >= (deps.minConfidence ?? 0.8));
    if (candidates.length === 0) return [];
    const uniqueCandidates = this.deduplicate(candidates, await deps.repo.memories(authContext, deps.companyId));
    const created: CompanyMemory[] = [];
    for (const item of uniqueCandidates) {
      created.push(await deps.repo.addMemory(authContext, deps.companyId, item.content, `auto_extracted:${item.category}`, {
        extraction: { confidence: item.confidence, provenance: item.provenance },
      }));
    }
    return created;
  }

  private static tokenize(text: string): Set<string> {
    return new Set(text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((word) => word.length > 2));
  }

  private static jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    let intersection = 0;
    for (const item of a) if (b.has(item)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}