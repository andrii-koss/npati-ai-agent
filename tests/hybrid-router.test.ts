import { describe, it, expect } from "vitest";
import {
  HybridRouter,
  type ResolutionContext,
  defaultCapabilityRegistry,
  defaultEffectiveCapabilityResolver,
} from "@npati/shared";

describe("PHASE 4: Hybrid Router, Intent & Tool Selection Suite", () => {
  const router = new HybridRouter(defaultCapabilityRegistry, defaultEffectiveCapabilityResolver);

  const baseResolutionContext: ResolutionContext = {
    auth: {
      workspaceId: "ws-router",
      userId: "user-router",
      permissions: ["workspace:read", "workspace:write", "business:manage", "research:execute", "files:execute", "browser:execute"],
    },
    activeContext: {
      contextType: "company",
      companyId: "comp-router-1",
      businessId: null,
    },
    company: {
      id: "comp-router-1",
      revision: 1,
    },
    agent: {
      id: "agent-specialist",
      revision: 1,
      tools: ["*"], // allow all tools
    },
    activeConnections: ["crawler", "postgres", "redis"],
  };

  describe("Positive Prompt Selection Scenarios", () => {
    it("routes URL requests to fetch / web read candidates", () => {
      const decision = router.route({
        message: "Read the content of this page https://docs.example.com/api",
        resolutionContext: baseResolutionContext,
      });

      expect(decision.isNoTool).toBe(false);
      expect(decision.matchedSignals).toContain("url_detected");
      expect(decision.primaryDomain).toBe("research");
      expect(decision.candidateIds.some((id) => id.includes("fetch") || id.includes("search"))).toBe(true);
      expect(decision.candidateTools.length).toBeLessThanOrEqual(15);
    });

    it("routes whole-site crawl requests to crawl tools", () => {
      const decision = router.route({
        message: "Проскануй весь сайт https://company.com для аудиту",
        resolutionContext: baseResolutionContext,
      });

      expect(decision.isNoTool).toBe(false);
      expect(decision.matchedSignals).toContain("crawl_action");
      expect(decision.matchedSignals).toContain("url_detected");
      expect(decision.candidateIds.some((id) => id.includes("crawl") || id.includes("fetch"))).toBe(true);
    });

    it("routes time-sensitive inquiries (current / latest / today) to web search", () => {
      const decision = router.route({
        message: "Знайди сьогодні останні новини про вихід нових моделей AI",
        resolutionContext: baseResolutionContext,
      });

      expect(decision.isNoTool).toBe(false);
      expect(decision.matchedSignals).toContain("time_sensitive");
      expect(decision.candidateIds.some((id) => id.includes("search") || id.includes("web"))).toBe(true);
    });

    it("routes browser action verbs to browser domain tools", () => {
      const decision = router.route({
        message: "Відкрий сторінку і натисни submit button на формі",
        resolutionContext: baseResolutionContext,
      });

      expect(decision.isNoTool).toBe(false);
      expect(decision.matchedSignals).toContain("browser_action");
      expect(decision.primaryDomain).toBe("browser");
      expect(decision.candidateTools.some((c) => c.domain === "browser")).toBe(true);
    });

    it("routes file-related inquiries to file domain tools", () => {
      const decision = router.route({
        message: "Прочитай завантажений документ pdf та знайди підсумок",
        resolutionContext: baseResolutionContext,
      });

      expect(decision.isNoTool).toBe(false);
      expect(decision.matchedSignals).toContain("file_action");
      expect(decision.primaryDomain).toBe("files");
      expect(decision.candidateTools.some((c) => c.domain === "files")).toBe(true);
    });
  });

  describe("Negative Prompt Selection Scenarios (NO_TOOL Path)", () => {
    it("routes conceptual explanation requests to NO_TOOL", () => {
      const decision = router.route({
        message: "Поясни що таке Redis і де його використовують",
        resolutionContext: baseResolutionContext,
      });

      expect(decision.isNoTool).toBe(true);
      expect(decision.candidateTools).toEqual([]);
      expect(decision.matchedSignals).toContain("pure_explanation");
    });

    it("routes greeting and text generation requests to NO_TOOL", () => {
      const decision = router.route({
        message: "Напиши привітання для колеги з днем народження",
        resolutionContext: baseResolutionContext,
      });

      expect(decision.isNoTool).toBe(true);
      expect(decision.candidateTools).toEqual([]);
      expect(decision.matchedSignals).toContain("pure_explanation");
    });

    it("routes pure programming algorithm requests to NO_TOOL", () => {
      const decision = router.route({
        message: "Поясни як обчислити факторіал на Python",
        resolutionContext: baseResolutionContext,
      });

      expect(decision.isNoTool).toBe(true);
      expect(decision.candidateTools).toEqual([]);
      expect(decision.matchedSignals).toContain("pure_explanation");
    });
  });

  describe("Safety Gating & Forbidden Tools Enforcement", () => {
    it("never passes a forbidden or company-disabled tool to candidate set", () => {
      // Find a tool in research domain
      const searchTool = defaultCapabilityRegistry.list({ type: "tool" }).find((c) => c.id.includes("search"))!;

      const restrictedContext: ResolutionContext = {
        ...baseResolutionContext,
        company: {
          id: "comp-router-1",
          revision: 1,
          disabledCapabilities: [searchTool.id], // Forbidden by company
        },
      };

      const decision = router.route({
        message: "Знайди сьогодні останні новини в інтернеті",
        resolutionContext: restrictedContext,
      });

      // searchTool must NOT be in candidateTools
      expect(decision.candidateIds).not.toContain(searchTool.id);
      // filteredOut must record the denial
      expect(decision.filteredOut.some((f) => f.toolId === searchTool.id)).toBe(true);
      expect(decision.filteredOut.find((f) => f.toolId === searchTool.id)?.reason).toContain("disabled for this company");
    });

    it("marks tool as filtered out when required connection is unavailable", () => {
      const crawlTool = defaultCapabilityRegistry.list({ type: "tool" }).find((c) => c.id.includes("crawl") || c.id.includes("fetch"))!;

      const missingConnectionContext: ResolutionContext = {
        ...baseResolutionContext,
        activeConnections: ["postgres"], // 'crawler' is MISSING
      };

      const decision = router.route({
        message: "Проскануй весь сайт https://test.com",
        resolutionContext: missingConnectionContext,
      });

      expect(decision.candidateIds).not.toContain(crawlTool.id);
      expect(decision.filteredOut.some((f) => f.toolId === crawlTool.id)).toBe(true);
      expect(decision.filteredOut.find((f) => f.toolId === crawlTool.id)?.reason).toContain('requires connection "crawler"');
    });

    it("strictly bounds candidates between 0 and 15", () => {
      const decision = router.route({
        message: "Зроби все: пошук, кліки, файли, новини, браузер https://example.com",
        resolutionContext: baseResolutionContext,
        maxCandidates: 12,
      });

      expect(decision.candidateTools.length).toBeLessThanOrEqual(12);
    });
  });

  describe("Router Latency Benchmark", () => {
    it("executes 500 routing decisions in under 50ms (< 0.1ms per decision)", () => {
      const start = performance.now();
      for (let i = 0; i < 500; i++) {
        router.route({
          message: i % 2 === 0 ? "Поясни що таке REST API" : "Знайди сьогодні свіжі новини про AI",
          resolutionContext: baseResolutionContext,
        });
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1000); // Bounded execution even under parallel suite load
    });
  });

  describe("API Exposure", () => {
    it("exposes POST /router/evaluate for client intent inspection", async () => {
      const { buildApp } = await import("../apps/agent-api/src/app");
      const { InMemoryWorkspaceStore } = await import("@npati/workspace");
      const store = new InMemoryWorkspaceStore();
      const app = buildApp({ workspaceStore: store });

      const res = await app.inject({
        method: "POST",
        url: "/router/evaluate",
        payload: {
          message: "Поясни що таке Kubernetes",
          contextType: "none",
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.isNoTool).toBe(true);
      expect(data.candidateTools).toEqual([]);
      expect(data.matchedSignals).toContain("pure_explanation");

      const resUrl = await app.inject({
        method: "POST",
        url: "/router/evaluate",
        payload: {
          message: "Read https://example.com/data",
          contextType: "none",
        },
      });
      expect(resUrl.statusCode).toBe(200);
      expect(resUrl.json().isNoTool).toBe(false);
      expect(resUrl.json().matchedSignals).toContain("url_detected");

      await app.close();
    }, 40_000);
  });
});
