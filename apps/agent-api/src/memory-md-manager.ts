export interface LongTermMemoryState {
  companyId: string;
  coreBusinessContext: string[];
  userPreferences: string[];
  architecturalDecisions: string[];
  operationalRules: string[];
  customSections: Map<string, string[]>;
  updatedAt: string;
}

export class MemoryMdManager {
  private readonly memories = new Map<string, LongTermMemoryState>();

  /**
   * Synthesize a structured MEMORY.md document
   */
  static synthesize(state: LongTermMemoryState): string {
    const lines: string[] = [
      `# Long-Term Memory: Company ${state.companyId}`,
      "",
      "## Core Business Context",
      ...(state.coreBusinessContext.length > 0
        ? state.coreBusinessContext.map((c) => `- ${c}`)
        : ["- No core context recorded yet."]),
      "",
      "## User Preferences",
      ...(state.userPreferences.length > 0
        ? state.userPreferences.map((p) => `- ${p}`)
        : ["- Standard technical tone, Ukrainian or English."]),
      "",
      "## Architectural Decisions",
      ...(state.architecturalDecisions.length > 0
        ? state.architecturalDecisions.map((d) => `- ${d}`)
        : ["- Monorepo architecture with strict TypeScript typing."]),
      "",
      "## Operational Rules",
      ...(state.operationalRules.length > 0
        ? state.operationalRules.map((r) => `- ${r}`)
        : ["- Run automated test suite before saving updates."]),
    ];

    if (state.customSections && state.customSections.size > 0) {
      for (const [title, entries] of state.customSections.entries()) {
        lines.push("", `## ${title}`, ...entries.map((e) => `- ${e}`));
      }
    }

    lines.push("", `<!-- Last updated: ${state.updatedAt} -->`);
    return lines.join("\n");
  }

  /**
   * Parse a MEMORY.md document into a structured LongTermMemoryState
   */
  static parse(companyId: string, markdown: string): LongTermMemoryState {
    const extractItems = (header: string): string[] => {
      const regex = new RegExp(`##\\s+${header}\\n([\\s\\S]*?)(?=\\n##|$)`, "i");
      const match = markdown.match(regex);
      if (!match || !match[1]) return [];
      return match[1]
        .split("\n")
        .map((l) => l.replace(/^-\s*/, "").trim())
        .filter((l) => l.length > 0 && !l.startsWith("<!--") && !l.startsWith("No "));
    };

    return {
      companyId,
      coreBusinessContext: extractItems("Core Business Context"),
      userPreferences: extractItems("User Preferences"),
      architecturalDecisions: extractItems("Architectural Decisions"),
      operationalRules: extractItems("Operational Rules"),
      customSections: new Map(),
      updatedAt: new Date().toISOString(),
    };
  }

  getOrCreateMemory(companyId: string): LongTermMemoryState {
    let memory = this.memories.get(companyId);
    if (!memory) {
      memory = {
        companyId,
        coreBusinessContext: [],
        userPreferences: [],
        architecturalDecisions: [],
        operationalRules: [],
        customSections: new Map(),
        updatedAt: new Date().toISOString(),
      };
      this.memories.set(companyId, memory);
    }
    return memory;
  }

  upsertFact(
    companyId: string,
    section: "context" | "preferences" | "architecture" | "rules",
    fact: string
  ): void {
    const memory = this.getOrCreateMemory(companyId);
    const cleaned = fact.trim();
    if (!cleaned) return;

    let targetArray: string[];
    switch (section) {
      case "context":
        targetArray = memory.coreBusinessContext;
        break;
      case "preferences":
        targetArray = memory.userPreferences;
        break;
      case "architecture":
        targetArray = memory.architecturalDecisions;
        break;
      case "rules":
        targetArray = memory.operationalRules;
        break;
    }

    if (!targetArray.includes(cleaned)) {
      targetArray.push(cleaned);
      memory.updatedAt = new Date().toISOString();
    }
  }

  getMemoryMarkdown(companyId: string): string {
    const memory = this.getOrCreateMemory(companyId);
    return MemoryMdManager.synthesize(memory);
  }
}
