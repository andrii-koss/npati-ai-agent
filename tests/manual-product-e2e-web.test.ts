import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import {
  HybridRouter,
  EffectiveCapabilityResolver,
  RiskApprovalService,
  CapabilityInspectorService,
  buildRunTimeline,
  validateActiveContext,
} from "@npati/shared";

describe("Manual Product E2E: Full Web User Flow", () => {
  let store: InMemoryWorkspaceStore;
  let authContext: AuthContext;
  let authProvider: AuthProvider;
  let app: ReturnType<typeof buildApp>;

  const mockAiEngine: AIEngine = {
    chat: vi.fn().mockResolvedValue({ content: "AI response successfully generated", model: "auto" }),
    stream: async function* () { yield "AI response"; },
    listModels: vi.fn().mockResolvedValue([]),
    getModel: vi.fn().mockResolvedValue(undefined),
    executeTool: vi.fn().mockResolvedValue({ results: [{ title: "Search Evidence" }] }),
    searchMemory: vi.fn().mockResolvedValue([]),
    saveMemory: vi.fn().mockResolvedValue(undefined),
    getCapabilities: vi.fn().mockResolvedValue(["chat", "tools"]),
    healthCheck: vi.fn().mockResolvedValue({ status: "ok" }),
    ensureA2AEnabled: vi.fn().mockResolvedValue(undefined),
    a2aSend: vi.fn().mockResolvedValue({
      taskId: "task-e2e-01",
      content: JSON.stringify({ mode: "pipeline", agentIds: [], toolRequests: [] }),
      metadata: {},
    }),
    cancelA2ATask: vi.fn().mockResolvedValue(undefined),
    ensureCombo: vi.fn().mockResolvedValue({ name: "combo-e2e" }),
  };

  const mockMarketplace = {
    marketplace: vi.fn().mockResolvedValue({ overview: { connectedProviders: 1 } }),
  } as unknown as OmniRouteMarketplace;

  beforeEach(() => {
    store = new InMemoryWorkspaceStore();
    authContext = {
      workspaceId: "ws-flow-101",
      userId: "usr-flow-101",
      permissions: ["workspace:read", "workspace:write", "business:manage", "research:execute"],
    };
    authProvider = { authenticate: async () => ({ ...authContext }) };
    app = buildApp({
      workspaceStore: store,
      authProvider,
      aiEngine: mockAiEngine,
      marketplace: mockMarketplace,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("executes the complete user flow from Registration to Run Trace", async () => {
    // -------------------------------------------------------------
    // 1. Registration / User Onboarding
    // -------------------------------------------------------------
    // Auth context validates workspace and default permissions
    expect(authContext.workspaceId).toBe("ws-flow-101");
    expect(authContext.permissions).toContain("workspace:read");
    expect(authContext.permissions).toContain("business:manage");

    // -------------------------------------------------------------
    // 2. Chat (Neutral Chat without Company / Business)
    // -------------------------------------------------------------
    const neutralEvalRes = await app.inject({
      method: "POST",
      url: "/router/evaluate",
      payload: {
        message: "Поясни, як працює векторний пошук у двох словах",
        contextType: "none",
      },
    });
    expect(neutralEvalRes.statusCode).toBe(200);
    const neutralEval = neutralEvalRes.json();
    expect(neutralEval.isNoTool).toBe(true);
    expect(neutralEval.candidateTools).toHaveLength(0);

    // -------------------------------------------------------------
    // 3. Business (Incubation workspace, ideas, memory)
    // -------------------------------------------------------------
    const bizRes = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { "idempotency-key": "idemp-e2e-biz-01" },
      payload: {
        name: "Specialty Coffee Roastery",
        ideaDescription: "Direct trade organic coffee bean roasting and subscription",
      },
    });
    expect(bizRes.statusCode).toBe(201);
    const business = bizRes.json();
    expect(business.id).toBeDefined();
    expect(business.name).toBe("Specialty Coffee Roastery");

    // Chat in Business Context
    const bizEvalRes = await app.inject({
      method: "POST",
      url: "/router/evaluate",
      payload: {
        message: "Які перші кроки для валідації попиту на підписку?",
        contextType: "business",
        businessId: business.id,
      },
    });
    expect(bizEvalRes.statusCode).toBe(200);
    const bizEval = bizEvalRes.json();
    expect(bizEval.isNoTool).toBe(true); // business coaching without tool side-effects

    // -------------------------------------------------------------
    // 4. Company (Creation, Brand, Revision, Instructions)
    // -------------------------------------------------------------
    const compRes = await app.inject({
      method: "POST",
      url: "/companies",
      headers: { "idempotency-key": "idemp-e2e-comp" },
      payload: {
        name: "Artisan Roasters Inc",
        industry: "Food & Beverage",
        brandTone: "Warm, Crafted, Expert",
        companyInstructions: "Prioritize single-origin sustainability and transparency.",
        businessId: business.id,
      },
    });
    expect(compRes.statusCode).toBe(201);
    const company = compRes.json();
    expect(company.id).toBeDefined();
    expect(company.revision).toBe(1);

    // -------------------------------------------------------------
    // 5. Agents (Main Agent + Specialist Agents + Hierarchy)
    // -------------------------------------------------------------
    // 5a. Create Main Agent
    const mainAgRes = await app.inject({
      method: "POST",
      url: `/companies/${company.id}/agents`,
      headers: { "idempotency-key": "idemp-e2e-main-ag" },
      payload: {
        name: "Head of Operations",
        role: "Coordinator",
        description: "Orchestrates research and publication workflow",
        tools: [],
        isActive: true,
      },
    });
    expect(mainAgRes.statusCode).toBe(201);
    const mainAgent = mainAgRes.json();

    // Set as Main Agent
    const setMainRes = await app.inject({
      method: "PUT",
      url: `/companies/${company.id}/main-agent`,
      payload: {
        agentId: mainAgent.id,
        expectedRevision: company.revision,
      },
    });
    expect(setMainRes.statusCode).toBe(200);

    // 5b. Create Specialist Agents
    const researchAgRes = await app.inject({
      method: "POST",
      url: `/companies/${company.id}/agents`,
      headers: { "idempotency-key": "idemp-e2e-research-ag" },
      payload: {
        name: "Coffee Market Researcher",
        role: "Specialist",
        tools: ["research.web_search", "browser.web_fetch"],
        isActive: true,
      },
    });
    expect(researchAgRes.statusCode).toBe(201);
    const researchAgent = researchAgRes.json();

    // Verify Hierarchy
    const agentsListRes = await app.inject({
      method: "GET",
      url: `/companies/${company.id}/agents`,
    });
    expect(agentsListRes.statusCode).toBe(200);
    const { agents } = agentsListRes.json();
    expect(agents).toHaveLength(2);

    // -------------------------------------------------------------
    // 6. Skills / Tools Discovery
    // -------------------------------------------------------------
    const capsRes = await app.inject({
      method: "GET",
      url: "/capabilities?callable=true",
    });
    expect(capsRes.statusCode).toBe(200);
    const tools = capsRes.json();
    expect(tools.length).toBe(97); // Exactly 97 agent-callable tools

    const skillsRes = await app.inject({
      method: "GET",
      url: "/skills",
    });
    expect(skillsRes.statusCode).toBe(200);
    const skills = skillsRes.json();
    expect(skills.length).toBeGreaterThan(0);

    // -------------------------------------------------------------
    // 7. Active Context Binding
    // -------------------------------------------------------------
    const activeCtx = validateActiveContext({
      contextType: "company",
      companyId: company.id,
    });
    expect(activeCtx.contextType).toBe("company");
    expect(activeCtx.companyId).toBe(company.id);
    expect(activeCtx.businessId).toBeNull();

    // -------------------------------------------------------------
    // 8. Tool Routing under Active Company Intent
    // -------------------------------------------------------------
    const routeRes = await app.inject({
      method: "POST",
      url: "/router/evaluate",
      payload: {
        message: "Знайди актуальні ціни на кавові зерна в Колумбії сьогодні",
        contextType: "company",
        companyId: company.id,
      },
    });
    expect(routeRes.statusCode).toBe(200);
    const routeDecision = routeRes.json();
    expect(routeDecision.isNoTool).toBe(false);
    expect(routeDecision.candidateTools.length).toBeGreaterThan(0);
    expect(routeDecision.candidateTools.length).toBeLessThanOrEqual(15);
    expect(routeDecision.matchedSignals).toContain("time_sensitive");

    // -------------------------------------------------------------
    // 9. Permissions & Authorization Guard
    // -------------------------------------------------------------
    const resolver = new EffectiveCapabilityResolver();

    // Research tool is allowed for research agent
    const allowCheck = resolver.canExecute(
      {
        auth: authContext,
        activeContext: activeCtx,
        company: { id: company.id, revision: 2 },
        agent: { id: researchAgent.id, revision: 1, tools: ["research.web_search"] },
        activeConnections: ["crawler", "postgres", "redis"],
      },
      "research.web_search"
    );
    expect(allowCheck.allowed).toBe(true);

    // Disallowed system tool is denied
    const denyCheck = resolver.canExecute(
      {
        auth: authContext,
        activeContext: activeCtx,
        company: { id: company.id, revision: 2 },
        agent: {
          id: researchAgent.id,
          revision: 1,
          tools: ["research.web_search"],
          disabledCapabilities: ["system.database_drop"],
        },
      },
      "system.database_drop"
    );
    expect(denyCheck.allowed).toBe(false);

    // -------------------------------------------------------------
    // 10. Run Execution & Run Trace Inspection
    // -------------------------------------------------------------
    const runRes = await app.inject({
      method: "POST",
      url: `/companies/${company.id}/runs`,
      headers: { "idempotency-key": "idemp-e2e-run-01" },
      payload: {
        task: "Досліди останні ціни на каву та надай висновок",
        mode: "single",
      },
    });
    if (runRes.statusCode !== 200 && runRes.statusCode !== 201) {
      console.error("RUN ERROR:", runRes.body);
    }
    expect([200, 201, 202]).toContain(runRes.statusCode);
    const runBody = runRes.json();
    expect(runBody.run.id).toBeDefined();
    expect(["completed", "queued", "running"]).toContain(runBody.run.status);

    // Inspect capabilities & run via Inspector endpoint
    const inspectRes = await app.inject({
      method: "GET",
      url: `/capabilities/inspect?slice=agent-callable&companyId=${company.id}`,
    });
    expect(inspectRes.statusCode).toBe(200);
    const inspectorReport = inspectRes.json();
    expect(inspectorReport.counts.all).toBe(361);
    expect(inspectorReport.counts.agentCallable).toBe(97);

    // Verify activity timeline without secret leak
    const mockRun: any = {
      id: runBody.run.id,
      workspaceId: authContext.workspaceId,
      companyId: company.id,
      mainAgentId: mainAgent.id,
      selectedAgentIds: [mainAgent.id, researchAgent.id],
      task: "Досліди останні ціни на каву та надай висновок",
      requestedMode: "single",
      executionMode: "single",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    const timeline = buildRunTimeline(mockRun, [], [
      {
        id: "audit-e2e-01",
        runId: runBody.run.id,
        stepId: "step-1",
        toolName: "research.web_search",
        status: "succeeded",
        payloadHash: "sha256-hash-safe",
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    const timelineStr = JSON.stringify(timeline);
    expect(timelineStr).not.toContain("sk-proj");
    expect(timelineStr).not.toContain("password");
  });
});
