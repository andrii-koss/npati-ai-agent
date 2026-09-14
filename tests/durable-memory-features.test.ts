import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ContextCompactor } from "../apps/agent-api/src/context-compactor";
import { TypedDecayMemoryManager } from "../apps/agent-api/src/advanced-memory-management";

describe("durable memory feature production contracts", () => {
  it("flushes only explicit user-authored facts at a real compaction boundary", () => {
    const messages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index === 0 ? "Remember that escalation code is FLUSH-7711." : index % 2 === 0 ? "Question " + index : "Answer " + index,
    }));
    const result = ContextCompactor.compact(messages, 4);
    expect(result.compacted).toBe(true);
    expect(result.flushedMemories).toContain("Remember that escalation code is FLUSH-7711");
    expect(result.flushedMemories.join(" ")).not.toContain("Answer");
  });

  it("applies materially different decay curves and never decays immutable facts", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const reference = new Date("2026-01-08T00:00:00.000Z");
    const weight = (type:"ephemeral"|"operational"|"project_rule"|"immutable") =>
      TypedDecayMemoryManager.calculateEffectiveWeight({id:type,type,title:type,content:type,baseWeight:1,createdAt},reference);
    expect(weight("ephemeral")).toBeLessThan(weight("operational"));
    expect(weight("operational")).toBeLessThan(weight("project_rule"));
    expect(weight("immutable")).toBe(1);
  });

  it("ships idempotent, tenant-scoped PostgreSQL persistence for notes and intents", () => {
    const migration = readFileSync(new URL("../packages/workspace/src/migration-033.ts", import.meta.url), "utf8");
    expect(migration).toContain("company_daily_memory_notes_idempotency_unique");
    expect(migration).toContain("company_standing_intents_idempotency_unique");
    expect(migration).toContain("FOREIGN KEY(company_id,workspace_id)");
    expect(migration).toContain("memory_items_automatic_flush_dedup_idx");
  });

  it("does not claim the unavailable SQLite FTS5 adapter as a production fallback", () => {
    const matrix = readFileSync(new URL("../packages/shared/src/capability-matrix.ts", import.meta.url), "utf8");
    expect(matrix).toMatch(/"capabilityId": "research\.fts5_keyword_search"[\s\S]*?"status": "NOT_IMPLEMENTED"/);
  });
});
