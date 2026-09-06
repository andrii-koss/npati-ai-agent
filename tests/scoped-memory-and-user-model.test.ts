import { describe, expect, it } from "vitest";
import { ScopedMemoryEngine } from "../apps/agent-api/src/scoped-memory";
import { UserModelProfileManager } from "../apps/agent-api/src/user-model-profile";

describe("Scoped Memory Engine (ScopedMemoryEngine)", () => {
  it("stores and strictly partitions memories by API key and Session ID", async () => {
    const engine = new ScopedMemoryEngine();
    const companyId = "company-scope-test";
    const tenantId = "tenant-scope-test";

    // 1. Store Company-wide memory (visible to everyone in this company)
    await engine.storeMemory({
      companyId,
      tenantId,
      title: "Company Founded Year",
      content: "Acme Corp was founded in 2024.",
    });

    // 2. Store API Key A specific memory
    await engine.storeMemory({
      companyId,
      tenantId,
      apiKeyId: "key-agent-alpha",
      title: "Key Alpha Private Secret",
      content: "Private database credentials for Agent Alpha.",
    });

    // 3. Store API Key B specific memory
    await engine.storeMemory({
      companyId,
      tenantId,
      apiKeyId: "key-agent-beta",
      title: "Key Beta Private Secret",
      content: "Private API tokens for Agent Beta.",
    });

    // 4. Store Session 123 specific memory
    await engine.storeMemory({
      companyId,
      tenantId,
      sessionId: "session-chat-123",
      title: "Current Discussion Topic",
      content: "User requested financial analysis for Q3.",
    });

    // Query from API Key A:
    // Should see: Company memory + Key Alpha memory
    // Should NOT see: Key Beta memory or Session memory
    const keyAResults = await engine.retrieveMemories({
      companyId,
      tenantId,
      apiKeyId: "key-agent-alpha",
    });

    const keyATitles = keyAResults.map((m) => m.title);
    expect(keyATitles).toContain("Company Founded Year");
    expect(keyATitles).toContain("Key Alpha Private Secret");
    expect(keyATitles).not.toContain("Key Beta Private Secret");
    expect(keyATitles).not.toContain("Current Discussion Topic");

    // Query from Session 123:
    // Should see: Company memory + Session 123 memory
    // Should NOT see: Key Alpha or Key Beta private secrets
    const sessionResults = await engine.retrieveMemories({
      companyId,
      tenantId,
      sessionId: "session-chat-123",
    });

    const sessionTitles = sessionResults.map((m) => m.title);
    expect(sessionTitles).toContain("Company Founded Year");
    expect(sessionTitles).toContain("Current Discussion Topic");
    expect(sessionTitles).not.toContain("Key Alpha Private Secret");
    expect(sessionTitles).not.toContain("Key Beta Private Secret");
  });

  it("filters scoped memories by search query", async () => {
    const engine = new ScopedMemoryEngine();
    const companyId = "comp-search";
    const tenantId = "tenant-search";

    await engine.storeMemory({
      companyId,
      tenantId,
      title: "Marketing Budget",
      content: "Allocated $20,000 for Google Ads.",
    });

    await engine.storeMemory({
      companyId,
      tenantId,
      title: "Engineering Roadmap",
      content: "Migrate backend to microservices.",
    });

    const searchResults = await engine.retrieveMemories({
      companyId,
      tenantId,
      query: "Google Ads",
    });

    expect(searchResults.length).toBe(1);
    expect(searchResults[0].title).toBe("Marketing Budget");
  });
});

describe("USER.md User Model Profile (UserModelProfileManager)", () => {
  it("synthesizes and parses structured USER.md markdown", () => {
    const manager = new UserModelProfileManager();

    const initialProfile = {
      userId: "user-andrii",
      name: "Andrii",
      preferredLanguage: "Ukrainian (uk)",
      communicationStyle: "concise" as const,
      domainExpertise: ["E-commerce", "AI Architecture", "PostgreSQL"],
      activePriorities: ["Automating customer support", "Scaling multi-agent system"],
      constraints: ["No duplicated functions", "Keep code strictly typed"],
      customNotes: "Prefers responses in Ukrainian with clear code diffs.",
      updatedAt: new Date().toISOString(),
    };

    const markdown = manager.saveProfile(initialProfile);

    expect(markdown).toContain("# User Profile: Andrii");
    expect(markdown).toContain("- Language: Ukrainian (uk)");
    expect(markdown).toContain("- Style: concise");
    expect(markdown).toContain("- E-commerce");
    expect(markdown).toContain("- No duplicated functions");

    // Parse back
    const parsed = UserModelProfileManager.parseMarkdown("user-andrii", markdown);
    expect(parsed.name).toBe("Andrii");
    expect(parsed.preferredLanguage).toBe("Ukrainian (uk)");
    expect(parsed.communicationStyle).toBe("concise");
    expect(parsed.domainExpertise).toContain("E-commerce");
    expect(parsed.constraints).toContain("No duplicated functions");
  });

  it("provides clean fallback markdown for unknown users", () => {
    const manager = new UserModelProfileManager();
    const defaultMarkdown = manager.getUserMarkdown("unknown-user");

    expect(defaultMarkdown).toContain("# User Profile: User");
    expect(defaultMarkdown).toContain("Ukrainian (uk)");
  });
});
