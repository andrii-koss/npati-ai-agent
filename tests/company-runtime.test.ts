import { buildApp } from "../apps/agent-api/src/app";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import type { AIEngine, OmniRouteComboInput } from "@npati/omniroute-adapter";
import type { AuthContext } from "@npati/workspace";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function engine(overrides: Partial<AIEngine> = {}): AIEngine {
  return {
    chat: async () => ({ content: "Manager final answer", model: "auto" }),
    async *stream() { yield ""; },
    listModels: async () => [], getModel: async () => undefined,
    executeTool: async () => ({ results: [{ title: "Evidence" }] }),
    searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
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
  const company = await app.inject({ method: "POST", url: "/companies", headers: { "idempotency-key": "company-runtime-001" }, payload: { name: "Runtime Co" } });
  return { app, companyId: company.json().id as string };
}
async function addAgent(app: ReturnType<typeof buildApp>, companyId: string, key: string, input: Record<string, unknown>) {
  const response = await app.inject({ method: "POST", url: `/companies/${companyId}/agents`, headers: { "idempotency-key": key }, payload: input });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

describe("Company delegation runtime", () => {
  it("uses A2A planning, OmniRoute Pipeline, Auto fallback, tool enforcement and idempotency", async () => {
    const combos: OmniRouteComboInput[] = [];
    const chat = vi.fn(async () => ({
      content: "Reviewed final answer",
      model: "openai/gpt-4o",
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150, cachedTokens: 80 },
      telemetry: { requestId: "req-company-telemetry", provider: "openai", routingStrategy: "pipeline", latencyMs: 240,
        costUsd: 0.0042, costSource: "upstream" as const, cacheHit: true, cacheSavingsUsd: 0.0018, failoverCount: 1 },
    }));
    const executeTool = vi.fn(async () => ({ results: [{ title: "Verified source" }] }));
    let plan = '{"mode":"pipeline","agentIds":[],"toolRequests":[]}';
    let releasePlan!: () => void;
    const gate = new Promise<void>((resolve) => { releasePlan = resolve; });
    let planningStarted!: () => void;
    const started = new Promise<void>((resolve) => { planningStarted = resolve; });
    const a2aSend = vi.fn(async () => { planningStarted(); await gate; return { taskId: "a2a-101", content: plan, metadata: {} }; });
    const ai = engine({ chat, executeTool, a2aSend, ensureCombo: async (input) => { combos.push(input); return { name: input.name }; } });
    const active = { value: { workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read", "business:manage"] } };
    const { app, companyId } = await setup(ai, active);
    const manager = await addAgent(app, companyId, "runtime-manager-001", { name: "Manager", role: "Coordinator" });
    const writer = await addAgent(app, companyId, "runtime-writer-001", { name: "Writer", role: "Writer", modelId: undefined, tools: ["Web Search", "Knowledge"] });
    const reviewer = await addAgent(app, companyId, "runtime-reviewer-001", { name: "Reviewer", role: "Reviewer" });
    await app.inject({ method: "PUT", url: `/companies/${companyId}/main-agent`, payload: { agentId: manager.id, expectedRevision: 1 } });
    plan = JSON.stringify({ mode: "pipeline", agentIds: [writer.id], reviewerAgentId: reviewer.id,
      toolRequests: [{ agentId: writer.id, tool: "web.search", input: { query: "NPATI evidence" } }, { agentId: writer.id, tool: "knowledge", input: { query: "NPATI policy" } }] });
    const request = { method: "POST" as const, url: `/companies/${companyId}/runs`,
      headers: { "idempotency-key": "runtime-run-001" }, payload: { task: "Research and write an article", mode: "auto" } };
    const first = app.inject(request);
    await started;
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => app.inject(request)));
    releasePlan();
    const completed = await first;
    const runId = completed.json().run.id as string;
    expect(new Set([completed, ...duplicates].map((response) => response.json().run.id))).toEqual(new Set([runId]));
    expect(a2aSend).toHaveBeenCalledTimes(1);
    const planningPrompt = JSON.stringify(a2aSend.mock.calls);
    expect(planningPrompt).toContain("non-empty specific search query");
    expect(planningPrompt).toContain("Populate required input fields");
    expect(executeTool).toHaveBeenCalledWith("web.search", { query: "NPATI evidence" });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(combos.some((combo) => combo.strategy === "pipeline")).toBe(true);
    expect(combos.filter((combo) => combo.strategy === "priority").every((combo) => combo.models.includes("auto/smart"))).toBe(true);
    expect(combos.filter((combo) => combo.strategy === "priority").every((combo) =>
      combo.config?.maxRetries === 2 && combo.config?.failoverBeforeRetry === true)).toBe(true);
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ model: expect.stringMatching(/^npati\/p\//) }));
    expect(completed.headers["x-npati-cost-usd"]).toBe("0.0042");
    expect(completed.headers["x-npati-tokens-total"]).toBe("150");
    expect(completed.headers["x-npati-routing-strategy"]).toBe("pipeline");
    expect(completed.headers["x-npati-cache-hit"]).toBe("true");
    expect(completed.headers["x-npati-cache-savings-usd"]).toBe("0.0018");
    const details = await app.inject({ method: "GET", url: `/companies/${companyId}/runs/${runId}` });
    expect(details.json().run).toMatchObject({ status: "completed", executionMode: "pipeline", result: "Reviewed final answer", totalCost: 0.0042, totalTokens: 150 });
    expect(details.json().steps).toHaveLength(3);
    expect(details.json().toolAudit.filter((entry: { toolName: string }) => entry.toolName !== "ai.inference").map((entry: { status: string }) => entry.status)).toEqual(["requested", "succeeded", "requested", "succeeded"]);
    expect(details.json().toolAudit).toEqual(expect.arrayContaining([expect.objectContaining({
      toolName: "ai.inference", latencyMs: 240, cost: 0.0042, tokens: 150, reasonCode: "routing_decision",
      inputSummary: expect.objectContaining({ providerId: "openai", modelId: "openai/gpt-4o", cacheHit: true, failoverCount: 1 }),
    })]));
    active.value = { workspaceId: "workspace-b", userId: "user-b", permissions: ["workspace:read", "business:manage"] };
    expect((await app.inject({ method: "GET", url: `/companies/${companyId}/runs/${runId}` })).statusCode).toBe(403);
  });

  it("uses OmniRoute Fusion for parallel workers and blocks forbidden tools in backend audit", async () => {
    const combos: OmniRouteComboInput[] = [];
    let plan = "";
    const ai = engine({
      a2aSend: async () => ({ taskId: "a2a-fusion", content: plan, metadata: {} }),
      ensureCombo: async (input) => { combos.push(input); return { name: input.name }; },
    });
    const active = { value: { workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read", "business:manage"] } };
    const { app, companyId } = await setup(ai, active);
    const manager = await addAgent(app, companyId, "fusion-manager-001", { name: "Manager", role: "Coordinator" });
    const research = await addAgent(app, companyId, "fusion-research-001", { name: "Research", role: "Research", tools: ["Web Search"] });
    const seo = await addAgent(app, companyId, "fusion-seo-0000001", { name: "SEO", role: "SEO" });
    await app.inject({ method: "PUT", url: `/companies/${companyId}/main-agent`, payload: { agentId: manager.id, expectedRevision: 1 } });
    plan = JSON.stringify({ mode: "fusion", agentIds: [research.id, seo.id], toolRequests: [] });
    const fusion = await app.inject({ method: "POST", url: `/companies/${companyId}/runs`,
      headers: { "idempotency-key": "fusion-run-0001" }, payload: { task: "Compare two approaches", mode: "fusion" } });
    expect(fusion.json().run).toMatchObject({ status: "completed", executionMode: "fusion" });
    expect(combos.some((combo) => combo.strategy === "fusion" && combo.models.length === 2)).toBe(true);
    plan = JSON.stringify({ mode: "single", agentIds: [seo.id],
      toolRequests: [{ agentId: seo.id, tool: "knowledge", input: { query: "private company facts" } }] });
    const denied = await app.inject({ method: "POST", url: `/companies/${companyId}/runs`,
      headers: { "idempotency-key": "denied-run-0001" }, payload: { task: "Complete the assigned internal task" } });
    expect(denied.statusCode).toBe(403);
    const audit = await app.inject({ method: "GET", url: `/companies/${companyId}/runs/${denied.json().run.id}` });
    expect(audit.json().run).toMatchObject({ status: "failed", errorCode: "TOOL_FORBIDDEN" });
    expect(audit.json().toolAudit).toEqual([expect.objectContaining({ agentId: seo.id, toolName: "knowledge", decision: "denied", status: "blocked" })]);
  });

  it("cancels a queued run immediately instead of leaving it stuck in cancelling", async () => {
    const store=new InMemoryWorkspaceStore(),ctx={workspaceId:"workspace-a",userId:"user-a",permissions:["workspace:read","business:manage"]};await store.initialize();
    const company=await store.createCompany(ctx,{name:"Queued Cancel Co"},"queued-cancel-company");const manager=await store.createCompanyAgent(ctx,company.id,{name:"Manager",role:"Manager"},"queued-cancel-agent");await store.setCompanyMainAgent(ctx,company.id,manager.id,company.revision);
    const runtime=new CompanyDelegationRuntime(store,engine());const created=await runtime.create(ctx,company.id,{task:"Do not execute",mode:"single"},"queued-cancel-run");
    const cancelled=await runtime.cancel(ctx,company.id,created.run.id);expect(cancelled.run).toMatchObject({status:"cancelled",cancelRequested:true,errorCode:"RUN_CANCELLED"});
  });

  it("propagates an external chat disconnect into an active Company provider call",async()=>{
    const store=new InMemoryWorkspaceStore(),ctx={workspaceId:"workspace-a",userId:"user-a",permissions:["workspace:read","business:manage"]};await store.initialize();
    const company=await store.createCompany(ctx,{name:"Disconnect Co"},"disconnect-company");
    const manager=await store.createCompanyAgent(ctx,company.id,{name:"Manager",role:"Manager"},"disconnect-manager");
    await store.setCompanyMainAgent(ctx,company.id,manager.id,company.revision);
    let providerStarted!:()=>void;const started=new Promise<void>(resolve=>{providerStarted=resolve;});
    const ai=engine({chat:async request=>new Promise((_resolve,reject)=>{providerStarted();request.signal?.addEventListener("abort",()=>reject(request.signal?.reason??new DOMException("Cancelled","AbortError")),{once:true});})});
    const runtime=new CompanyDelegationRuntime(store,ai);const controller=new AbortController();
    const pending=runtime.execute(ctx,company.id,{task:"Write a long answer",mode:"single"},"disconnect-run",controller.signal);
    await started;controller.abort(new DOMException("Client disconnected","AbortError"));

    const result=await pending;

    expect(result.run).toMatchObject({status:"cancelled",errorCode:"RUN_CANCELLED"});
    expect(result.run.result).toBeUndefined();
  });

  it("routes allowlisted Company Memory through the production audit path",async()=>{
    const store=new InMemoryWorkspaceStore(),ctx={workspaceId:"workspace-a",userId:"user-a",permissions:["workspace:read","business:manage"]};await store.initialize();
    const company=await store.createCompany(ctx,{name:"Memory Tool Co"},"memory-tool-company");
    const manager=await store.createCompanyAgent(ctx,company.id,{name:"Manager",role:"Manager",tools:["Company Memory"]},"memory-tool-manager");
    await store.setCompanyMainAgent(ctx,company.id,manager.id,company.revision);
    const execute=vi.fn(async()=>[{id:"memory-1",content:"Refunds take 14 days"}]);
    const ai=engine({a2aSend:async()=>({taskId:"memory-plan",content:JSON.stringify({mode:"single",agentIds:[],toolRequests:[{agentId:manager.id,tool:"storage.company_memory",input:{operation:"search",query:"refunds"}}]}),metadata:{}})});
    const runtime=new CompanyDelegationRuntime(store,ai,5_000,{execute});
    const result=await runtime.execute(ctx,company.id,{task:"Find the refund memory",mode:"single"},"memory-tool-run");
    expect(result.run.status).toBe("completed");
    expect(execute).toHaveBeenCalledWith(ctx,expect.objectContaining({id:company.id}),"storage.company_memory",{operation:"search",query:"refunds"},expect.any(AbortSignal));
    expect(result.toolAudit.filter((entry)=>entry.toolName!=="ai.inference")).toEqual([
      expect.objectContaining({toolName:"storage.company_memory",decision:"allowed",status:"requested"}),
      expect.objectContaining({toolName:"storage.company_memory",decision:"allowed",status:"succeeded"}),
    ]);
  });

  it("retrieves Company Knowledge for the allowlisted Main Agent without granting it to a specialist", async () => {
    const store=new InMemoryWorkspaceStore(),ctx={workspaceId:"workspace-a",userId:"user-a",permissions:["workspace:read","business:manage"]};await store.initialize();
    const company=await store.createCompany(ctx,{name:"Knowledge Policy Co"},"knowledge-policy-company");
    const manager=await store.createCompanyAgent(ctx,company.id,{name:"Manager",role:"Manager",tools:["Knowledge"]},"knowledge-policy-manager");
    const external=await store.createCompanyAgent(ctx,company.id,{name:"External",role:"External",tools:[]},"knowledge-policy-external");
    await store.setCompanyMainAgent(ctx,company.id,manager.id,company.revision);
    const retrieve=vi.fn(async()=>({chunks:[{content:"private"}],memories:[]}));
    const runtime=new CompanyDelegationRuntime(store,engine({a2aSend:async()=>({taskId:"policy-plan",content:JSON.stringify({mode:"single",agentIds:[external.id],toolRequests:[]}),metadata:{}})}),5_000,undefined,retrieve);
    const result=await runtime.execute(ctx,company.id,{task:"Use private knowledge",mode:"single"},"knowledge-policy-run");
    expect(result.run.status).toBe("completed");
    expect(retrieve).toHaveBeenCalledWith(ctx,company.id,"Use private knowledge",undefined);
  });

  it("returns an actionable error when a document query is attempted without Main Agent Knowledge permission", async () => {
    const store=new InMemoryWorkspaceStore(),ctx={workspaceId:"workspace-a",userId:"user-a",permissions:["workspace:read","business:manage"]};await store.initialize();
    const company=await store.createCompany(ctx,{name:"Knowledge Disabled Co"},"knowledge-disabled-company");
    const manager=await store.createCompanyAgent(ctx,company.id,{name:"Manager",role:"Manager",tools:["Web Search"]},"knowledge-disabled-manager");
    await store.setCompanyMainAgent(ctx,company.id,manager.id,company.revision);
    const retrieve=vi.fn(async()=>({chunks:[{content:"private"}],memories:[]}));
    const runtime=new CompanyDelegationRuntime(store,engine(),5_000,undefined,retrieve);
    const result=await runtime.execute(ctx,company.id,{task:"Find this value in the Excel file",mode:"single"},"knowledge-disabled-run");
    expect(result.run).toMatchObject({status:"failed",errorCode:"KNOWLEDGE_PERMISSION_REQUIRED"});
    expect(result.run.errorMessage).toContain("enable Knowledge");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("cancels an active A2A planning request and does not execute a duplicate run", async () => {
    let started!: () => void;
    const planning = new Promise<void>((resolve) => { started = resolve; });
    const a2aSend = vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      started();
      signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    }));
    const chat = vi.fn(async () => ({ content: "should not run" }));
    const ai = engine({ a2aSend: a2aSend as AIEngine["a2aSend"], chat });
    const active = { value: { workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read", "business:manage"] } };
    const { app, companyId } = await setup(ai, active);
    const manager = await addAgent(app, companyId, "cancel-manager-001", { name: "Manager", role: "Coordinator" });
    await app.inject({ method: "PUT", url: `/companies/${companyId}/main-agent`, payload: { agentId: manager.id, expectedRevision: 1 } });
    const request = { method: "POST" as const, url: `/companies/${companyId}/runs`,
      headers: { "idempotency-key": "cancel-run-0001" }, payload: { task: "Long planning task" } };
    const running = app.inject(request);
    await planning;
    const duplicate = await app.inject(request);
    const runId = duplicate.json().run.id as string;
    expect(duplicate.json().run.status).toBe("planning");
    await app.inject({ method: "POST", url: `/companies/${companyId}/runs/${runId}/cancel` });
    const cancelled = await running;
    expect(cancelled.json().run).toMatchObject({ id: runId, status: "cancelled", errorCode: "RUN_CANCELLED" });
    expect(a2aSend).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });
  it("persists provider failures and enforces the overall run timeout", async () => {
    const active = { value: { workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read", "business:manage"] } };
    const failedSetup = await setup(engine({ chat: async () => { throw new Error("Provider unavailable"); } }), active);
    const manager = await addAgent(failedSetup.app, failedSetup.companyId, "failed-manager-001", { name: "Manager", role: "Coordinator" });
    await failedSetup.app.inject({ method: "PUT", url: `/companies/${failedSetup.companyId}/main-agent`, payload: { agentId: manager.id, expectedRevision: 1 } });
    const failed = await failedSetup.app.inject({ method: "POST", url: `/companies/${failedSetup.companyId}/runs`,
      headers: { "idempotency-key": "provider-failure-001" }, payload: { task: "Provider failure" } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().run).toMatchObject({ status: "failed", errorCode: "RUN_FAILED", errorMessage: "Provider unavailable" });

    const timeoutA2A = ({ signal }: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true }));
    const timeoutSetup = await setup(engine({ a2aSend: timeoutA2A as AIEngine["a2aSend"] }), active, 25);
    const timeoutManager = await addAgent(timeoutSetup.app, timeoutSetup.companyId, "timeout-manager-001", { name: "Manager", role: "Coordinator" });
    await timeoutSetup.app.inject({ method: "PUT", url: `/companies/${timeoutSetup.companyId}/main-agent`, payload: { agentId: timeoutManager.id, expectedRevision: 1 } });
    const timedOut = await timeoutSetup.app.inject({ method: "POST", url: `/companies/${timeoutSetup.companyId}/runs`,
      headers: { "idempotency-key": "timeout-run-0001" }, payload: { task: "Timeout task" } });
    expect(timedOut.statusCode).toBe(504);
    expect(timedOut.json().run).toMatchObject({ status: "failed", errorCode: "RUN_TIMEOUT" });
  });

});
