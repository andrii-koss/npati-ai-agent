import { describe, expect, it } from "vitest";
import { AutoExecReviewer } from "../apps/agent-api/src/auto-exec-reviewer";
import { AutoMemoryExtractor } from "../apps/agent-api/src/auto-memory-extractor";
import { FtsMemorySearchEngine } from "../apps/agent-api/src/fts5-memory-search";

describe("Auto Reviewer for Exec (AutoExecReviewer)", () => {
  it("blocks critical destructive shell commands", () => {
    const result = AutoExecReviewer.reviewExecution({
      type: "shell",
      payload: "rm -rf / --no-preserve-root",
    });

    expect(result.decision).toBe("BLOCKED");
    expect(result.riskLevel).toBe("CRITICAL");
    expect(result.reasons[0]).toContain("CRITICAL_DESTRUCTIVE_COMMAND");
  });

  it("requires human approval for high risk sudo commands", () => {
    const result = AutoExecReviewer.reviewExecution({
      type: "shell",
      payload: "sudo chmod 777 /etc/environment",
    });

    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.riskLevel).toBe("HIGH");
  });

  it("approves safe standard developer commands", () => {
    const result = AutoExecReviewer.reviewExecution({
      type: "shell",
      payload: "npm run test --workspaces",
    });

    expect(result.decision).toBe("APPROVED");
    expect(result.riskLevel).toBe("LOW");
  });
});

describe("Automatic Memory Extractor (AutoMemoryExtractor)", () => {
  it("extracts preferences, constraints, and decisions from user messages", () => {
    const messages = [
      { role: "user", content: "I prefer TypeScript over Python for all backend services." },
      { role: "assistant", content: "Understood." },
      { role: "user", content: "Never use plain HTTP, strictly require HTTPS for all webhooks." },
      { role: "user", content: "We decided to deploy PostgreSQL with pgvector for embeddings." },
    ];

    const facts = AutoMemoryExtractor.extractFacts(messages);
    expect(facts.length).toBe(4);

    expect(facts.some((f) => f.category === "preference" && f.fact.includes("TypeScript"))).toBe(true);
    expect(facts.some((f) => f.category === "constraint" && f.fact.includes("HTTP"))).toBe(true);
    expect(facts.some((f) => f.category === "decision" && f.fact.includes("PostgreSQL"))).toBe(true);
  });
});

describe("FTS5 Keyword Search Engine (FtsMemorySearchEngine)", () => {
  it("indexes documents and returns ranked keyword search results with snippets", () => {
    const engine = new FtsMemorySearchEngine();

    engine.indexDocuments([
      {
        id: "doc-1",
        title: "OAuth 2.0 PKCE Specification",
        body: "OAuth 2.0 with PKCE provides robust authentication security for single-page and mobile apps.",
      },
      {
        id: "doc-2",
        title: "PostgreSQL pgvector Guide",
        body: "PostgreSQL pgvector extension enables fast vector similarity search using cosine and Euclidean distances.",
      },
    ]);

    const result = FtsMemorySearchEngine.prototype.search.call(engine, "OAuth PKCE authentication security", {
      limit: 2,
    });

    expect(result.matches.length).toBe(1);
    expect(result.matches[0].id).toBe("doc-1");
    expect(result.matches[0].score).toBeGreaterThan(0.5);
    expect(result.matches[0].snippet).toContain("OAuth");
  });
});
