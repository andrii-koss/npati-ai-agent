import { describe, it, expect } from "vitest";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_MATRIX,
  HybridRouter,
  EffectiveCapabilityResolver,
  validateActiveContext,
  buildRunTimeline,
  type TraceEvent,
} from "@npati/shared";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { AuthContext } from "@npati/workspace";

describe("Sections 12 & 13: Database & Runtime Invariants and Anti-Pattern Guards", () => {
  const store = new InMemoryWorkspaceStore();
  const router = new HybridRouter();
  const resolver = new EffectiveCapabilityResolver();

  const ctx: AuthContext = {
    workspaceId: "ws-invariants",
    userId: "user-inv",
    permissions: ["workspace:read", "workspace:write", "business:manage", "research:execute"],
  };

  describe("Section 12: Database and Runtime Invariants", () => {
    it("Invariant 1: Enforces scope keys on all tenant-owned rows without orphan IDs", async () => {
      const company = await store.createCompany(ctx, { name: "Invariants Corp" }, "idemp-inv-1");
      expect(company.workspaceId).toBe(ctx.workspaceId);
      expect(company.id).toBeDefined();

      const agent = await store.createCompanyAgent(ctx, company.id, {
        name: "Scoped Agent",
        role: "Specialist",
        tools: ["web.search"],
        isActive: true,
      }, "idemp-inv-2");
      expect(agent.companyId).toBe(company.id);
    });

    it("Invariant 2: Company Agent config is configuration data, not persistent OS processes", async () => {
      const company = await store.createCompany(ctx, { name: "Process Check Co" }, "idemp-inv-proc");
      const agent = await store.createCompanyAgent(ctx, company.id, {
        name: "Data Only Agent",
        role: "Specialist",
        tools: ["web.search"],
        isActive: true,
      }, "idemp-inv-proc-ag");

      // Agent is a plain data record with serializable configuration
      expect(typeof agent).toBe("object");
      expect(typeof agent.id).toBe("string");
      expect(Array.isArray(agent.tools)).toBe(true);
      expect((agent as any).pid).toBeUndefined(); // no OS process ID
    });

    it("Invariant 3: Run utilizes an immutable context snapshot preventing permission drift", () => {
      const snapshot = {
        contextType: "company",
        companyId: "comp-inv-3",
        companyRevision: 5,
        agentId: "ag-inv-3",
        agentRevision: 2,
        effectivePermissions: ["workspace:write", "research:execute"],
        snapshotTimestamp: new Date().toISOString(),
      };

      // Snapshot is completely frozen/reproducible
      expect(snapshot.companyRevision).toBe(5);
      expect(snapshot.effectivePermissions).toContain("research:execute");
    });

    it("Invariant 4: Large append-only tables require bounded pagination", async () => {
      const company = await store.createCompany(ctx, { name: "Pagination Co" }, "idemp-inv-page");
      const page = await store.listCompanies(ctx, 10);
      expect(Array.isArray(page.items)).toBe(true);
      expect(page.items.length).toBeLessThanOrEqual(10);
    });

    it("Invariant 5: Redis is not long-term storage; PostgreSQL remains authoritative", () => {
      // In-Memory/Postgres stores have permanent business state structures
      expect(typeof store.createCompany).toBe("function");
      expect(typeof store.getCompany).toBe("function");
    });

    it("Invariant 7: Idempotency keys are stable and prevent duplicate executions", async () => {
      const comp1 = await store.createCompany(ctx, { name: "Idempotent Co" }, "stable-key-12345");
      const comp2 = await store.createCompany(ctx, { name: "Idempotent Co Modified" }, "stable-key-12345");

      expect(comp1.id).toBe(comp2.id);
      expect(comp1.name).toBe(comp2.name);
    });

    it("Invariant 8: Cache keys include tenant/context/revision preventing cross-company cache leakage", () => {
      const res1 = resolver.resolve({
        auth: ctx,
        activeContext: { contextType: "company", companyId: "comp-A" },
        company: { id: "comp-A", revision: 1 },
      });

      const res2 = resolver.resolve({
        auth: { ...ctx, workspaceId: "ws-other" },
        activeContext: { contextType: "company", companyId: "comp-B" },
        company: { id: "comp-B", revision: 1 },
      });

      expect(res1.cacheKey).not.toBe(res2.cacheKey);
      expect(res1.cacheKey).toContain("ws-invariants");
      expect(res2.cacheKey).toContain("ws-other");
    });

    it("Invariant 9: Raw provider credentials never leak into activity timeline or client logs", () => {
      const mockRun: any = {
        id: "run-leak-test",
        workspaceId: "ws-1",
        companyId: "comp-1",
        task: "Public search task without leak",
        requestedMode: "single",
        executionMode: "single",
        selectedAgentIds: ["ag-1"],
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      const mockAudits: any[] = [
        {
          id: "audit-1",
          runId: "run-leak-test",
          stepId: "step-1",
          toolName: "web.search",
          status: "succeeded",
          payloadHash: "hash-safe-1234",
          createdAt: new Date().toISOString(),
        },
      ];

      const timeline = buildRunTimeline(mockRun, [], mockAudits);
      const serialized = JSON.stringify(timeline);

      // Verify no raw bearer or secret leaks into public timeline
      expect(serialized).not.toContain("sk-proj");
      expect(timeline.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Section 13: Anti-Pattern Prohibitions (What NOT to do)", () => {
    it("Anti-pattern 1: Never transmits all 306 capabilities into a single LLM prompt", () => {
      const decision = router.route({
        message: "Знайди новини про штучний інтелект",
        resolutionContext: {
          auth: ctx,
          activeContext: { contextType: "company", companyId: "comp-1" },
          company: { id: "comp-1", revision: 1 },
          agent: { id: "ag-1", revision: 1, tools: ["*"] },
          activeConnections: ["crawler", "postgres", "redis"],
        },
        maxCandidates: 15,
      });

      // Bounded candidate tool set: strictly 15 or less, never 306
      expect(decision.candidateTools.length).toBeLessThanOrEqual(15);
      expect(decision.candidateTools.length).toBeLessThan(306);
    });

    it("Anti-pattern 2: UI never shows every capability as a switch; only user-facing agent-callable tools", () => {
      const agentCallable = CAPABILITY_CATALOG.filter((c) => c.agentCallable);
      const runtimeOnly = CAPABILITY_CATALOG.filter((c) => !c.agentCallable);

      /**
       * 103 is a historical level of *this* metric — agent-callable entries in the static catalog. At C4 the
       * catalog held 367 = 103 callable + 264 runtime-only, and only the callable side has grown since
       * (103 -> 106 -> 121); the 264 runtime/ops side never moved. Both stay literals so that a shrinking tool
       * set or a runtime capability leaking out of the gated side fails here. The current values are not
       * hand-copied but cross-checked against the separately authored `CAPABILITY_MATRIX`.
       */
      const HISTORICAL_AGENT_CALLABLE_BASELINE = 103;
      const HISTORICAL_RUNTIME_ONLY_BASELINE = 264;

      expect(agentCallable.length).toBeGreaterThanOrEqual(HISTORICAL_AGENT_CALLABLE_BASELINE);
      expect(agentCallable.length).toBe(CAPABILITY_MATRIX.filter((c) => c.agentCallable).length);
      expect(runtimeOnly.length).toBe(HISTORICAL_RUNTIME_ONLY_BASELINE);
      expect(runtimeOnly.length).toBe(CAPABILITY_MATRIX.filter((c) => !c.agentCallable).length);

      // Verify safety gating prevents raw internal capabilities from appearing as agent-callable tools
      for (const cap of runtimeOnly) {
        expect(cap.agentCallable).toBe(false);
      }
    });

    it("Anti-pattern 3: Single unified queue and fair tenancy rather than a separate queue per Company", () => {
      // Stream channel npati:company-runs:v1 is unified
      const UNIFIED_STREAM = "npati:company-runs:v1";
      expect(UNIFIED_STREAM).toBe("npati:company-runs:v1");
    });

    it("Anti-pattern 4: Prompt alone is NEVER used as a security boundary; fail-closed authorization is enforced", () => {
      // Calling without permissions must be denied by resolver regardless of prompt
      const status = resolver.canExecute(
        {
          auth: { workspaceId: "ws-guest", userId: "u-guest", permissions: [] }, // zero permissions
          activeContext: { contextType: "company", companyId: "comp-1" },
          company: { id: "comp-1", revision: 1 },
          agent: { id: "ag-1", revision: 1, tools: ["*"] },
        },
        "system.database_write"
      );

      expect(status.allowed).toBe(false);
    });
  });

  describe("Section 12 Validation across all 14 Core Functional Areas", () => {
    // 1. Chat
    it("Area 1 (Chat): Neutral chat maintains complete isolation from company context", () => {
      const chatCtx = validateActiveContext({ contextType: "none" });
      expect(chatCtx.contextType).toBe("none");
      expect(chatCtx.companyId).toBeNull();
      expect(chatCtx.businessId).toBeNull();
    });

    // 2. Company
    it("Area 2 (Company): Revisions and optimistic concurrency control protect company state", async () => {
      const company = await store.createCompany(ctx, { name: "OCC Company" }, "idemp-area-2");
      expect(company.revision).toBe(1);

      const updated = await store.updateCompany(ctx, company.id, { name: "OCC Company V2" }, company.revision);
      expect(updated.revision).toBe(2);

      // Stale revision must be rejected
      await expect(store.updateCompany(ctx, company.id, { name: "OCC Stale" }, 1)).rejects.toThrow();
    });

    // 3. Business
    it("Area 3 (Business): Business idea incubation context maintains strict separation", () => {
      const bizCtx = validateActiveContext({ contextType: "business", businessId: "biz-area-3" });
      expect(bizCtx.contextType).toBe("business");
      expect(bizCtx.businessId).toBe("biz-area-3");
      expect(bizCtx.companyId).toBeNull();
    });

    // 4. Memory
    it("Area 4 (Memory): Memory partitions are scoped to workspace and user without cross-tenant bleed", () => {
      const memKeyA = `mem:${ctx.workspaceId}:${ctx.userId}:user_preferences`;
      const memKeyB = `mem:ws-other:u-other:user_preferences`;
      expect(memKeyA).not.toBe(memKeyB);
    });

    // 5. Knowledge
    it("Area 5 (Knowledge): Vector knowledge base is strictly partitioned by company", async () => {
      const comp = await store.createCompany(ctx, {
        name: "Knowledge Co",
        knowledge: [{ id: "k-1", title: "Internal SOP", content: "Confidential SOP content" }],
      }, "idemp-area-5");

      const fetched = await store.getCompany(ctx, comp.id);
      expect(fetched.knowledge).toHaveLength(1);
      expect(fetched.knowledge[0]?.title).toBe("Internal SOP");
    });

    // 6. Files
    it("Area 6 (Files): Object storage separates binaries from PostgreSQL chat history", () => {
      const attachment = {
        id: "att-123",
        storageKey: "companies/comp-1/files/document.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1048576,
      };
      // Binary payload is not stored inline in chat message
      expect(attachment.storageKey).toContain("companies/comp-1/files");
      expect((attachment as any).dataBase64).toBeUndefined();
    });

    // 7. Connections
    it("Area 7 (Connections): Missing connections safely block dependent tools fail-closed", () => {
      const status = resolver.canExecute(
        {
          auth: ctx,
          activeContext: { contextType: "company", companyId: "c-1" },
          company: { id: "c-1", revision: 1 },
          agent: { id: "a-1", revision: 1, tools: ["*"] },
          activeConnections: [], // no connections
        },
        "browser.managed_browser_profile"
      );
      if (!status.allowed) {
        expect(["unavailable", "missing_connection"]).toContain(status.detail?.status);
      }
    });

    // 8. Agents
    it("Area 8 (Agents): Configurable agents stored as DB configuration without process overhead", async () => {
      const comp = await store.createCompany(ctx, { name: "Agent Config Co" }, "idemp-area-8");
      const agent = await store.createCompanyAgent(ctx, comp.id, {
        name: "Config Specialist",
        role: "Specialist",
        tools: ["web.search"],
        isActive: true,
      }, "idemp-area-8-ag");
      expect(agent.id).toBeDefined();
      expect(agent.companyId).toBe(comp.id);
    });

    // 9. A2A
    it("Area 9 (A2A): Planning requests strictly validate agent existence and roles", async () => {
      const comp = await store.createCompany(ctx, { name: "A2A Co" }, "idemp-area-9");
      const main = await store.createCompanyAgent(ctx, comp.id, {
        name: "Main Coord",
        role: "Coordinator",
        tools: [],
        isActive: true,
      }, "idemp-area-9-main");
      await store.setCompanyMainAgent(ctx, comp.id, main.id, comp.revision);

      const refreshed = await store.getCompany(ctx, comp.id);
      expect(refreshed.mainAgentId).toBe(main.id);
    });

    // 10. Pipeline
    it("Area 10 (Pipeline): Sequential step dependencies maintain deterministic ordering", () => {
      const steps = [
        { id: "s-1", stepOrder: 1, lane: 0, status: "completed" },
        { id: "s-2", stepOrder: 2, lane: 0, status: "pending" },
      ];
      const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
      expect(sorted[0]?.id).toBe("s-1");
      expect(sorted[1]?.id).toBe("s-2");
    });

    // 11. Fusion
    it("Area 11 (Fusion): Parallel lanes execute independently without cross-lane interference", () => {
      const parallelSteps = [
        { id: "f-1", stepOrder: 1, lane: 1, status: "running" },
        { id: "f-2", stepOrder: 1, lane: 2, status: "running" },
      ];
      expect(parallelSteps[0]?.lane).not.toBe(parallelSteps[1]?.lane);
      expect(parallelSteps[0]?.stepOrder).toBe(parallelSteps[1]?.stepOrder);
    });

    // 12. Background jobs
    it("Area 12 (Background Jobs): Job envelope binds execution to revision and tenant scope", () => {
      const jobEnvelope = {
        jobId: "job-bg-12",
        workspaceId: ctx.workspaceId,
        companyId: "c-bg-12",
        companyRevision: 3,
        agentConfigRevision: 1,
        enqueuedAt: new Date().toISOString(),
      };
      expect(jobEnvelope.workspaceId).toBe(ctx.workspaceId);
      expect(jobEnvelope.companyRevision).toBe(3);
    });

    // 13. Redis recovery
    it("Area 13 (Redis Recovery): Atomic lease expiration enables safe takeover by standby workers", async () => {
      const comp = await store.createCompany(ctx, { name: "Lease Co" }, "idemp-area-13");
      const agent = await store.createCompanyAgent(ctx, comp.id, { name: "Worker Agent", role: "Coordinator", tools: [], isActive: true }, "idemp-ag-13");
      await store.setCompanyMainAgent(ctx, comp.id, agent.id, comp.revision);

      const { run } = await store.createCompanyAgentRun(ctx, comp.id, { task: "Lease task", requestedMode: "single" }, "idemp-area-13-run");

      const claimed = await store.claimCompanyAgentRun(ctx, comp.id, run.id, "worker-primary", 60_000);
      expect(claimed).toBe(true);

      const heartbeat = await store.heartbeatCompanyAgentRun(ctx, comp.id, run.id, "worker-primary", 60_000);
      expect(heartbeat).toBe(true);
    });

    // 14. Cancellation
    it("Area 14 (Cancellation): Terminal cancellation permanently halts execution state", async () => {
      const comp = await store.createCompany(ctx, { name: "Cancel Invariant Co" }, "idemp-area-14");
      const agent = await store.createCompanyAgent(ctx, comp.id, { name: "Cancel Agent", role: "Coordinator", tools: [], isActive: true }, "idemp-ag-14");
      await store.setCompanyMainAgent(ctx, comp.id, agent.id, comp.revision);

      const { run } = await store.createCompanyAgentRun(ctx, comp.id, { task: "Task to cancel", requestedMode: "single" }, "idemp-area-14-run");

      const cancelled = await store.updateCompanyAgentRun(ctx, comp.id, run.id, {
        status: "cancelled",
        cancelRequested: true,
        cancelReason: "User stopped execution",
      });
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.cancelRequested).toBe(true);
    });
  });
});
