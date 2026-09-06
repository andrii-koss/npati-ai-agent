import { describe, expect, it } from "vitest";
import {
  ResilientEmbeddingPipeline,
  ResilientRerankPipeline,
} from "../apps/agent-api/src/resilient-inference-pipeline";
import { MemoryInjectionEngine } from "../apps/agent-api/src/memory-injector";
import { ScopedMemoryEngine } from "../apps/agent-api/src/scoped-memory";
import { UserModelProfileManager } from "../apps/agent-api/src/user-model-profile";
import { MemoryMdManager } from "../apps/agent-api/src/memory-md-manager";

describe("Resilient Embeddings & Rerank (ResilientInferencePipeline)", () => {
  it("generates and L2-normalizes embedding vectors", async () => {
    const texts = ["Enterprise AI Agent Platform", "PostgreSQL Vector Store"];
    const result = await ResilientEmbeddingPipeline.generateEmbeddings({ texts, dimensions: 128 });

    expect(result.vectors.length).toBe(2);
    expect(result.dimensions).toBe(128);

    // Verify L2 unit norm: sum of squares ≈ 1.0
    const vec0 = result.vectors[0]!;
    const sumSquares = vec0.reduce((sum, val) => sum + val * val, 0);
    expect(sumSquares).toBeCloseTo(1.0, 2);
  });

  it("reranks candidates by relevance and applies score threshold", async () => {
    const candidates = [
      { id: "c1", text: "NPATI Agent architecture uses multi-agent message bus and PostgreSQL vector store." },
      { id: "c2", text: "The weather in Kyiv is sunny today." },
      { id: "c3", text: "PostgreSQL pgvector allows fast cosine similarity search." },
    ];

    const query = "PostgreSQL vector search architecture";
    const result = await ResilientRerankPipeline.rerank(query, candidates, { topK: 2, minScore: 0.3 });

    expect(result.items.length).toBe(2);
    expect(result.items[0].id).toMatch(/c1|c3/);
    expect(result.items[0].rank).toBe(1);
    expect(result.items[0].relevanceScore).toBeGreaterThanOrEqual(result.items[1].relevanceScore);
  });
});

describe("Memory Injection Engine (MemoryInjectionEngine)", () => {
  it("injects USER.md, MEMORY.md, and scoped dynamic facts into system prompt", async () => {
    const scopedMemory = new ScopedMemoryEngine();
    const userProfile = new UserModelProfileManager();
    const memoryMd = new MemoryMdManager();

    const companyId = "comp-inject-test";
    const tenantId = "tenant-inject-test";
    const userId = "user-alex";

    // Setup User Profile
    userProfile.saveProfile({
      userId,
      name: "Alex",
      preferredLanguage: "Ukrainian (uk)",
      communicationStyle: "concise",
      updatedAt: new Date().toISOString(),
    });

    // Setup Long-term Memory
    memoryMd.upsertFact(companyId, "context", "Fintech banking platform with ISO 27001 compliance.");

    // Setup Scoped Memory
    await scopedMemory.storeMemory({
      companyId,
      tenantId,
      title: "API Rate Limit",
      content: "Default rate limit is 120 requests/minute for Pro tier.",
    });

    const engine = new MemoryInjectionEngine(scopedMemory, userProfile, memoryMd);

    const injected = await engine.injectMemory({
      baseSystemPrompt: "You are a customer support agent. Answer inquiries accurately.",
      companyId,
      tenantId,
      userId,
    });

    expect(injected.userProfileIncluded).toBe(true);
    expect(injected.longTermMemoryIncluded).toBe(true);
    expect(injected.injectedItemsCount).toBeGreaterThan(0);
    expect(injected.finalSystemPrompt).toContain("<context_memory>");
    expect(injected.finalSystemPrompt).toContain("Alex");
    expect(injected.finalSystemPrompt).toContain("ISO 27001 compliance");
    expect(injected.finalSystemPrompt).toContain("API Rate Limit");
    expect(injected.finalSystemPrompt).toContain("You are a customer support agent.");
  });
});
