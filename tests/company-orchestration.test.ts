import { buildApp } from "../apps/agent-api/src/app";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import type { AIEngine, OmniRouteComboInput } from "@npati/omniroute-adapter";
import type { AuthContext } from "@npati/workspace";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function engine(overrides: Partial<AIEngine> = {}): AIEngine {
  return {
    chat: async () => ({ content: "Manager final answer", model: "auto" }),
    async *stream() { yield ""; },
    listModels: async () => [],
    getModel: async () => undefined,
    executeTool: async () => ({ results: [{ title: "Evidence" }] }),
    searchMemory: async () => [],
    saveMemory: async () => undefined,
    getCapabilities: async () => ["chat"],
    healthCheck: async () => ({ status: "ok" }),
    ensureA2AEnabled: async () => undefined,
    a2aSend: async () => ({ taskId: "a2a-task", content: '{"mode":"single","agentIds":[],"toolRequests":[]}', metadata: {} }),
    cancelA2ATask: async () => undefined,
    ensureCombo: async (input) => ({ name: input.name }),
    ...overrides,
  };
}

const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

async function setup(ai: AIEngine, active: { value: AuthContext }, companyRunTimeoutMs = 5_000) {
  const store = new InMemoryWorkspaceStore();
  const auth: AuthProvider = { authenticate: async () => ({ ...active.value, permissions: [...active.value.permissions] }) };
  const app = buildApp({ workspaceStore: store, authProvider: auth, aiEngine: ai, marketplace, companyRunTimeoutMs });
  apps.push(app);
  const company = await app.inject({
    method: "POST",
    url: "/companies",
    headers: { "idempotency-key": `comp-${Date.now()}-${Math.random()}` },
    payload: { name: "Orchestration Co" },
  });
  return { app, store, companyId: (company.json() as { id: string }).id };
}

