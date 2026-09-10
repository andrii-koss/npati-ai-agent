import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CompanyKnowledgeProcessor, CompanyKnowledgeRepository } from "../apps/agent-api/src/company-knowledge";
import type { AuthContext } from "@npati/workspace";

const auth: AuthContext = {
  workspaceId: "workspace-hybrid",
  userId: "user-hybrid",
  permissions: ["workspace:read"],
};

describe("Company Knowledge production hybrid retrieval", () => {
  it("combines tenant-scoped pgvector and PostgreSQL FTS candidates with reciprocal-rank fusion", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (text: string, values: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("<=>")) return { rows: [
          { id: "vector-only", content: "semantic result", score: 0.91 },
          { id: "both", content: "shared result", score: 0.82 },
        ] };
        return { rows: [
          { id: "both", content: "shared result", score: 0.75 },
          { id: "keyword-only", content: "exact phrase", score: 0.61 },
        ] };
      }),
    };
    const repository = new CompanyKnowledgeRepository("postgres://unused");
    (repository as unknown as { pool: typeof pool }).pool = pool;

    const results = await repository.hybridCandidates(auth, "company-hybrid", "exact phrase", [0.1, 0.2], 10);

    expect(results.map((item) => item.id)).toEqual(["both", "vector-only", "keyword-only"]);
    expect(results[0]).toMatchObject({ vectorScore: 0.82, keywordScore: 0.75 });
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.values.slice(0, 3)).toEqual([auth.workspaceId, "company-hybrid", auth.userId]);
    expect(calls[1]!.text).toContain("websearch_to_tsquery('simple'");
  });

  it("falls back to scoped keyword retrieval when embeddings fail and returns relevant Company Memory", async () => {
    const repository = {
      hybridCandidates: vi.fn(async (_ctx, _companyId, _query, embedding) => {
        expect(embedding).toBeUndefined();
        return [{ id: "keyword", content: "ESCALATION TEST-7391", score: 0.5, vectorScore: 0, keywordScore: 0.5 }];
      }),
      searchMemories: vi.fn(async () => [{ id: "memory", content: "TEST-7391", source: "manual" }]),
    };
    const processor = new CompanyKnowledgeProcessor(
      repository as unknown as CompanyKnowledgeRepository,
      {} as never,
      {} as never,
      { embed: vi.fn(async () => { throw new Error("provider unavailable"); }) } as never,
    );

    const result = await processor.retrieveContext(auth, "company-hybrid", "TEST-7391", 6);

    expect(result.chunks[0]?.content).toContain("TEST-7391");
    expect(result.memories[0]?.content).toBe("TEST-7391");
    expect(repository.hybridCandidates).toHaveBeenCalledOnce();
    expect(repository.searchMemories).toHaveBeenCalledWith(auth, "company-hybrid", "TEST-7391", 12);
  });

  it("ships GIN indexes for knowledge chunks and company memory", () => {
    const migration = readFileSync(join(process.cwd(), "packages", "workspace", "src", "migration-025.ts"), "utf8");
    expect(migration).toContain("company_knowledge_chunks_fts_idx");
    expect(migration).toContain("company_memories_fts_idx");
    expect(migration.match(/USING GIN/g)).toHaveLength(2);
  });
});
