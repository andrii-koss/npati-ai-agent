export interface UserModelProfile {
  userId: string;
  name: string;
  preferredLanguage?: string;
  communicationStyle?: "concise" | "detailed" | "technical" | "casual" | "formal";
  domainExpertise?: string[];
  activePriorities?: string[];
  constraints?: string[];
  customNotes?: string;
  updatedAt: string;
}

export class UserModelProfileManager {
  private readonly profiles = new Map<string, UserModelProfile>();

  /**
   * Synthesize a structured USER.md markdown document from profile data
   */
  static synthesizeMarkdown(profile: UserModelProfile): string {
    const lines: string[] = [
      `# User Profile: ${profile.name}`,
      "",
      "## Preferred Communication Style",
      `- Language: ${profile.preferredLanguage ?? "Ukrainian (uk)"}`,
      `- Style: ${profile.communicationStyle ?? "technical and direct"}`,
      "",
      "## Domain & Expertise",
      ...(profile.domainExpertise && profile.domainExpertise.length > 0
        ? profile.domainExpertise.map((e) => `- ${e}`)
        : ["- General Business / Technology"]),
      "",
      "## Active Priorities",
      ...(profile.activePriorities && profile.activePriorities.length > 0
        ? profile.activePriorities.map((p) => `- ${p}`)
        : ["- Core system features implementation"]),
      "",
      "## Guidelines & Constraints",
      ...(profile.constraints && profile.constraints.length > 0
        ? profile.constraints.map((c) => `- ${c}`)
        : ["- Follow verified plan and test before deployment"]),
    ];

    if (profile.customNotes) {
      lines.push("", "## Notes", profile.customNotes);
    }

    lines.push("", `<!-- Last updated: ${profile.updatedAt} -->`);
    return lines.join("\n");
  }

  /**
   * Parse a USER.md markdown document into a structured UserModelProfile object
   */
  static parseMarkdown(userId: string, markdown: string): UserModelProfile {
    const nameMatch = markdown.match(/^#\s+User Profile:\s+(.+)$/m);
    const name = nameMatch && nameMatch[1] ? nameMatch[1].trim() : "User";

    const langMatch = markdown.match(/- Language:\s+(.+)$/m);
    const styleMatch = markdown.match(/- Style:\s+(.+)$/m);

    const extractSectionItems = (sectionHeader: string): string[] => {
      const sectionRegex = new RegExp(`##\\s+${sectionHeader}\\n([\\s\\S]*?)(?=\\n##|$)`, "i");
      const match = markdown.match(sectionRegex);
      if (!match || !match[1]) return [];
      return match[1]
        .split("\n")
        .map((line) => line.replace(/^-\s*/, "").trim())
        .filter((line) => line.length > 0 && !line.startsWith("<!--"));
    };

    const domainExpertise = extractSectionItems("Domain & Expertise");
    const activePriorities = extractSectionItems("Active Priorities");
    const constraints = extractSectionItems("Guidelines & Constraints");

    let communicationStyle: UserModelProfile["communicationStyle"] = "technical";
    if (styleMatch && styleMatch[1]) {
      const val = styleMatch[1].toLowerCase();
      if (val.includes("concise")) communicationStyle = "concise";
      else if (val.includes("detailed")) communicationStyle = "detailed";
      else if (val.includes("casual")) communicationStyle = "casual";
      else if (val.includes("formal")) communicationStyle = "formal";
      else communicationStyle = "technical";
    }

    return {
      userId,
      name,
      preferredLanguage: langMatch && langMatch[1] ? langMatch[1].trim() : "Ukrainian (uk)",
      communicationStyle,
      domainExpertise,
      activePriorities,
      constraints,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Save or update user profile
   */
  saveProfile(profile: UserModelProfile): string {
    profile.updatedAt = new Date().toISOString();
    this.profiles.set(profile.userId, profile);
    return UserModelProfileManager.synthesizeMarkdown(profile);
  }

  /**
   * Get user profile object
   */
  getProfile(userId: string): UserModelProfile | null {
    return this.profiles.get(userId) || null;
  }

  /**
   * Get formatted USER.md string for prompt injection
   */
  getUserMarkdown(userId: string): string {
    const profile = this.getProfile(userId);
    if (!profile) {
      const defaultProfile: UserModelProfile = {
        userId,
        name: "User",
        preferredLanguage: "Ukrainian (uk)",
        communicationStyle: "technical",
        domainExpertise: ["Business", "AI"],
        activePriorities: ["Product roadmap execution"],
        constraints: ["Zero duplicated code", "100% test passing"],
        updatedAt: new Date().toISOString(),
      };
      return UserModelProfileManager.synthesizeMarkdown(defaultProfile);
    }
    return UserModelProfileManager.synthesizeMarkdown(profile);
  }
}