describe("PHASE 5: Company Main Agent + Specialist Agent Orchestration", () => {
  const baseAuth: AuthContext = {
    workspaceId: "ws-orch",
    userId: "user-orch",
    permissions: ["workspace:read", "workspace:write", "business:manage", "research:execute"],
  };

  it("successfully orchestrates Main -> Specialist delegation with tool execution", async () => {
    const chat = vi.fn(async () => ({ content: "Final verified article", model: "pipeline" }));
    const executeTool = vi.fn(async () => ({ results: [{ title: "Latest stats" }] }));
    let plan = "";

    const ai = engine({
      chat,
      executeTool,
      a2aSend: async () => ({ taskId: "a2a-orch-01", content: plan, metadata: {} }),
    });

    const active = { value: baseAuth };
    const { app, companyId } = await setup(ai, active);

    const mgrRes = await app.inject({
      method: "POST",
      url: `/companies/${companyId}/agents`,
      headers: { "idempotency-key": "orch-mgr-1" },
      payload: { name: "Manager", role: "Coordinator" },
    });
    expect(mgrRes.statusCode).toBe(201);
    const managerId = mgrRes.json().id;

    const resRes = await app.inject({
      method: "POST",
      url: `/companies/${companyId}/agents`,
      headers: { "idempotency-key": "orch-res-1" },
      payload: { name: "Researcher", role: "Research", tools: ["Web Search"] },
    });
    expect(resRes.statusCode).toBe(201);
    const researcherId = resRes.json().id;

    await app.inject({
      method: "PUT",
      url: `/companies/${companyId}/main-agent`,
      payload: { agentId: managerId, expectedRevision: 1 },
    });

    plan = JSON.stringify({
      mode: "single",
      agentIds: [researcherId],
      toolRequests: [{ agentId: researcherId, tool: "web.search", input: { query: "AI statistics" } }],
    });

    const res = await app.inject({
      method: "POST",
      url: `/companies/${companyId}/runs`,
      headers: { "idempotency-key": "orch-run-001" },
      payload: { task: "Research AI trends", mode: "auto" },
    });

    expect(res.statusCode).toBe(200);
    const runId = res.json().run.id;

    const details = await app.inject({ method: "GET", url: `/companies/${companyId}/runs/${runId}` });
    expect(details.json().run.status).toBe("completed");
    expect(executeTool).toHaveBeenCalledWith("web.search", { query: "AI statistics" });
    expect(details.json().steps).toHaveLength(2); // Main + Specialist
  });

  it("configures fallback model in OmniRoute combo priority strategy", async () => {
    const combos: OmniRouteComboInput[] = [];
    const store = new InMemoryWorkspaceStore();
    await store.initialize();

    const company = await store.createCompany(baseAuth, { name: "Fallback Co" }, "fallback-company");
    const manager = await store.createCompanyAgent(
      baseAuth,
      company.id,
      {
        name: "Manager",
        role: "Coordinator",
        modelId: "model-primary",
        fallbackModelId: "model-secondary",
      },
      "fallback-agent"
    );
    await store.setCompanyMainAgent(baseAuth, company.id, manager.id, company.revision);

    const ai = engine({
      a2aSend: async () => ({
        taskId: "a2a-fb",
        content: JSON.stringify({ mode: "single", agentIds: [], toolRequests: [] }),
        metadata: {},
      }),
      ensureCombo: async (input) => {
        combos.push(input);
        return { name: input.name };
      },
    });

    const runtime = new CompanyDelegationRuntime(store, ai);
    const result = await runtime.execute(baseAuth, company.id, { task: "Test fallback model" }, "fb-run-01");

    expect(result.run.status).toBe("completed");
    const priorityCombos = combos.filter((c) => c.strategy === "priority");
    expect(priorityCombos.length).toBeGreaterThan(0);
    expect(priorityCombos.some((c) => c.models.includes("model-secondary"))).toBe(true);
    expect(priorityCombos.every((c) => c.config?.maxRetries === 2 && c.config?.failoverBeforeRetry === true)).toBe(true);
  });

  it("preserves sequential order in Pipeline mode", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();

    const company = await store.createCompany(baseAuth, { name: "Pipeline Co" }, "pipe-company");
    const manager = await store.createCompanyAgent(baseAuth, company.id, { name: "Manager", role: "Coordinator" }, "pipe-mgr");
    const step1 = await store.createCompanyAgent(baseAuth, company.id, { name: "Step1", role: "Researcher" }, "pipe-step1");
    const step2 = await store.createCompanyAgent(baseAuth, company.id, { name: "Step2", role: "Writer" }, "pipe-step2");
    await store.setCompanyMainAgent(baseAuth, company.id, manager.id, company.revision);

    const ai = engine({
      a2aSend: async () => ({
        taskId: "a2a-pipe",
        content: JSON.stringify({ mode: "pipeline", agentIds: [step1.id, step2.id], toolRequests: [] }),
        metadata: {},
      }),
    });

    const runtime = new CompanyDelegationRuntime(store, ai);
    const result = await runtime.execute(baseAuth, company.id, { task: "Pipeline run", mode: "pipeline" }, "pipe-run-01");

    expect(result.run.status).toBe("completed");
    expect(result.steps).toHaveLength(3);
    const orders = result.steps.map((s) => s.stepOrder);
    expect(orders).toEqual([0, 1, 2]); // strictly ascending sequential order
  });

  it("isolates parallel lanes in Fusion mode", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();

    const company = await store.createCompany(baseAuth, { name: "Fusion Co" }, "fusion-company");
    const manager = await store.createCompanyAgent(baseAuth, company.id, { name: "Manager", role: "Coordinator" }, "fusion-mgr");
    const workerA = await store.createCompanyAgent(baseAuth, company.id, { name: "WorkerA", role: "Specialist" }, "fusion-wa");
    const workerB = await store.createCompanyAgent(baseAuth, company.id, { name: "WorkerB", role: "Specialist" }, "fusion-wb");
    await store.setCompanyMainAgent(baseAuth, company.id, manager.id, company.revision);

    const ai = engine({
      a2aSend: async () => ({
        taskId: "a2a-fusion",
        content: JSON.stringify({ mode: "fusion", agentIds: [workerA.id, workerB.id], toolRequests: [] }),
        metadata: {},
      }),
    });

    const runtime = new CompanyDelegationRuntime(store, ai);
    const result = await runtime.execute(baseAuth, company.id, { task: "Fusion run", mode: "fusion" }, "fusion-run-01");

    expect(result.run.status).toBe("completed");
    const workers = result.steps.filter((s) => s.role === "worker");
    expect(workers).toHaveLength(2);
    expect(workers[0].stepOrder).toBe(0);
    expect(workers[1].stepOrder).toBe(0);
    expect(workers[0].lane).not.toBe(workers[1].lane); // parallel separate lanes
  });

  it("properly incorporates Reviewer stage in delegation graph", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();

    const company = await store.createCompany(baseAuth, { name: "Reviewer Co" }, "rev-company");
    const manager = await store.createCompanyAgent(baseAuth, company.id, { name: "Manager", role: "Coordinator" }, "rev-mgr");
    const writer = await store.createCompanyAgent(baseAuth, company.id, { name: "Writer", role: "Writer" }, "rev-writer");
    const reviewer = await store.createCompanyAgent(baseAuth, company.id, { name: "Editor", role: "Reviewer" }, "rev-editor");
    await store.setCompanyMainAgent(baseAuth, company.id, manager.id, company.revision);

    const ai = engine({
      a2aSend: async () => ({
        taskId: "a2a-reviewer",
        content: JSON.stringify({ mode: "pipeline", agentIds: [writer.id], reviewerAgentId: reviewer.id, toolRequests: [] }),
        metadata: {},
      }),
    });

    const runtime = new CompanyDelegationRuntime(store, ai);
    const result = await runtime.execute(baseAuth, company.id, { task: "Review document" }, "rev-run-01");

    expect(result.run.status).toBe("completed");
    expect(result.steps.some((s) => s.role === "reviewer" && s.agentId === reviewer.id)).toBe(true);
  });

  it("enforces fail-closed Knowledge policy: agent without Knowledge tool never receives Company Knowledge", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();

    const company = await store.createCompany(baseAuth, { name: "Knowledge Boundary Co" }, "kb-company");
    const manager = await store.createCompanyAgent(baseAuth, company.id, { name: "Manager", role: "Manager", tools: ["Knowledge"] }, "kb-mgr");
    const restrictedWorker = await store.createCompanyAgent(baseAuth, company.id, { name: "Worker", role: "Worker", tools: [] }, "kb-worker");
    await store.setCompanyMainAgent(baseAuth, company.id, manager.id, company.revision);

    const retrieve = vi.fn(async () => ({ chunks: [{ content: "Private data" }], memories: [] }));

    const runtime = new CompanyDelegationRuntime(
      store,
      engine({
        a2aSend: async () => ({
          taskId: "kb-plan",
          content: JSON.stringify({ mode: "single", agentIds: [restrictedWorker.id], toolRequests: [] }),
          metadata: {},
        }),
      }),
      5_000,
      undefined,
      retrieve
    );

    const result = await runtime.execute(baseAuth, company.id, { task: "Summarize knowledge", mode: "single" }, "kb-run-001");
    expect(result.run.status).toBe("completed");
    expect(retrieve).not.toHaveBeenCalled(); // Knowledge retriever must NOT be called!
  });

  it("rejects circular reviewer delegation (agent reviewing only its own work)", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();

    const company = await store.createCompany(baseAuth, { name: "Circular Co" }, "circ-company");
    const manager = await store.createCompanyAgent(baseAuth, company.id, { name: "Manager", role: "Coordinator" }, "circ-mgr");
    const worker = await store.createCompanyAgent(baseAuth, company.id, { name: "Worker", role: "Worker" }, "circ-worker");
    await store.setCompanyMainAgent(baseAuth, company.id, manager.id, company.revision);

    const ai = engine({
      a2aSend: async () => ({
        taskId: "a2a-circ",
        content: JSON.stringify({ mode: "single", agentIds: [worker.id], reviewerAgentId: worker.id, toolRequests: [] }),
        metadata: {},
      }),
    });

    const runtime = new CompanyDelegationRuntime(store, ai);
    const result = await runtime.execute(baseAuth, company.id, { task: "Circular review attempt" }, "circ-run-01");

    expect(result.run.status).toBe("failed");
    expect(result.run.errorCode).toBe("CIRCULAR_DELEGATION");
  });

  it("rejects excessive tool loops in delegation plan", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();

    const company = await store.createCompany(baseAuth, { name: "Loop Co" }, "loop-company");
    const manager = await store.createCompanyAgent(baseAuth, company.id, { name: "Manager", role: "Coordinator" }, "loop-mgr");
    const worker = await store.createCompanyAgent(baseAuth, company.id, { name: "Worker", role: "Worker", tools: ["Web Search"] }, "loop-worker");
    await store.setCompanyMainAgent(baseAuth, company.id, manager.id, company.revision);

    const excessiveTools = Array.from({ length: 25 }, (_, i) => ({
      agentId: worker.id,
      tool: "web.search",
      input: { query: `loop query ${i}` },
    }));

    const ai = engine({
      a2aSend: async () => ({
        taskId: "a2a-loop",
        content: JSON.stringify({ mode: "single", agentIds: [worker.id], toolRequests: excessiveTools }),
        metadata: {},
      }),
    });

    const runtime = new CompanyDelegationRuntime(store, ai);
    const result = await runtime.execute(baseAuth, company.id, { task: "Excessive tools attempt" }, "loop-run-01");

    expect(result.run.status).toBe("failed");
    expect(result.run.errorCode).toBe("TOOL_LOOP_DETECTED");
  });

  it("cancels active run across all delegated agents", async () => {
    let started!: () => void;
    const planning = new Promise<void>((resolve) => { started = resolve; });

    const a2aSend = vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      started();
      signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    }));

    const ai = engine({ a2aSend: a2aSend as AIEngine["a2aSend"] });
    const active = { value: baseAuth };
    const { app, companyId } = await setup(ai, active);

    const mgrRes = await app.inject({
      method: "POST",
      url: `/companies/${companyId}/agents`,
      headers: { "idempotency-key": "canc-mgr-1" },
      payload: { name: "Manager", role: "Coordinator" },
    });
    const managerId = mgrRes.json().id;

    await app.inject({
      method: "PUT",
      url: `/companies/${companyId}/main-agent`,
      payload: { agentId: managerId, expectedRevision: 1 },
    });

    const request = {
      method: "POST" as const,
      url: `/companies/${companyId}/runs`,
      headers: { "idempotency-key": "canc-run-001" },
      payload: { task: "Long running delegation" },
    };

    const running = app.inject(request);
    await planning;

    // Trigger cancellation
    const duplicate = await app.inject(request);
    const runId = duplicate.json().run.id;
    await app.inject({ method: "POST", url: `/companies/${companyId}/runs/${runId}/cancel` });

    const cancelled = await running;
    expect(cancelled.json().run.status).toBe("cancelled");
    expect(cancelled.json().run.errorCode).toBe("RUN_CANCELLED");
  });
});
