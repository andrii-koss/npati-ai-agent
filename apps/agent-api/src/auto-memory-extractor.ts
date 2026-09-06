export interface ExtractedFact {
  category: "preference" | "constraint" | "decision" | "profile" | "fact";
  subject: string;
  fact: string;
  confidence: number;
}

export class AutoMemoryExtractor {
  private static readonly PREFERENCE_PATTERNS = [
    /(?:i prefer|please use|always use|my preference is)\s+([^.\n]+)/i,
    /(?:i like|i want you to)\s+([^.\n]+)/i,
  ];

  private static readonly CONSTRAINT_PATTERNS = [
    /(?:do not|never|must not|cannot|avoid)\s+([^.\n]+)/i,
    /(?:requirement is|strictly require)\s+([^.\n]+)/i,
  ];

  private static readonly DECISION_PATTERNS = [
    /(?:we decided to|the team agreed on|we chose)\s+([^.\n]+)/i,
    /(?:we are using|architecture uses)\s+([^.\n]+)/i,
  ];

  /**
   * 2. Automatic Memory & Fact Extraction from Dialogue Turns
   */
  static extractFacts(messages: Array<{ role: string; content: string }>): ExtractedFact[] {
    const facts: ExtractedFact[] = [];

    for (const msg of messages) {
      if (msg.role !== "user") continue;
      const text = msg.content;

      // Extract User Preferences
      for (const pattern of this.PREFERENCE_PATTERNS) {
        const match = pattern.exec(text);
        if (match && match[1]) {
          facts.push({
            category: "preference",
            subject: "User Preference",
            fact: match[1].trim(),
            confidence: 0.9,
          });
        }
      }

      // Extract Constraints
      for (const pattern of this.CONSTRAINT_PATTERNS) {
        const match = pattern.exec(text);
        if (match && match[1]) {
          facts.push({
            category: "constraint",
            subject: "Operational Constraint",
            fact: match[1].trim(),
            confidence: 0.95,
          });
        }
      }

      // Extract Architectural / Project Decisions
      for (const pattern of this.DECISION_PATTERNS) {
        const match = pattern.exec(text);
        if (match && match[1]) {
          facts.push({
            category: "decision",
            subject: "Project Decision",
            fact: match[1].trim(),
            confidence: 0.85,
          });
        }
      }
    }

    return facts;
  }
}
