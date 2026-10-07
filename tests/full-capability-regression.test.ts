import { describe, it, expect, vi } from "vitest";
import { CAPABILITY_MATRIX, CAPABILITY_CATALOG, HybridRouter, EffectiveCapabilityResolver } from "@npati/shared";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { AuthContext } from "@npati/workspace";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";

describe("PHASE 11: Full Capability Regression Suite", () => {
  /**
   * Historical inventory baseline. It stays a literal on purpose: this suite is a disappearance gate, and a
   * shrinking catalog is exactly what has to fail loudly here.
   */
  const HISTORICAL_INVENTORY_BASELINE = 306;
  /**
   * Current catalog size, taken from the static catalog in `packages/shared` — the single source of truth —
   * instead of a second hand-copied number that silently rots whenever the catalog grows (it did in C9, C11
   * and C12). `CAPABILITY_MATRIX` is authored separately from `CAPABILITY_CATALOG`, so asserting that the two
   * agree is still a real check: a capability added to or removed from only one of them fails right here.
   */
  const staticCatalogSize = CAPABILITY_CATALOG.length;

  describe("Audit Matrix Coverage and Hygiene", () => {
    it("verifies every catalogued capability has test/evidence ownership and zero unknown/unmapped items", () => {
      expect(CAPABILITY_MATRIX.length).toBeGreaterThanOrEqual(HISTORICAL_INVENTORY_BASELINE);
      expect(CAPABILITY_MATRIX.length).toBe(staticCatalogSize);

      const idSet = new Set<number>();
      for (const item of CAPABILITY_MATRIX) {
        expect(item.id).toBeGreaterThanOrEqual(1);
        expect(item.id).toBeLessThanOrEqual(staticCatalogSize);
        expect(idSet.has(item.id)).toBe(false);
        idSet.add(item.id);

        expect(item.capabilityId).toBeDefined();
        expect(item.name.length).toBeGreaterThan(0);
        expect(item.type).toMatch(/^(runtime|tool|orchestration|security_ops|configuration)$/);
        expect(item.testType).toMatch(/^(unit|integration|e2e|manual|blocked_external)$/);
        expect(item.testFiles.length).toBeGreaterThan(0);
        expect(item.status).toMatch(
          /^(VERIFIED_EXISTING|PARTIALLY_IMPLEMENTED|NOT_IMPLEMENTED|BLOCKED_EXTERNAL)$/,
        );
      }

      expect(idSet.size).toBe(CAPABILITY_MATRIX.length);

      // Inventory ids are contiguous 1..N: a hole means a published capability disappeared from the catalog,
      // which the old exact-count pin could only detect when the count itself moved.
      for (let id = 1; id <= staticCatalogSize; id++) {
        expect(idSet.has(id)).toBe(true);
      }
    });

    it("verifies exact separation: agent-callable tools vs internal runtime/ops items", () => {
      /**
       * The non-tool side of the audited 306 baseline (306 = 42 agent-callable tools + 264 runtime/ops items).
       * It has never moved across C2..C12 — only the tool side grew — so it stays an exact literal: a runtime
       * or ops capability disappearing from the catalog must fail here.
       */
      const HISTORICAL_NON_TOOL_BASELINE = 264;

      const callable = CAPABILITY_MATRIX.filter((c) => c.agentCallable);
      const internal = CAPABILITY_MATRIX.filter((c) => !c.agentCallable);

      // The catalog is the source of truth for the current tool-side split; the separately authored audit
      // matrix must describe the same split, and the two partitions must cover the whole catalog.
      const catalogCallable = CAPABILITY_CATALOG.filter((c) => c.agentCallable).length;
      expect(internal.length).toBe(HISTORICAL_NON_TOOL_BASELINE);
      expect(callable.length).toBe(catalogCallable);
      expect(callable.length + internal.length).toBe(CAPABILITY_MATRIX.length);

      // All agentCallable must have type tool
      for (const tool of callable) {
        expect(tool.type).toBe("tool");
      }
    });
  });

  describe("Negative Tool Selection and Per-Agent Deny", () => {
    it("strictly routes explanation queries to NO_TOOL path and detects signals", () => {
      const router = new HybridRouter();

      const evaluation = router.route({
        message: "Поясни як працює архітектура системи",
        resolutionContext: {
          auth: { workspaceId: "ws-test", userId: "u-test", permissions: ["workspace:read"] },
          activeContext: { contextType: "company", companyId: "c-test" },
        },
      });

      expect(evaluation.isNoTool).toBe(true);
      expect(evaluation.candidateTools.length).toBe(0);
    });

    it("enforces per-agent deny: disabling a tool on an agent excludes it from allowed capabilities", () => {
      const resolver = new EffectiveCapabilityResolver();

      // Find an existing agent-callable tool
      const toolCap = CAPABILITY_CATALOG.find((c) => c.agentCallable && c.type === "tool");
      expect(toolCap).toBeDefined();
      const capId = toolCap!.id;

      // When tool is omitted from agent's tools and in disabledCapabilities
      const denied = resolver.canExecute({
        auth: { workspaceId: "ws-test", userId: "u-test", permissions: ["workspace:read", "workspace:write", "business:manage"] },
        activeContext: { contextType: "company", companyId: "c-123" },
        company: { id: "c-123", revision: 1 },
        agent: {
          id: "a-123",
          revision: 1,
          tools: ["different.tool"],
          disabledCapabilities: [capId],
        },
      }, capId);

      expect(denied.allowed).toBe(false);
      expect(denied.detail?.status).toBe("denied");
    });

    it("routes active research prompts to USE_TOOLS path with bounded candidates", () => {
      const router = new HybridRouter();

      const evaluation = router.route({
        message: "Search today latest tech news and crawl https://example.com",
        resolutionContext: {
          auth: { workspaceId: "ws-test", userId: "u-test", permissions: ["workspace:read", "workspace:write", "business:manage", "research:execute"] },
          activeContext: { contextType: "company", companyId: "c-test" },
          company: { id: "c-test", revision: 1 },
          agent: { id: "a-test", revision: 1, tools: ["*"] },
          activeConnections: ["crawler", "postgres", "redis"],
        },
      });

      expect(evaluation.isNoTool).toBe(false);
      expect(evaluation.candidateTools.length).toBeGreaterThan(0);
      expect(evaluation.candidateTools.length).toBeLessThanOrEqual(15);
    });
  });

  describe("Cross-Tenant and Cross-Company Negative Isolation", () => {
    const store = new InMemoryWorkspaceStore();

    const tenantA: AuthContext = {
      workspaceId: "ws-isolation-a",
      userId: "user-a",
      permissions: ["workspace:read", "workspace:write", "business:manage"],
    };

    const tenantB: AuthContext = {
      workspaceId: "ws-isolation-b",
      userId: "user-b",
      permissions: ["workspace:read", "workspace:write", "business:manage"],
    };

    it("guarantees Tenant B cannot read or execute Company A's runs", async () => {
      const companyA = await store.createCompany(tenantA, { name: "Confidential Corp A" }, "idemp-comp-a");
      const agentA = await store.createCompanyAgent(tenantA, companyA.id, {
        name: "Agent A",
        role: "Coordinator",
        tools: ["web.search"],
        isActive: true,
      }, "idemp-agent-a");
      await store.setCompanyMainAgent(tenantA, companyA.id, agentA.id, companyA.revision);

      const { run } = await store.createCompanyAgentRun(
        tenantA,
        companyA.id,
        { task: "Private audit task", requestedMode: "single" },
        "idemp-run-a"
      );

      // Tenant B tries to read Company A
      await expect(store.getCompany(tenantB, companyA.id)).rejects.toThrow();

      // Tenant B tries to read Company A's run
      await expect(store.getCompanyAgentRun(tenantB, companyA.id, run.id)).rejects.toThrow();
    });
  });

  describe("Company E2E Orchestration Lane", () => {
    it("successfully runs Company E2E delegation with tool telemetry and state progression", async () => {
      const store = new InMemoryWorkspaceStore();
      let mainAgentId = "";
      const mockAi = {
        chat: vi.fn().mockResolvedValue({ content: "Grounded final market analysis", model: "single" }),
        a2aSend: vi.fn().mockImplementation(async () => ({
          content: JSON.stringify({
            mode: "single",
            agentIds: [mainAgentId],
            toolRequests: [{ agentId: mainAgentId, tool: "web.search", input: { query: "NPATI AI" } }],
          }),
        })),
        ensureCombo: vi.fn().mockResolvedValue({ name: "combo-test" }),
        ensureA2AEnabled: vi.fn().mockResolvedValue(undefined),
        executeTool: vi.fn().mockResolvedValue({ results: ["NPATI Open Source Agent"] }),
      };

      const runtime = new CompanyDelegationRuntime(
        store,
        mockAi as any,
        10_000,
        { execute: async () => ({ results: ["Grounded Search Result"] }) } as any
      );

      const ctx: AuthContext = {
        workspaceId: "ws-e2e-orchestration",
        userId: "user-e2e",
        permissions: ["workspace:read", "workspace:write", "business:manage"],
      };

      const company = await store.createCompany(ctx, { name: "E2E Enterprise" }, "idemp-e2e-comp");
      const main = await store.createCompanyAgent(ctx, company.id, {
        name: "Main Agent",
        role: "Coordinator",
        tools: ["web.search"],
        isActive: true,
      }, "idemp-e2e-agent");
      mainAgentId = main.id;
      await store.setCompanyMainAgent(ctx, company.id, main.id, company.revision);

      const details = await runtime.execute(ctx, company.id, { task: "Conduct market research", mode: "single" }, "idemp-e2e-exec");

      expect(details.run.status).toBe("completed");
      expect(details.toolAudit.length).toBeGreaterThanOrEqual(1);
      const searchAudit = details.toolAudit.find((a) => a.toolName === "web.search" && a.status === "succeeded");
      expect(searchAudit).toBeDefined();
      expect(searchAudit?.sequenceNumber).toBeDefined();
      expect(searchAudit?.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
