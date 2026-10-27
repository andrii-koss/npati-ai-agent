import { describe, expect, it, vi } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { CORE_CHAT_TOOLS, runChatToolLoop } from "../apps/agent-api/src/chat-tool-orchestrator";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { saveChatProjectCard, persistChatResultContext } from "../apps/agent-api/src/project-chat-cards";

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
  it.each(["/chat", "/chat/stream"])("persists Business Profile creation instead of delegating to the active company: %s", async url => {
    const store = new InMemoryWorkspaceStore();
    let company = await store.createCompany(auth, { name: "Bakery" });
    const lead = await store.createCompanyAgent(auth, company.id, { name: "Lead", role: "Coordinator", tools: [] });
    company = await store.setCompanyMainAgent(auth, company.id, lead.id, company.revision);
    const ai = engine(async request => request.messages.some(message => message.role === "tool")
      ? { content: "Business Profile saved." }
      : { content: "", toolCalls: [toolCall("create-business", "npati_business_profile", { action: "create", profile: { name: "Stress DS1023 Business", businessStage: "operating", market: "Kyiv", country: "Ukraine", productsServicesSummary: "sourdough bread and coffee", audienceSummary: "local families" } })] });
    const chat = ai.chat;
    ai.chat = request => String(request.messages[0]?.content).startsWith("Classify the user's primary intent")
      ? Promise.resolve({ content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [], entityRead: null, coreCapability: "npati_business_profile" }) }) : chat(request);
    const delegation = vi.spyOn(CompanyDelegationRuntime.prototype, "execute").mockRejectedValue(new Error("Business creation must use its own capability"));
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url, payload: { message: 'Create a Business Profile named "Stress DS1023 Business". Stage: operating; market: Kyiv; country: Ukraine; services: sourdough bread and coffee; audience: local families. This is a Business Profile, not a new AI company.', contextType: "company", companyId: company.id } });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("event: error");
      expect(await store.listUserBusinesses(auth)).toEqual([expect.objectContaining({ name: "Stress DS1023 Business", market: "Kyiv", businessStage: "operating" })]);
      expect(delegation).not.toHaveBeenCalled();
      expect((await store.listCompanies(auth)).items).toHaveLength(1);
    } finally { delegation.mockRestore(); await app.close(); }
  });
  it.each(["/chat", "/chat/stream"])("keeps a recalled fact plus an answer-format clause out of the write planner: %s", async url => {
    const store = new InMemoryWorkspaceStore();
    let company = await store.createCompany(auth, { name: "Recall Studio", companyInstructions: "STORED_DECISION_CODE" }, "recall-studio");
    const main = await store.createCompanyAgent(auth, company.id, { name: "Lead", role: "Coordinator", tools: [] }, "recall-main");
    company = await store.setCompanyMainAgent(auth, company.id, main.id, company.revision);
    const ai = engine(async () => { throw new Error("A stored fact read must not enter the write planner"); });
    const classify = vi.fn(async (request: ChatRequest) => {
      expect(request.toolChoice).toEqual({ type: "function", function: { name: "npati_classify_chat_intent" } });
      return { content: "", toolCalls: [toolCall("recall-classification", "npati_classify_chat_intent", { intent: "CHAT", confidence: 1, targets: [], entityRead: { field: "instructions", entityType: "company" } })] };
    });
    ai.chat = classify;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url, payload: { message: "Який останній факт ти запам'ятав для «Recall Studio»? Назви лише значення.", contextType: "company", companyId: company.id } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("STORED_DECISION_CODE");
      expect(response.body).not.toContain("event: error");
      expect(classify).toHaveBeenCalledOnce();
      expect((await store.getCompany(auth, company.id)).companyInstructions).toBe("STORED_DECISION_CODE");
      expect(await store.listUserBusinesses(auth)).toEqual([]);
    } finally { await app.close(); }
  });
  it.each(["/chat", "/chat/stream"].flatMap(url => ["What is its description? Keep it short.", "¿Cuál es su descripción? Sé breve.", "Qual é a descrição dela? Seja breve.", "Wie lautet ihre Beschreibung? Kurz bitte.", "Який її опис? Відповідай коротко."].map(message => ({ url, message }))))(
    "answers a typed metadata read from storage without speaking as Lead: $url $message", async ({ url, message }) => {
      const store = new InMemoryWorkspaceStore();
      let company = await store.createCompany(auth, { name: "Typed Metadata Studio", description: "AUTHORITATIVE_COMPANY_DESCRIPTION" }, "typed-metadata");
      const lead = await store.createCompanyAgent(auth, company.id, { name: "Lead", role: "Coordinator", description: "WRONG_AGENT_DESCRIPTION", tools: [] }, "typed-lead");
      company = await store.setCompanyMainAgent(auth, company.id, lead.id, company.revision);
      const { project } = await store.createProject(auth, company.id, { name: "Old site", description: "WRONG_PROJECT_DESCRIPTION", type: "code_project" }, "typed-project");
      const conversation = await store.createNeutralConversation(auth, "Long metadata chat");
      for (let i = 0; i < 40; i++) await store.appendNeutralMessage(auth, conversation.id, "assistant", "Old summary describes Lead or the site, not the Company.");
      const last = (await store.getNeutralConversation(auth, conversation.id)).messages.at(-1)!;
      await saveChatProjectCard(store, auth, conversation.id, last.id, { id: project.id, projectId: project.id, companyId: company.id, name: project.name } as never);
      await persistChatResultContext(store, auth, { conversationId: conversation.id, companyAction: { action: "update", companyId: company.id } });
      const ai = engine(async () => { throw new Error("Metadata values must not come from model generation"); });
      const classify = vi.fn(async (request: ChatRequest) => {
        expect(String(request.messages[0]?.content).startsWith("Classify")).toBe(true);
        expect(JSON.parse(request.messages[1]!.content as string).focusedEntityType).toBe("company");
        return { content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [], entityRead: { field: "description", entityType: "focused" } }) };
      });
      ai.chat = classify;
      const activity = vi.spyOn(CompanyDelegationRuntime.prototype, "execute");
      const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
      try {
        const response = await app.inject({ method: "POST", url, payload: { message, contextType: "company", companyId: company.id, conversationId: conversation.id } });
        expect(response.statusCode).toBe(200);
        const result = url === "/chat" ? response.json() : JSON.parse(response.body.split("\n\n").find(frame => frame.includes("event: result"))!.split("\n").find(line => line.startsWith("data:"))!.slice(5));
        expect(result.message).toBe("AUTHORITATIVE_COMPANY_DESCRIPTION");
        expect(result.entityRead).toMatchObject({ entityType: "company", entityId: company.id, field: "description", source: "workspace_store" });
        expect(classify).toHaveBeenCalledOnce();
        expect(activity).not.toHaveBeenCalled();
        const history = await store.getNeutralConversation(auth, conversation.id);
        expect(history.messages.slice(-2).map(item => item.content)).toEqual([message, "AUTHORITATIVE_COMPANY_DESCRIPTION"]);
      } finally { activity.mockRestore(); await app.close(); }
    });
  it.each(["/chat", "/chat/stream"].flatMap(url => [
    'Remember for company "Memory Studio": verified reference SAVED_COMPANY_FACT.',
    'Merke dir für die Firma "Memory Studio": bestätigte Referenz SAVED_COMPANY_FACT.',
    'Recuerda para la empresa "Memory Studio": referencia confirmada SAVED_COMPANY_FACT.',
    'Lembre para a empresa "Memory Studio": referência confirmada SAVED_COMPANY_FACT.',
    'Запам’ятай для компанії «Memory Studio»: підтверджене значення SAVED_COMPANY_FACT.',
  ].map(message => ({ url, message }))))("persists Company remember through its existing executor: $url $message", async ({ url, message }) => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Memory Studio", description: "UNCHANGED_COMPANY_DESCRIPTION" }, "memory-studio");
    const ai = engine(async request => {
      if (!request.messages.some(item => item.role === "tool")) {
        expect(request.toolChoice).toEqual({ type: "function", function: { name: "npati_company_action" } });
        return { content: "", toolCalls: [toolCall("remember-company-fact", "npati_company_action", { action: "update", companyId: company.id, fields: { companyInstructions: "Verified reference SAVED_COMPANY_FACT" } })] };
      }
      return { content: "Saved the verified Company reference." };
    });
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url, payload: { message, contextType: "company", companyId: company.id } });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("event: error");
      const saved = await store.getCompany(auth, company.id);
      expect(saved.companyInstructions).toBe("Verified reference SAVED_COMPANY_FACT");
      expect(saved.description).toBe("UNCHANGED_COMPANY_DESCRIPTION");
      expect(await store.listUserBusinesses(auth)).toEqual([]);
    } finally { await app.close(); }
  });
  it("keeps the original user request intact and supplies typed references through system context", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Context contract", description: "AUTHORITATIVE_DESCRIPTION" }, "context-contract");
    const message = "What is its description?";
    const ai = engine(async request => {
      expect(request.messages.at(-1)).toEqual({ role: "user", content: message });
      const system = request.messages.filter(item => item.role === "system").map(item => item.content).join("\n");
      expect(system).toContain("Confirmed conversation entity references");
      expect(system).toContain(company.id);
      expect(system).toContain("AUTHORITATIVE_DESCRIPTION");
      return { content: "AUTHORITATIVE_DESCRIPTION" };
    });
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, contextType: "company", companyId: company.id } });
      expect(response.body).toContain("AUTHORITATIVE_DESCRIPTION");
      expect(response.body).not.toContain("event: error");
    } finally { await app.close(); }
  });
  it("binds direct named-agent work to its owned Project while a later Company pronoun ignores the historical card", async () => {
    const store = new InMemoryWorkspaceStore();
    let company = await store.createCompany(auth, { name: "Source studio", description: "COMPANY_DESCRIPTION" }, "source-studio");
    const designer = await store.createCompanyAgent(auth, company.id, { name: "Designer", role: "Designer", isActive: true }, "source-designer");
    await store.createCompanyAgent(auth, company.id, { name: "Reviewer", role: "Reviewer", isActive: true }, "source-reviewer");
    company = await store.setCompanyMainAgent(auth, company.id, designer.id, company.revision);
    const { project } = await store.createProject(auth, company.id, { name: "Review site", type: "code_project", description: "PROJECT_DESCRIPTION" }, "source-site");
    const execute = vi.spyOn(CompanyDelegationRuntime.prototype, "execute").mockImplementation(async (ctx, id, input, key) => {
      const created = await store.createCompanyAgentRun(ctx, id, { task: input.task, projectId: input.projectId, requestedMode: "single" }, key);
      await store.updateCompanyAgentRun(ctx, id, created.run.id, { status: "completed", result: input.projectId ? "Verified source review." : "COMPANY_DESCRIPTION", selectedAgentIds: [designer.id] });
      return store.getCompanyAgentRun(ctx, id, created.run.id);
    });
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: engine(async () => ({ content: "[]" })), marketplace });
    let projectRead: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const delegated = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: 'For company "Source studio", ask Designer and Reviewer to collaborate on a source review. Delegate using the existing company runtime. No external writes.', contextType: "project", companyId: company.id, projectId: project.id } });
      expect(delegated.statusCode).toBe(200);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]![2].projectId).toBe(project.id);
      const frame = delegated.body.split("\n\n").find(value => value.includes("event: result"))!;
      const result = JSON.parse(frame.split("\n").find(value => value.startsWith("data:"))!.slice(5));
      expect((await store.getCompanyAgentRun(auth, company.id, result.companyRunId)).run.projectId).toBe(project.id);
      const history = await store.getNeutralConversation(auth, result.conversationId);
      const assistant = history.messages.find(message => message.role === "assistant")!;
      await saveChatProjectCard(store, auth, result.conversationId, assistant.id, { id: project.id, projectId: project.id, companyId: company.id, name: project.name } as never);
      projectRead = vi.spyOn(ProjectService.prototype, "get");
      const described = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "What is its description?", contextType: "company", companyId: company.id, conversationId: result.conversationId } });
      expect(described.body).toContain("COMPANY_DESCRIPTION");
      expect(execute.mock.calls[1]![2].projectId).toBeUndefined();
      expect(projectRead).not.toHaveBeenCalled();
    } finally { projectRead?.mockRestore(); execute.mockRestore(); await app.close(); }
  });
  it("deletes the named Company Agent while a site is selected and preserves its peers", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Review studio" }, "review-studio");
    const designer = await store.createCompanyAgent(auth, company.id, { name: "Designer", role: "Designer" }, "designer");
    const reviewer = await store.createCompanyAgent(auth, company.id, { name: "Reviewer", role: "Reviewer" }, "reviewer");
    const target = await store.createCompanyAgent(auth, company.id, { name: "Accessibility Reviewer", role: "QA" }, "accessibility-reviewer");
    await store.createProject(auth, company.id, { name: "Review site", type: "code_project" }, "review-site");
    const project = (await store.listProjects(auth, company.id))[0]!;
    let calls = 0;
    const ai = engine(async request => {
      calls++;
      if (calls === 1) {
        expect(request.toolChoice).toEqual({ type: "function", function: { name: "npati_company_action" } });
        expect(request.tools?.map(tool => tool.function.name)).not.toContain("web_search");
        return { content: "", toolCalls: [toolCall("delete-agent", "npati_company_action", { action: "update", companyId: company.id, agents: [{ action: "delete", agentId: target.id }] })] };
      }
      return { content: "Deleted only Accessibility Reviewer." };
    });
    const research = { shouldResearch: () => true, run: vi.fn() };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace, webResearch: research as any });
    try {
      const result = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: 'In company "Review studio", delete only the agent Accessibility Reviewer. Keep Designer and Reviewer.', contextType: "project", companyId: company.id, projectId: project.id } });
      expect(result.statusCode).toBe(200);
      expect(result.body).not.toContain('"routed":"code_runner"');
      expect((await store.listCompanyAgents(auth, company.id)).map(agent => agent.id).sort()).toEqual([designer.id, reviewer.id].sort());
      expect(research.run).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("deletes only the exact named reply template through the native email executor", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Inbox team" }, "inbox-team");
    let calls = 0;
    const ai = engine(async request => {
      calls++;
      if (calls === 1) {
        expect(request.toolChoice).toEqual({ type: "function", function: { name: "npati_email_action" } });
        expect(request.tools?.map(tool => tool.function.name)).not.toContain("web_search");
        return { content: "", toolCalls: [toolCall("delete-template", "npati_email_action", { action: "template.delete", companyId: company.id, templateTitle: "Test Reply" })] };
      }
      return { content: "Deleted the requested reply template." };
    });
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const path = `/companies/${company.id}/email-inbox/templates`;
      for (const title of ["Test Reply", "Keep Reply"]) {
        const created = await app.inject({ method: "POST", url: path, payload: { title, bodyTemplate: "Controlled response" } });
        expect(created.statusCode).toBe(201);
      }
      const result = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: 'Delete only the test reply template "Test Reply" from "Inbox team" through normal controls.', contextType: "company", companyId: company.id } });
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('"action":"template.delete"');
      const saved = await app.inject({ method: "GET", url: path });
      expect(saved.json().templates.map((template: { title: string }) => template.title)).toEqual(["Keep Reply"]);
      expect(calls).toBe(2);
    } finally { await app.close(); }
  });
  it("persists a native workspace operation once and returns its server receipt", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Operations team" }, "operations-team");
    let calls = 0;
    const ai = engine(async request => {
      calls++;
      if (calls === 1) {
        expect(request.toolChoice).toBe("auto");
        expect(request.tools?.map(tool => tool.function.name)).not.toContain("web_search");
        return { content: "", toolCalls: [toolCall("schedule", "npati_workspace_action", { action: "automation.create", companyId: company.id,
          automation: { name: "Morning check", prompt: "Prepare a brief", cronExpression: "0 9 * * 1", timezone: "UTC", status: "paused" } })] };
      }
      expect(request.messages.some(message => message.role === "tool" && message.content.includes("automation.create"))).toBe(true);
      return { content: "Created the paused automation." };
    });
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Create a paused automation called Morning check for Operations team every Monday at 09:00 UTC.", contextType: "company", companyId: company.id } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"action":"automation.create"');
      const saved = await app.inject({ method: "GET", url: `/companies/${company.id}/automations` });
      expect(saved.json().automations).toEqual([expect.objectContaining({ name: "Morning check", status: "paused" })]);
      expect(calls).toBe(2);
    } finally { await app.close(); }
  });
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
      expect(request.tools?.map((item) => item.function.name)).toEqual(["npati_company_action", "npati_business_profile", "npati_goal_action"]);
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
      expect(request.tools).toHaveLength(5);
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
