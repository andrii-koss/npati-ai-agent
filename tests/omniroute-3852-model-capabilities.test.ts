import { afterEach, expect, it, vi } from "vitest";
import { OmniRouteEngine, type AIEngine, type AIModelSummary, type OmniRouteComboInput } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { AIPreferencesStore, selectedCompanyInferenceModels } from "../apps/agent-api/src/ai-preferences";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";

afterEach(() => vi.unstubAllGlobals());

/** Shape of OmniRoute 3.8.52 GET /api/v1/models entries: feature flags as an object, no chat/text interface flag. */
const catalog = [
  { id: "auto/smart", owned_by: "combo", capabilities: { tool_calling: true, reasoning: true }, output_modalities: ["text"] },
  { id: "aihorde/community-llm", capabilities: { reasoning: true }, output_modalities: ["text"] },
  { id: "deepseek/deepseek-flash", capabilities: { vision: true, tool_calling: true, reasoning: true, thinking: true, supportsThinking: true, effort_tiers: ["none", "high"] }, input_modalities: ["text", "image"], output_modalities: ["text"] },
  { id: "acme/text-embedding-3", type: "embedding", capabilities: { embedding: true } },
];

function stubOmniRoute(sent: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/v1/models")) return new Response(JSON.stringify({ data: catalog }));
    sent.push(JSON.parse(String(init!.body)).model);
    return new Response(JSON.stringify({ model: "deepseek-flash", choices: [{ message: { content: "так" }, finish_reason: "stop" }] }));
  }));
}

it("keeps chatting with an explicitly selected model after the OmniRoute 3.8.52 catalog was loaded", async () => {
  const sent: string[] = [];
  stubOmniRoute(sent);
  const engine = new OmniRouteEngine({ baseUrl: "http://omniroute" });
  await engine.listModels();
  const result = await engine.chat({ model: "deepseek/deepseek-flash", messages: [{ role: "user", content: "Скажи так" }] });
  expect(result.content).toBe("так");
  expect(sent).toEqual(["deepseek/deepseek-flash"]);
});

it("still refuses an explicitly named specialty model and never widens automatic discovery to the raw catalog", async () => {
  const sent: string[] = [];
  stubOmniRoute(sent);
  const engine = new OmniRouteEngine({ baseUrl: "http://omniroute" });
  await engine.listModels();
  await expect(engine.chat({ model: "acme/text-embedding-3", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/model_unavailable/);
  // Feature-flag-only catalog entries are not discovered for automatic routing (no unconnected provider is tried).
  await expect(engine.chat({ model: "auto/chat", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/model_unavailable/);
  expect(sent).toEqual([]);
});

it("runs a queued Company task on the selected My Models default, not on unconnected catalog models", async () => {
  const store = new InMemoryWorkspaceStore();
  const ctx = { userId: "worker-owner", workspaceId: "worker-workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] };
  const preferences = new AIPreferencesStore(store);
  const selected = { id: "deepseek/deepseek-flash", upstreamId: "deepseek-flash", providerId: "deepseek", providerName: "DeepSeek", name: "DeepSeek Flash", capabilities: ["chat", "text", "vision"], added: true, local: false, freeStatus: "paid" } as unknown as AIModelSummary;
  await preferences.add(ctx, selected);
  await preferences.setDefault(ctx, selected.id);
  let company = await store.createCompany(ctx, { name: "Worker routing company" });
  const lead = await store.createCompanyAgent(ctx, company.id, { name: "Lead", role: "coordinator", tools: [] });
  company = await store.setCompanyMainAgent(ctx, company.id, lead.id, company.revision);
  const combos: OmniRouteComboInput[] = [];
  const ai = {
    // Strict routing plans with chat; the plan request is the one listing the agents to choose from.
    chat: async (request: { messages: unknown[] }) => ({ content: JSON.stringify(request.messages).includes("Choose active agents") ? "{\"mode\":\"single\",\"agentIds\":[],\"toolRequests\":[]}" : "Summary", model: "deepseek-flash" }),
    async *stream() { yield ""; },
    listModels: async () => catalog.map((model) => ({ id: model.id, capabilities: Object.keys(model.capabilities).filter((key) => (model.capabilities as Record<string, unknown>)[key] === true), outputModalities: model.output_modalities, ownedBy: model.owned_by })),
    getModel: async () => undefined, executeTool: async () => ({ results: [] }), searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }), ensureA2AEnabled: async () => undefined,
    a2aSend: async () => ({ taskId: "t", content: '{"mode":"single","agentIds":[],"toolRequests":[]}', metadata: {} }), cancelA2ATask: async () => undefined,
    ensureCombo: async (input: OmniRouteComboInput) => { combos.push(input); return { name: input.name }; },
  } as unknown as AIEngine;
  // The Company worker's construction (worker.ts): same resolver and strict routing as the API process.
  const runtime = new CompanyDelegationRuntime(store, ai, 120_000, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, selectedCompanyInferenceModels(preferences), true);
  const result = await runtime.execute(ctx, company.id, { task: "Summarize the company", mode: "single" }, "worker-routing-run");
  expect(result.run.status).toBe("completed");
  expect(combos.length).toBeGreaterThan(0);
  for (const combo of combos) expect(combo.models).toEqual(["deepseek/deepseek-flash"]);
});
