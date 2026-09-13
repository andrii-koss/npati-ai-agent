import { describe, expect, it } from "vitest";
import { CostTelemetry } from "../apps/agent-api/src/cost-telemetry";
import { SemanticCache } from "../apps/agent-api/src/semantic-cache";
import { ContextCompactor } from "../apps/agent-api/src/context-compactor";

describe("Cost Telemetry, Semantic Cache & Context Compaction", () => {
  describe("Cost Telemetry & Headers (OpenClaw Items 109, 110 / P1)", () => {
    it("calculates accurate USD costs and telemetry headers for model calls", () => {
      const usage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
      const headers = CostTelemetry.getTelemetryHeaders("openai/gpt-4o", usage);

      expect(headers["X-NPATI-Model"]).toBe("openai/gpt-4o");
      expect(headers["X-NPATI-Tokens-Prompt"]).toBe("1000");
      expect(headers["X-NPATI-Tokens-Completion"]).toBe("500");
      expect(Number(headers["X-NPATI-Cost-USD"])).toBeGreaterThan(0);
    });

    it("enforces USD spend quotas and tracks remaining balance", () => {
      const withinBudget = CostTelemetry.checkBudgetQuota(4.5, 10.0);
      expect(withinBudget.allowed).toBe(true);
      expect(withinBudget.remainingUsd).toBe(5.5);

      const exceededBudget = CostTelemetry.checkBudgetQuota(10.5, 10.0);
      expect(exceededBudget.allowed).toBe(false);
      expect(exceededBudget.remainingUsd).toBe(0);
    });
  });

  describe("Semantic Cache Engine (OpenClaw Item 113 / P1)", () => {
    it("caches and retrieves query results with normalized keys", () => {
      const cache = new SemanticCache<string>(60_000);

      cache.set("What is the price of product A?", "Product A costs $100", "comp-1");

      // Query with different casing and punctuation should hit the cache
      const cached = cache.get("what is the price of product a", "comp-1");
      expect(cached).toBe("Product A costs $100");
      expect(cache.has("what is the price of product a?", "comp-1")).toBe(true);

      const stats = cache.stats();
      expect(stats.hits).toBe(1);
      expect(stats.hitRatio).toBe(1.0);
    });

    it("maintains strict tenant isolation across identical queries", () => {
      const cache = new SemanticCache<string>(60_000);

      cache.set("What is my secret token?", "token-tenant-1", "tenant-1");
      cache.set("What is my secret token?", "token-tenant-2", "tenant-2");

      expect(cache.get("what is my secret token", "tenant-1")).toBe("token-tenant-1");
      expect(cache.get("what is my secret token", "tenant-2")).toBe("token-tenant-2");
      expect(cache.get("what is my secret token", "tenant-3")).toBeNull();
    });

    it("invalidates only scoped tenant entries leaving other tenants intact", () => {
      const cache = new SemanticCache<string>(60_000);

      cache.set("query 1", "answer 1", "tenant-alpha");
      cache.set("query 2", "answer 2", "tenant-alpha");
      cache.set("query 1", "answer beta", "tenant-beta");

      expect(cache.stats().size).toBe(3);

      const deletedAlpha = cache.invalidate("tenant-alpha");
      expect(deletedAlpha).toBe(2);

      expect(cache.get("query 1", "tenant-alpha")).toBeNull();
      expect(cache.get("query 2", "tenant-alpha")).toBeNull();
      // Tenant beta must still be intact!
      expect(cache.get("query 1", "tenant-beta")).toBe("answer beta");
      expect(cache.stats().size).toBe(1);
    });

    it("expires entries after TTL", async () => {
      const cache = new SemanticCache<string>(10); // 10ms TTL

      cache.set("short-lived query", "answer", "scope-1", 10);
      await new Promise((r) => setTimeout(r, 20));

      const cached = cache.get("short-lived query", "scope-1");
      expect(cached).toBeNull();
    });
  });

  describe("Context Compaction with Auto Memory Flush (OpenClaw Items 159, 183 / P1)", () => {
    it("identifies long conversations and extracts critical facts for memory flush", () => {
      const messages = [
        { role: "user", content: "Привіт! Ми використовуємо CRM систему HubSpot для лідів." },
        { role: "assistant", content: "Зрозумів, інтегруємо HubSpot." },
        { role: "user", content: "Також наш бюджет на рекламу становить $5,000 на місяць." },
        { role: "assistant", content: "Зафіксовано." },
        { role: "user", content: "Покажи мені аналіз конкурентів." },
        { role: "assistant", content: "Ось конкуренти..." },
        { role: "user", content: "Як щодо нашого сайту?" },
        { role: "assistant", content: "Сайт чудовий." },
        { role: "user", content: "Що робити далі?" },
        { role: "assistant", content: "Наступні кроки..." },
        { role: "user", content: "Створи задачу для маркетолога." },
        { role: "assistant", content: "Створено." },
        { role: "user", content: "Який поточний статус?" },
        { role: "assistant", content: "Все працює." },
      ];

      expect(ContextCompactor.shouldCompact(messages, 10)).toBe(true);

      const result = ContextCompactor.compact(messages, 4);

      expect(result.compacted).toBe(true);
      expect(result.preservedMessages.length).toBe(4);
      expect(result.summary).toBeDefined();
      expect(result.flushedMemories.length).toBeGreaterThanOrEqual(2);
      expect(result.flushedMemories.some((m) => m.includes("HubSpot"))).toBe(true);
    });
  });
});
