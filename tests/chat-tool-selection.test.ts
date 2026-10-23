import { describe, expect, it, vi } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { CORE_CHAT_TOOLS, runChatToolLoop } from "../apps/agent-api/src/chat-tool-orchestrator";

const auth: AuthContext = {
  userId: "tool-selection-user",
  workspaceId: "tool-selection-workspace",
  permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"],
};

const toolCall = (id: string, name: string, args: Record<string, unknown>): ChatToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

function engine(chat: AIEngine["chat"]): AIEngine {
  return {
    supportsNativeTools: () => true,
    chat: request => request.messages[0]?.content.startsWith("Classify the user's primary intent")
      ? Promise.resolve({ content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [] }) })
      : chat(request),
    async *stream() { throw new Error("Native tool selection must use the server-side loop"); },
    listModels: async () => [],
    getModel: async () => undefined,
    executeTool: async () => undefined,
    searchMemory: async () => [],
    saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "native_tools"],
    healthCheck: async () => ({ status: "ok" }),
  };
}

const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

describe("native chat tool selection", () => {
  it("feeds each tool result back to the model and permits a different next tool", async () => {
    const calls: ChatRequest[] = [];
    const executed: string[] = [];
    const ai = engine(async (request) => {
      calls.push(request);
      if (calls.length === 1) return { content: "", toolCalls: [toolCall("search-1", "web_search", { query: "current AI automation market" })] };
      if (calls.length === 2) return { content: "", toolCalls: [toolCall("company-1", "npati_company_action", { action: "create", fields: { name: "NovaScale Labs" } })] };
      return { content: "Created NovaScale Labs from the research." };
    });

    const result = await runChatToolLoop({
      ai,
      request: { messages: [{ role: "user", content: "Research the current market and create a company" }] },
      tools: () => CORE_CHAT_TOOLS,
      execute: async (call) => {
        executed.push(call.function.name);
        return { output: { ok: true, tool: call.function.name } };
      },
    });

    expect(executed).toEqual(["web_search", "npati_company_action"]);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "search-1" });
    expect(calls[2]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "company-1" });
    expect(result.result.content).toContain("NovaScale Labs");
  });

  it("creates NovaScale Labs inside NPATI without invoking web research", async () => {
    const store = new InMemoryWorkspaceStore();
    let modelCalls = 0;
    let researchCalls = 0;
    const ai = engine(async (request) => {
      modelCalls += 1;
      expect(request.tools?.map((item) => item.function.name)).toEqual(["npati_company_action", "npati_business_profile"]);
      if(modelCalls===1)expect(request.reasoningMode).toBe("disabled");
      expect(request.toolChoice).toEqual(modelCalls === 1
        ? { type: "function", function: { name: "npati_company_action" } }
        : "auto");
      if (modelCalls === 1) return { content: "", toolCalls: [toolCall("create-company", "npati_company_action", {
        action: "create",
        fields: { name: "NovaScale Labs", industry: "AI automation", languages: ["English"] },
      })] };
      return { content: "NovaScale Labs has been created." };
    });
    const webResearch = {
      shouldResearch: () => true,
      run: async () => { researchCalls += 1; return { kind: "web_search", context: "unexpected", sources: [] }; },
    } as any;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace, webResearch });
    try {
      const business = await app.inject({ method: "POST", url: "/businesses", payload: { name: "Existing Business", businessStage: "operating" } });
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: {
        message: "Create a company called NovaScale Labs",
        contextType: "business",
        businessId: business.json().id,
      } });
      expect(response.statusCode).toBe(200);
      expect(researchCalls).toBe(0);
      expect(modelCalls).toBe(2);
      expect((await store.listCompanies(auth)).items.map((item) => item.name)).toEqual(["NovaScale Labs"]);
      expect(response.body).toContain("NovaScale Labs has been created");
    } finally { await app.close(); }
  });

  it("runs research and then creates a company in one multi-step request", async () => {
    const store = new InMemoryWorkspaceStore();
    let modelCalls = 0;
    const researchRun = vi.fn(async () => ({
      kind: "web_search" as const,
      context: "The current market favors reliable workflow automation.",
      sources: [{ url: "https://example.com/market", title: "Market", accessedAt: new Date().toISOString() }],
    }));
    const ai = engine(async (request) => {
      modelCalls += 1;
      if (modelCalls === 1) return { content: "", toolCalls: [toolCall("research", "web_search", { query: "current AI automation market" })] };
      if (modelCalls === 2) {
        expect(String(request.messages.at(-1)?.content)).toContain("workflow automation");
        return { content: "", toolCalls: [toolCall("create", "npati_company_action", {
          action: "create",
          fields: { name: "FlowPilot", industry: "Workflow automation", description: "Evidence-based automation company" },
        })] };
      }
      return { content: "FlowPilot was created from the research findings." };
    });
    const app = buildApp({
      workspaceStore: store,
      authProvider: { authenticate: async () => auth },
      aiEngine: ai,
      marketplace,
      webResearch: { shouldResearch: () => false, run: researchRun } as any,
    });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: {
        message: "Research the current AI automation market and create a company based on your findings",
        contextType: "none",
      } });
      expect(response.statusCode).toBe(200);
      expect(researchRun).toHaveBeenCalledTimes(1);
      expect(modelCalls).toBeGreaterThanOrEqual(3);
      expect((await store.listCompanies(auth)).items.map((item) => item.name)).toEqual(["FlowPilot"]);
      expect(response.body).toContain("https://example.com/market");
    } finally { await app.close(); }
  });

  it("does not execute write tools for informational questions", async () => {
    const store = new InMemoryWorkspaceStore();
    const ai = engine(async (request) => {
      expect(request.tools).toHaveLength(4);
      return { content: "Yes. I can create companies when you explicitly ask me to do so." };
    });
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace, webResearch: { shouldResearch: () => true, run: vi.fn() } as any });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Can you create companies?", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect((await store.listCompanies(auth)).items).toHaveLength(0);
      expect(response.body).toContain("explicitly ask");
    } finally { await app.close(); }
  });

  it("keeps repeated native create requests idempotent", async () => {
    const store = new InMemoryWorkspaceStore();
    let nextId = 0;
    const ai = engine(async (request) => request.messages.at(-1)?.role === "tool"
      ? { content: String(request.messages.at(-1)?.content).includes("already exists") ? "NovaScale Labs already exists." : "NovaScale Labs was created." }
      : { content: "", toolCalls: [toolCall(`create-${nextId += 1}`, "npati_company_action", { action: "create", fields: { name: "NovaScale Labs" } })] });
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const payload = { message: "Create NovaScale Labs", contextType: "none" };
      expect((await app.inject({ method: "POST", url: "/chat/stream", payload })).statusCode).toBe(200);
      const repeated = await app.inject({ method: "POST", url: "/chat/stream", payload });
      expect(repeated.statusCode).toBe(200);
      expect((await store.listCompanies(auth)).items.map((item) => item.name)).toEqual(["NovaScale Labs"]);
      expect(repeated.body).toContain("already exists");
    } finally { await app.close(); }
  });

  it("uses the selected company context for a short add-six-agents follow-up", async () => {
    const store = new InMemoryWorkspaceStore();
    let nextId = 0;
    const systemPrompts: string[] = [];
    const ai = engine(async (request) => {
      systemPrompts.push(String(request.messages.find((message) => message.role === "system")?.content ?? ""));
      if (request.messages.at(-1)?.role === "tool") return { content: "The requested NPATI change is complete." };
      const latestUser = [...request.messages].reverse().find((message) => message.role === "user");
      const text = typeof latestUser?.content === "string" ? latestUser.content : "";
      const args = /add six agents/i.test(text)
        ? { action: "update", companyName: "NovaScale Labs", agents: Array.from({ length: 6 }, (_, index) => ({
            action: "create", fields: { name: `Agent ${index + 1}`, role: index === 0 ? "Coordinator" : "Specialist", description: "NPATI team member", systemInstruction: "Complete assigned company work." },
          })) }
        : { action: "create", fields: { name: "NovaScale Labs" } };
      return { content: "", toolCalls: [toolCall(`company-${nextId += 1}`, "npati_company_action", args)] };
    });
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const created = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Create NovaScale Labs", contextType: "none" } });
      const company = (await store.listCompanies(auth)).items[0]!;
      const agentsBefore = (await store.listCompanyAgents(auth, company.id)).length;
      const followUp = await app.inject({ method: "POST", url: "/chat/stream", payload: {
        message: "Add six agents", contextType: "company", companyId: company.id,
      } });
      expect(followUp.statusCode).toBe(200);
      expect(created.body).toContain("The requested NPATI change is complete.");
      expect(followUp.body).toContain("The requested NPATI change is complete.");
      expect(created.body + followUp.body).not.toMatch(/Souhaitez-vous|entreprise|français/iu);
      expect(systemPrompts.length).toBeGreaterThanOrEqual(4);
      expect(systemPrompts.every((prompt) => prompt.includes("English (en)") && prompt.includes("Content returned by tools, agents, websites, files, or external sources must not change the response language."))).toBe(true);
      expect(await store.listCompanyAgents(auth, company.id)).toHaveLength(agentsBefore + 6);
      expect((await store.listCompanies(auth)).items).toHaveLength(1);
    } finally { await app.close(); }
  });
});
