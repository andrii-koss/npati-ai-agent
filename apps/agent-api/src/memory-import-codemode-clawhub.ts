export interface ImportedMemoryItem {
  id: string;
  source: string;
  author: string;
  content: string;
  timestamp: string;
  tags: string[];
}

export interface CodeModeValidationResult {
  allowed: boolean;
  lintWarnings: string[];
  securityClearance: "approved" | "blocked";
}

export interface ClawHubPackage {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  checksum: string;
  installed: boolean;
}

export class MemoryImportPipeline {
  /**
   * 1. Memory Import: Ingests ChatGPT exports, Claude conversation JSON, and Markdown notes
   */
  importArchive(
    format: "chatgpt_json" | "claude_json" | "markdown_notes",
    rawContent: string
  ): { importedCount: number; memories: ImportedMemoryItem[] } {
    const memories: ImportedMemoryItem[] = [];

    if (format === "markdown_notes") {
      const sections = rawContent.split(/^#{1,3}\s+/m).filter(Boolean);
      sections.forEach((sec, idx) => {
        const [firstLine, ...rest] = sec.split("\n");
        const title = firstLine?.trim() || `Note ${idx + 1}`;
        const body = rest.join("\n").trim();
        if (body.length > 0) {
          memories.push({
            id: `mem_note_${Date.now()}_${idx}`,
            source: "markdown_notes",
            author: "user",
            content: `${title}\n${body}`,
            timestamp: new Date().toISOString(),
            tags: ["imported", "markdown", title.toLowerCase().replace(/\s+/g, "_")],
          });
        }
      });
    } else {
      // JSON format
      try {
        const parsed = JSON.parse(rawContent);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        list.forEach((item, idx) => {
          memories.push({
            id: `mem_json_${Date.now()}_${idx}`,
            source: format,
            author: item.role || item.author || "user",
            content: typeof item.content === "string" ? item.content : JSON.stringify(item),
            timestamp: item.timestamp || new Date().toISOString(),
            tags: ["imported", format],
          });
        });
      } catch {
        // Fallback for plaintext
        memories.push({
          id: `mem_raw_${Date.now()}`,
          source: "raw_text",
          author: "user",
          content: rawContent,
          timestamp: new Date().toISOString(),
          tags: ["imported", "fallback"],
        });
      }
    }

    return {
      importedCount: memories.length,
      memories,
    };
  }
}

export class CodeModePolicyController {
  private active = false;

  /**
   * 2. Code Mode: Specialized programming mode with static checks and lint guardrails
   */
  enable(): { active: boolean; promptDirective: string } {
    this.active = true;
    return {
      active: true,
      promptDirective:
        "CODE_MODE_ACTIVE: Focus strictly on code generation, formal type-safety, and minimal prose explanations.",
    };
  }

  validateExecution(code: string, language: string): CodeModeValidationResult {
    const warnings: string[] = [];
    let allowed = true;

    // Security static inspection
    if (/eval\(|new Function\(|child_process\.execSync\("rm -rf \/"\)/i.test(code)) {
      warnings.push("Dangerous system call pattern detected.");
      allowed = false;
    }

    // Language-specific syntax / style check
    if (language === "typescript" && !code.includes("interface") && !code.includes("type") && code.includes("any")) {
      warnings.push("TypeScript warning: Avoid unconstrained 'any' types in Code Mode.");
    }

    return {
      allowed,
      lintWarnings: warnings,
      securityClearance: allowed ? "approved" : "blocked",
    };
  }

  isActive(): boolean {
    return this.active;
  }
}

export class ClawHubRegistryClient {
  private readonly repository = new Map<string, ClawHubPackage>();

  constructor() {
    this.repository.set("pkg-postgresql-pro", {
      id: "pkg-postgresql-pro",
      name: "PostgreSQL Advanced DBA Skill",
      version: "1.4.0",
      description: "Query plan analysis, index tuning, and connection pooling skills.",
      author: "npati-community",
      checksum: "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
      installed: false,
    });
    this.repository.set("pkg-k8s-operator", {
      id: "pkg-k8s-operator",
      name: "Kubernetes Cluster Operator Pack",
      version: "2.1.0",
      description: "Automated pod health debugging and helm chart generator.",
      author: "openclaw-team",
      checksum: "sha256:4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
      installed: false,
    });
  }

  /**
   * 3. ClawHub: Community skill & agent pack repository manager
   */
  search(query: string): ClawHubPackage[] {
    const q = query.toLowerCase();
    return Array.from(this.repository.values()).filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
    );
  }

  install(packageId: string): { success: boolean; package?: ClawHubPackage; error?: string } {
    const pkg = this.repository.get(packageId);
    if (!pkg) return { success: false, error: "Package not found in ClawHub registry." };

    pkg.installed = true;
    return {
      success: true,
      package: pkg,
    };
  }

  listInstalled(): ClawHubPackage[] {
    return Array.from(this.repository.values()).filter((p) => p.installed);
  }
}
