import { describe, expect, it } from "vitest";
import { CompanyKnowledgeHub } from "../apps/agent-api/src/company-knowledge-hub";

describe("Company Knowledge Hub End-to-End (NPATI-004, NPATI-004F, NPATI-004J)", () => {
  it("ingests corporate documents and computes normalized embeddings", async () => {
    const hub = new CompanyKnowledgeHub();
    const companyId = "comp-e2e-corp";

    const doc1 = await hub.ingestDocument({
      companyId,
      title: "Security & Access Policy",
      rawContent: "All employees must use OAuth 2.0 PKCE authentication and AES-256-GCM encrypted tokens.",
      filename: "security_policy.md",
      tags: ["security", "auth", "policy"],
    });

    expect(doc1.id).toMatch(/^kdoc_/);
    expect(doc1.format).toBe("markdown");
    expect(doc1.embeddingVector?.length).toBe(128);
    expect(doc1.tags).toContain("security");
  });

  it("searches knowledge with Cross-Encoder Reranking and score filtering", async () => {
    const hub = new CompanyKnowledgeHub();
    const companyId = "comp-e2e-corp";

    // Ingest multiple documents
    await hub.ingestDocument({
      companyId,
      title: "Security & Access Policy",
      rawContent: "All employees must use OAuth 2.0 PKCE authentication and AES-256-GCM encrypted tokens.",
      tags: ["security"],
    });

    await hub.ingestDocument({
      companyId,
      title: "Office Cafeteria Menu",
      rawContent: "Lunch is served from 12:00 to 14:00 daily with vegan and gluten-free options.",
      tags: ["office"],
    });

    await hub.ingestDocument({
      companyId,
      title: "Incident Response Playbook",
      rawContent: "In case of security breach, immediately trigger circuit breaker and notify SecOps.",
      tags: ["security", "incident"],
    });

    // Query 1: Security policy query
    const searchRes = await hub.searchKnowledge({
      companyId,
      query: "OAuth PKCE authentication security policy",
      limit: 2,
      useRerank: true,
      minScore: 0.2,
    });

    expect(searchRes.rerankApplied).toBe(true);
    expect(searchRes.results.length).toBeGreaterThan(0);
    expect(searchRes.results[0].title).toBe("Security & Access Policy");
    expect(searchRes.results[0].rerankScore).toBeGreaterThan(0.4);
  });

  it("enforces tenant isolation between different companies", async () => {
    const hub = new CompanyKnowledgeHub();

    await hub.ingestDocument({
      companyId: "comp-alpha",
      title: "Alpha Secret Strategy",
      rawContent: "Project Titan launches in Q4 with AI agents.",
    });

    await hub.ingestDocument({
      companyId: "comp-beta",
      title: "Beta Public Roadmap",
      rawContent: "Public release of product widgets.",
    });

    // Search from comp-beta should not return comp-alpha docs
    const betaSearch = await hub.searchKnowledge({
      companyId: "comp-beta",
      query: "Project Titan AI agents",
    });

    expect(betaSearch.results.some((r) => r.title.includes("Titan"))).toBe(false);
  });
});
