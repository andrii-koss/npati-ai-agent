import { describe, expect, it } from "vitest";
import {
  TypedDecayMemoryManager,
  MemoryRerankEngine,
  DailyMemoryJournal,
  type DecayingMemoryItem,
} from "../apps/agent-api/src/advanced-memory-management";

describe("Typed Decay Memory Manager (TypedDecayMemoryManager)", () => {
  it("decays ephemeral memories rapidly while immutable memories stay constant", () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48h ago

    const ephemeralItem: DecayingMemoryItem = {
      id: "mem-eph",
      type: "ephemeral",
      title: "Active file cursor",
      content: "User is viewing index.ts",
      baseWeight: 1.0,
      createdAt: twoDaysAgo.toISOString(),
    };

    const immutableItem: DecayingMemoryItem = {
      id: "mem-imm",
      type: "immutable",
      title: "Company Tax ID",
      content: "Tax ID: UA-99881122",
      baseWeight: 1.0,
      createdAt: twoDaysAgo.toISOString(),
    };

    const ephWeight = TypedDecayMemoryManager.calculateEffectiveWeight(ephemeralItem, now);
    const immWeight = TypedDecayMemoryManager.calculateEffectiveWeight(immutableItem, now);

    // Ephemeral has 24h half-life, so after 48h it is ~0.25
    expect(ephWeight).toBeCloseTo(0.25, 2);
    // Immutable has infinite half-life, so it remains 1.0
    expect(immWeight).toBe(1.0);
  });
});

describe("Memory Rerank Engine (MemoryRerankEngine)", () => {
  it("scores and ranks memory facts combining relevance and decay weight", () => {
    const candidates: DecayingMemoryItem[] = [
      {
        id: "m-1",
        type: "project_rule",
        title: "API Authentication Policy",
        content: "All incoming requests must provide OAuth 2.0 PKCE bearer tokens.",
        baseWeight: 0.9,
        createdAt: new Date().toISOString(),
      },
      {
        id: "m-2",
        type: "operational",
        title: "Coffee Machine Status",
        content: "Coffee machine on 2nd floor was cleaned.",
        baseWeight: 0.5,
        createdAt: new Date().toISOString(),
      },
    ];

    const result = MemoryRerankEngine.rerankMemories("OAuth authentication security policy", candidates, {
      topK: 1,
    });

    expect(result.rankedMemories.length).toBe(1);
    expect(result.rankedMemories[0].id).toBe("m-1");
    expect(result.rankedMemories[0].finalScore).toBeGreaterThan(0.6);
  });
});

describe("Daily Memory Journal (DailyMemoryJournal)", () => {
  it("records dated daily notes and formats markdown journal", () => {
    const journal = new DailyMemoryJournal();
    const companyId = "comp-journal-1";
    const date = "2026-09-02";

    journal.appendNote({
      companyId,
      date,
      topic: "Roadmap Progress",
      text: "Successfully completed 100% of P1 queue items.",
    });

    journal.appendNote({
      companyId,
      date,
      topic: "System Verification",
      text: "All 53 test suites passed with 0 errors.",
    });

    const notes = journal.getNotesForDate(companyId, date);
    expect(notes.length).toBe(2);

    const md = journal.formatDailySummaryMarkdown(companyId, date);
    expect(md).toContain("# Daily Notes (2026-09-02)");
    expect(md).toContain("### Roadmap Progress");
    expect(md).toContain("### System Verification");
  });
});
