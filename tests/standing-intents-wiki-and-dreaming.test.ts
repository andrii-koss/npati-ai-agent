import { describe, expect, it } from "vitest";
import {
  StandingIntentsTracker,
  MemoryWikiEngine,
  DreamingConsolidationEngine,
} from "../apps/agent-api/src/memory-wiki-and-dreaming";

describe("Standing Intents Tracker (StandingIntentsTracker)", () => {
  it("tracks unresolved intents and triggers on relevant user keywords", () => {
    const tracker = new StandingIntentsTracker();
    const companyId = "comp-intents-1";

    const intent = tracker.registerIntent({
      companyId,
      title: "Investigate PostgreSQL Latency",
      description: "Analyze pgvector index performance on 5,000+ records",
      triggerKeywords: ["postgres", "pgvector", "database slow"],
    });

    expect(intent.id).toMatch(/^intent_/);
    expect(intent.status).toBe("pending");

    // Match query
    const matches = tracker.findMatchingIntents(companyId, "Why is our postgres query taking 200ms?");
    expect(matches.length).toBe(1);
    expect(matches[0].title).toBe("Investigate PostgreSQL Latency");

    // Fulfill
    tracker.fulfillIntent(intent.id);
    const postFulfillMatches = tracker.findMatchingIntents(companyId, "postgres database check");
    expect(postFulfillMatches.length).toBe(0);
  });
});

describe("Memory Wiki Engine (MemoryWikiEngine)", () => {
  it("stores hierarchical pages, extracts wikilinks, and resolves backlinks", () => {
    const wiki = new MemoryWikiEngine();
    const companyId = "comp-wiki-corp";

    // Page 1: Architecture
    wiki.upsertPage({
      companyId,
      path: "architecture/overview",
      title: "System Architecture",
      content: "NPATI Agent architecture relies on [[database/pgvector]] and [[security/vault]].",
    });

    // Page 2: Database
    wiki.upsertPage({
      companyId,
      path: "database/pgvector",
      title: "PostgreSQL Vector Store",
      content: "Details about HNSW indexing.",
    });

    const page1 = wiki.getPage(companyId, "architecture/overview");
    expect(page1?.outboundLinks).toContain("database/pgvector");
    expect(page1?.outboundLinks).toContain("security/vault");

    // Check Backlinks to database/pgvector
    const backlinks = wiki.getBacklinks(companyId, "database/pgvector");
    expect(backlinks).toContain("architecture/overview");
  });
});

describe("Dreaming Consolidation Engine (DreamingConsolidationEngine)", () => {
  it("prunes decayed facts and synthesizes consolidated wiki pages", () => {
    const wiki = new MemoryWikiEngine();
    const companyId = "comp-dreaming";

    const memories = [
      { id: "m1", title: "Active Branch", content: "Working on git branch feature/ui", weight: 0.01 }, // Decayed
      { id: "m2", title: "Company Secret", content: "Main server API port is 8080", weight: 0.9 },     // Active
      { id: "m3", title: "OAuth Scope", content: "Required scope is mcp:tools:execute", weight: 0.85 }, // Active
    ];

    const result = DreamingConsolidationEngine.runConsolidationCycle(memories, wiki, companyId);

    expect(result.prunedDecayedCount).toBe(1);
    expect(result.consolidatedFactsCount).toBe(2);
    expect(result.synthesizedWikiPages.length).toBe(1);

    const summaryPage = wiki.getPage(companyId, "consolidated/dreaming-summary");
    expect(summaryPage?.content).toContain("Company Secret");
    expect(summaryPage?.content).toContain("OAuth Scope");
    expect(summaryPage?.content).not.toContain("Active Branch");
  });
});
