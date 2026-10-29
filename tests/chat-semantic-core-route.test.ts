import { expect, it, vi } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import { decideCoreChatRouting } from "../apps/agent-api/src/chat-core-routing";
import { CORE_CHAT_TOOLS } from "../apps/agent-api/src/chat-tool-orchestrator";

const auth: AuthContext = { userId: "core-route-user", workspaceId: "core-route-workspace", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const toolCall = (id: string, name: string, args: Record<string, unknown>): ChatToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

it.each(["/chat", "/chat/stream"])("a conflicting secondary plan cannot create another Business during Content work: %s", async url => {
  const store = new InMemoryWorkspaceStore();
  await store.createBusiness(auth, { name: "Routing Bakery", market: "Kyiv" }, "original-business");
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: "npati_workspace_action", coreMutation: true }, async request => {
    if (String(request.messages[0]?.content).startsWith("Analyze the complete user request")) return { content: JSON.stringify({ primary_action: "create_business_profile", entity: "Routing Bakery", provided_fields: { name: "Routing Bakery" }, secondary_actions: [], dependencies: [], completion_criteria: [] }) };
    if (request.messages.some(message => message.role === "tool")) return { content: "No Business Profile was created." };
    return { content: "", toolCalls: [toolCall("unrequested-business", "npati_business_profile", { action: "create", profile: { name: "Routing Bakery" } })] };
  }, requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    await app.inject({ method: "POST", url, payload: { message: 'Save Content for existing Business "Routing Bakery". Never create another Business Profile.\n' + 'Preserve its existing fields and save only the strategy content.\n'.repeat(20), contextType: "none" } });
    expect((await store.listUserBusinesses(auth)).map(b => b.name)).toEqual(["Routing Bakery"]);
    const tools = requests.find(request => request.tools?.some(tool => tool.function.name === "npati_workspace_action"));
    expect(tools?.toolChoice).toEqual({ type: "function", function: { name: "npati_workspace_action" } });
    expect(tools?.tools?.map(tool => tool.function.name)).not.toContain("npati_business_profile");
  } finally { await app.close(); }
});

it.each(["/chat", "/chat/stream"])("an unplanned model 'create' of an owned Business name updates it instead of duplicating it: %s", async url => {
  const store = new InMemoryWorkspaceStore();
  await store.createBusiness(auth, { name: "Routing Bakery", market: "Kyiv" }, "original-business");
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: "npati_business_profile", coreMutation: true }, async request => {
    if (String(request.messages[0]?.content).startsWith("Analyze the complete user request")) return { content: "" };
    if (request.messages.some(message => message.role === "tool")) return { content: "Updated." };
    return { content: "", toolCalls: [toolCall("recreate", "npati_business_profile", { action: "create", profile: { name: "Routing Bakery", market: "Lviv" } })] };
  }, requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    await app.inject({ method: "POST", url, payload: { message: 'Set the market of Business "Routing Bakery" to Lviv.', contextType: "none" } });
    const businesses = await store.listUserBusinesses(auth);
    expect(businesses.map(b => [b.name, b.market])).toEqual([["Routing Bakery", "Lviv"]]);
  } finally { await app.close(); }
});

it("does not execute a legacy Business directive outside the semantic capability", async () => {
  const store = new InMemoryWorkspaceStore();
  await store.createBusiness(auth, { name: "Routing Bakery" }, "kept-business");
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: null, coreMutation: false }, async () => ({ content: '```business-action\n{"action":"create","name":"Unrequested Duplicate"}\n```' }), requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    await app.inject({ method: "POST", url: "/chat", payload: { message: "Summarize what we have done. Do not create anything.", contextType: "none" } });
    expect((await store.listUserBusinesses(auth)).map(b => b.name)).toEqual(["Routing Bakery"]);
  } finally { await app.close(); }
});

it.each(["/chat", "/chat/stream"])("keeps an ordinary checkpoint in Main Agent chat instead of implicitly delegating it: %s", async url => {
  const store = new InMemoryWorkspaceStore();
  const { company } = await companyWithAgents(store);
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: null, assignsWorkToCompanyAgent: false }, async () => ({ content: "CHAT_CHECKPOINT_COPPER" }), requests);
  const delegation = vi.spyOn(CompanyDelegationRuntime.prototype, "execute").mockRejectedValue(new Error("No delegation was requested"));
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const response = await app.inject({ method: "POST", url, payload: { message: "Remember only in this conversation CHAT_CHECKPOINT_COPPER. Do not persist Business Memory.", contextType: "company", companyId: company.id } });
    expect(response.body).toContain("CHAT_CHECKPOINT_COPPER");
    expect(delegation).not.toHaveBeenCalled();
  } finally { delegation.mockRestore(); await app.close(); }
});

it.each(["/chat", "/chat/stream"])("reads Company name and agents together through the scoped metadata reader: %s", async url => {
  const store = new InMemoryWorkspaceStore();
  const { company } = await companyWithAgents(store);
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: "npati_company_action", coreMutation: false, entityRead: { field: "agents", entityType: "company" } }, async () => ({ content: "Unused" }), requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const response = await app.inject({ method: "POST", url, payload: { message: 'Switch to company "Route Logistics". Tell me its exact name and agent names; do not create anything.', contextType: "company", companyId: company.id } });
    expect(response.body).toContain("Route Logistics — 2");
    // The stored Main Agent is marked, not inferred from role text.
    expect(response.body).toContain("★ Lead Dispatcher");
    expect(response.body).not.toContain("★ Аналітик Маршрутів");
    expect(response.body).toContain("Аналітик Маршрутів");
    expect(requests).toHaveLength(0);
  } finally { await app.close(); }
});

it.each(["/chat", "/chat/stream"])("keeps the model's answer to a compound question when a native workspace read runs: %s", async url => {
  const store = new InMemoryWorkspaceStore();
  const { company } = await companyWithAgents(store);
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: "npati_workspace_action", coreMutation: false, npatiQuestion: true }, async request => request.messages.some(message => message.role === "tool")
    ? { content: "Skills: SKILL_IDS_MARKER. Automations of Route Logistics: none." }
    : { content: "", toolCalls: [toolCall("list-automations", "npati_workspace_action", { action: "automation.list", companyId: company.id })] }, requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const response = await app.inject({ method: "POST", url, payload: { message: "Show the available Skill IDs and the automations of Route Logistics. Change nothing.", contextType: "company", companyId: company.id } });
    expect(response.statusCode).toBe(200);
    // The final persisted answer, not a streamed delta, must keep both parts.
    const result = url === "/chat" ? JSON.parse(response.body) : JSON.parse(/event: result\ndata: (.*)/.exec(response.body)![1]!);
    expect(result.message).toContain("SKILL_IDS_MARKER");
    expect(result.workspaceAction).toMatchObject({ action: "automation.list" });
  } finally { await app.close(); }
});

it.each(["/chat", "/chat/stream"])("does not let a write planner's refusal replace the answer to a semantic memory read: %s", async url => {
  const store = new InMemoryWorkspaceStore();
  await store.createBusiness(auth, { name: "Recall Bakery" }, "recall-business");
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: "npati_workspace_action", coreMutation: false }, async request =>
    String(request.messages[0]?.content).includes("Decide what the latest user message asks for") ? { content: "NO_ACTION" } : { content: "Der Rezeptcode lautet RECIPE_RECALL_42." }, requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const response = await app.inject({ method: "POST", url, payload: { message: 'Lies den gespeicherten Rezeptcode aus dem Business "Recall Bakery". Antworte auf Deutsch und nenne den exakten Code aus Business Memory. Nichts ändern.', contextType: "none" } });
    const result = url === "/chat" ? JSON.parse(response.body) : JSON.parse(/event: result\ndata: (.*)/.exec(response.body)![1]!);
    expect(result.message).toContain("RECIPE_RECALL_42");
    expect(requests.some(request => String(request.messages[0]?.content).includes("Decide what the latest user message asks for"))).toBe(false);
  } finally { await app.close(); }
});

it.each(["/chat", "/chat/stream"])("shows the server's deletion confirmation verbatim and runs nothing else that turn: %s", async url => {
  const store = new InMemoryWorkspaceStore();
  const { company } = await companyWithAgents(store);
  const business = await store.createBusiness(auth, { name: "Linked Bakery", market: "Kyiv" }, "linked-bakery");
  const before = await store.getUserBusiness(auth, business.id);
  const requests: ChatRequest[] = [];
  // Live shape: the classifier also names Business and Memory capabilities, and the model would go on to "update" the Business.
  const ai = engine({ intent: "CHAT", coreCapability: "npati_company_action", coreMutation: true, additionalCoreCapabilities: ["npati_business_profile", "npati_workspace_action"] }, async request =>
    String(request.messages[0]?.content).includes("Decide what the latest user message asks for") ? { content: "NO_ACTION" }
    : request.messages.some(message => message.role === "tool")
    ? { content: "", toolCalls: [toolCall("empty-business", "npati_business_profile", { action: "update", businessId: business.id, profile: {} })] }
    : { content: "", toolCalls: [toolCall("delete-company", "npati_company_action", { action: "delete", companyId: company.id })] }, requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const response = await app.inject({ method: "POST", url, payload: { message: "Видали компанію «Route Logistics» разом з її бізнес-ідеєю, цілями та пам'яттю.", contextType: "none" } });
    const result = url === "/chat" ? JSON.parse(response.body) : JSON.parse(/event: result\ndata: (.*)/.exec(response.body)![1]!);
    expect(result.message).toContain("**Так, видали компанію Route Logistics**");
    expect(await store.getCompany(auth, company.id)).toMatchObject({ name: "Route Logistics" });
    expect(await store.getUserBusiness(auth, business.id)).toEqual(before);
    expect(requests.filter(request => request.tools?.length)).toHaveLength(1);
  } finally { await app.close(); }
});

it.each(["/chat", "/chat/stream"])("keeps the model's explanation of a refused native company change instead of a planner's generic failure: %s", async url => {
  const store = new InMemoryWorkspaceStore();
  const { company, analyst } = await companyWithAgents(store);
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: "npati_company_action", coreMutation: true }, async request => request.messages.some(message => message.role === "tool")
    ? { content: "The tool teleport.magic is not supported, so the agent was not changed." }
    : { content: "", toolCalls: [toolCall("grant", "npati_company_action", { action: "update", companyId: company.id, agents: [{ action: "update", agentId: analyst.id, fields: { tools: ["teleport.magic"] } }] })] }, requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const response = await app.inject({ method: "POST", url, payload: { message: "Онови агента «Аналітик Маршрутів» у компанії «Route Logistics»: додай йому інструмент «teleport.magic».", contextType: "company", companyId: company.id } });
    const result = url === "/chat" ? JSON.parse(response.body) : JSON.parse(/event: result\ndata: (.*)/.exec(response.body)![1]!);
    expect(result.message).toContain("teleport.magic is not supported");
    expect((await store.getCompanyAgent(auth, company.id, analyst.id)).tools).toEqual([]);
    // The legacy company planner must not re-plan a capability the model already called this turn.
    expect(requests.some(request => String(request.messages[0]?.content).includes("The user's latest message is an explicit company settings request"))).toBe(false);
  } finally { await app.close(); }
});

it("deletes a named, unselected company together with its business idea after the composite confirmation", async () => {
  const store = new InMemoryWorkspaceStore();
  const business = await store.createBusiness(auth, { name: "Composite Bakery" }, "composite-bakery");
  const { company } = await companyWithAgents(store);
  await store.updateCompany(auth, company.id, { businessId: business.id }, (await store.getCompany(auth, company.id)).revision);
  const ai = engine({ intent: "CHAT", coreCapability: "npati_company_action", coreMutation: true }, async () => ({ content: "Model must not answer a composite deletion." }), []);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const ask = await app.inject({ method: "POST", url: "/chat", payload: { message: "Видали компанію «Route Logistics» разом з її бізнес-ідеєю, цілями та пам'яттю.", contextType: "none" } });
    const question = JSON.parse(ask.body).message as string;
    expect(question).toContain("Composite Bakery");
    expect(await store.listUserBusinesses(auth)).toHaveLength(1);
    const phrase = /\*\*([^*]+)\*\*\.?\s*$/u.exec(question.trim())?.[1] ?? [...question.matchAll(/\*\*([^*]+)\*\*/gu)].at(-1)?.[1];
    const done = await app.inject({ method: "POST", url: "/chat", payload: { message: phrase, contextType: "none" } });
    expect(JSON.parse(done.body).message).toContain("Composite Bakery");
    expect(await store.listUserBusinesses(auth)).toEqual([]);
    await expect(store.getCompany(auth, company.id)).rejects.toThrow();
  } finally { await app.close(); }
});

it.each(["/chat", "/chat/stream"])("deletes a Business Profile only after the user writes the server's exact confirmation: %s", async url => {
  const store = new InMemoryWorkspaceStore();
  const business = await store.createBusiness(auth, { name: "Doomed Bakery" }, "doomed-bakery");
  const kept = await store.createBusiness(auth, { name: "Kept Bakery" }, "kept-bakery");
  const ai = engine({ intent: "CHAT", coreCapability: "npati_business_profile", coreMutation: true }, async request => request.messages.some(message => message.role === "tool")
    ? { content: "Business Profile deleted." }
    : { content: "", toolCalls: [toolCall("delete", "npati_business_profile", { action: "delete", businessId: business.id, profile: {} })] }, []);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  const send = async (message: string) => {
    const response = await app.inject({ method: "POST", url, payload: { message, contextType: "none" } });
    return (url === "/chat" ? JSON.parse(response.body) : JSON.parse(/event: result\ndata: (.*)/.exec(response.body)![1]!)).message as string;
  };
  try {
    const question = await send("Видали бізнес-профіль «Doomed Bakery».");
    expect(question).toContain("**Так, видали бізнес-профіль Doomed Bakery**");
    expect((await store.listUserBusinesses(auth)).map(item => item.name).sort()).toEqual(["Doomed Bakery", "Kept Bakery"]);
    // A model claim is not a confirmation: only the user's exact phrase deletes.
    expect(await send("Так, видали бізнес-профіль Doomed Bakery")).toContain("видалено");
    expect((await store.listUserBusinesses(auth)).map(item => item.id)).toEqual([kept.id]);
  } finally { await app.close(); }
});

it("lets the classifier's research decision outrank web keywords and tool IDs written like domains", () => {
  const tools = [...CORE_CHAT_TOOLS, { type: "function" as const, function: { name: "npati_company_action", description: "", parameters: {} } }];
  const message = "Дай агенту «Дослідник» інструмент веб-пошуку web.search.";
  const route = { capability: "npati_company_action" as const, mutation: true };
  expect(decideCoreChatRouting(message, tools, false, true, { ...route, research: false }).toolChoice).toEqual({ type: "function", function: { name: "npati_company_action" } });
  // Without the classifier's answer the keyword fallback still prefers explicit web work.
  expect(decideCoreChatRouting(message, tools, false, true, route).toolChoice).toMatchObject({ function: { name: expect.stringMatching(/^web_/) } });
});

/** The classifier answers with `decision`; every other model call is recorded and answered by `chat`. */
function engine(decision: Record<string, unknown>, chat: (request: ChatRequest) => Promise<Awaited<ReturnType<AIEngine["chat"]>>>, requests: ChatRequest[]): AIEngine {
  return {
    supportsNativeTools: () => true,
    chat: request => String(request.messages[0]?.content).startsWith("Classify the user's primary intent")
      ? Promise.resolve({ content: JSON.stringify({ confidence: 1, targets: [], entityRead: null, ...decision }) })
      : (requests.push(request), chat(request)),
    async *stream() { yield "Plain answer."; },
    listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
    searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
  };
}

async function companyWithAgents(store: InMemoryWorkspaceStore) {
  let company = await store.createCompany(auth, { name: "Route Logistics" }, "route-logistics");
  const lead = await store.createCompanyAgent(auth, company.id, { name: "Lead Dispatcher", role: "Coordinator", tools: [] }, "route-lead");
  // The agent name contains words the email detector treats as an email resource ("маршрут", route).
  const analyst = await store.createCompanyAgent(auth, company.id, { name: "Аналітик Маршрутів", role: "Analyst", tools: [] }, "route-analyst");
  company = await store.setCompanyMainAgent(auth, company.id, lead.id, company.revision);
  return { company, lead, analyst };
}

it.each(["/chat", "/chat/stream"])("forces the classifier's capability, not the keyword-matched email tool, for a named agent deletion: %s", async url => {
  const store = new InMemoryWorkspaceStore();
  const { company, analyst } = await companyWithAgents(store);
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: "npati_company_action", coreMutation: true }, async request => request.messages.some(message => message.role === "tool")
    ? { content: "Agent deleted." }
    : { content: "", toolCalls: [toolCall("delete-agent", "npati_company_action", { action: "update", companyId: company.id, agents: [{ action: "delete", agentId: analyst.id }] })] }, requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const response = await app.inject({ method: "POST", url, payload: { message: "Видали агента «Аналітик Маршрутів». Компанію залиш.", contextType: "none" } });
    expect(response.statusCode).toBe(200);
    const first = requests.find(request => request.tools?.length);
    expect(first?.toolChoice).toEqual({ type: "function", function: { name: "npati_company_action" } });
    expect(first?.tools?.map(tool => tool.function.name)).not.toContain("npati_email_action");
  } finally { await app.close(); }
});

it("keeps a read-only summary on auto and runs no company, email or workspace planner", async () => {
  const store = new InMemoryWorkspaceStore();
  const { company } = await companyWithAgents(store);
  const before = await store.getCompany(auth, company.id);
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: null }, async () => ({ content: "Today we created the company and its agents." }), requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "Підсумуй одним абзацом, що ми сьогодні зробили для компанії Route Logistics.", contextType: "none" } });
    expect(response.statusCode).toBe(200);
    expect(requests.filter(request => typeof request.toolChoice === "object")).toEqual([]);
    expect((await store.getCompany(auth, company.id)).revision).toBe(before.revision);
    expect((await store.listCompanyAgents(auth, company.id)).map(agent => agent.name).sort()).toEqual(["Lead Dispatcher", "Аналітик Маршрутів"]);
  } finally { await app.close(); }
});

it("answers a record read in Company context natively instead of delegating to the Company agent", async () => {
  const store = new InMemoryWorkspaceStore();
  const { company } = await companyWithAgents(store);
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: "npati_company_action", coreMutation: false }, async () => ({ content: "Two agents: Lead Dispatcher and Аналітик Маршрутів." }), requests);
  const delegation = vi.spyOn(CompanyDelegationRuntime.prototype, "execute").mockRejectedValue(new Error("A record read must not be delegated"));
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "Скільки агентів у компанії Route Logistics?", contextType: "company", companyId: company.id } });
    expect(response.statusCode).toBe(200);
    expect(delegation).not.toHaveBeenCalled();
    // A read keeps tool choice automatic, so no write tool is forced on it.
    expect(requests.filter(request => typeof request.toolChoice === "object")).toEqual([]);
  } finally { delegation.mockRestore(); await app.close(); }
});

it("offers every capability of a multi-record request and forces only the primary one", async () => {
  const store = new InMemoryWorkspaceStore();
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: "npati_goal_action", coreMutation: true, additionalCoreCapabilities: ["npati_workspace_action"] }, async () => ({ content: "Done." }), requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    await app.inject({ method: "POST", url: "/chat", payload: { message: "Додай ціль «200 підписників» і запам'ятай, що відкриття 1 грудня.", contextType: "none" } });
    const first = requests.find(request => request.tools?.length);
    expect(first?.toolChoice).toEqual({ type: "function", function: { name: "npati_goal_action" } });
    expect(first?.tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(["npati_goal_action", "npati_workspace_action"]));
    expect(first?.tools?.map(tool => tool.function.name)).not.toContain("npati_email_action");
  } finally { await app.close(); }
});

async function automationApp(decision: Record<string, unknown>) {
  const store = new InMemoryWorkspaceStore();
  const company = await store.createCompany(auth, { name: "Operations team" }, "operations-team");
  let automationId = "";
  const requests: ChatRequest[] = [];
  const ai = engine(decision, async request => request.messages.some(message => message.role === "tool")
    ? { content: "Schedule changed." }
    : { content: "", toolCalls: [toolCall("reschedule", "npati_workspace_action", { action: "automation.update", companyId: company.id, automationId, automation: { cronExpression: "0 10 * * 2" } })] }, requests);
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  const created = await app.inject({ method: "POST", url: `/companies/${company.id}/automations`, payload: { name: "Weekly report", prompt: "Prepare the report", cronExpression: "0 9 * * 1", timezone: "UTC", status: "paused" } });
  automationId = created.json().automation?.id ?? created.json().id;
  const schedule = async () => (await app.inject({ method: "GET", url: `/companies/${company.id}/automations` })).json().automations[0].cronExpression;
  return { app, company, schedule };
}

it("executes a pronoun follow-up that names no record type when the classifier names the workspace change", async () => {
  const { app, company, schedule } = await automationApp({ intent: "CHAT", coreCapability: "npati_workspace_action", coreMutation: true });
  try {
    const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "Зміни її розклад на вівторок о 10:00.", contextType: "company", companyId: company.id } });
    expect(response.statusCode).toBe(200);
    expect(await schedule()).toBe("0 10 * * 2");
  } finally { await app.close(); }
});

it("still refuses a workspace write the classifier did not attribute to the request", async () => {
  const { app, company, schedule } = await automationApp({ intent: "CHAT", coreCapability: "npati_company_action", coreMutation: false });
  try {
    await app.inject({ method: "POST", url: "/chat", payload: { message: "Зміни її розклад на вівторок о 10:00.", contextType: "company", companyId: company.id } });
    expect(await schedule()).toBe("0 9 * * 1");
  } finally { await app.close(); }
});

it("answers a question about NPATI's AI models from the user's settings, not through the Company agent", async () => {
  const store = new InMemoryWorkspaceStore();
  const { company } = await companyWithAgents(store);
  const requests: ChatRequest[] = [];
  const ai = engine({ intent: "CHAT", coreCapability: null, npatiQuestion: true }, async () => ({ content: "Routing is automatic." }), requests);
  const delegation = vi.spyOn(CompanyDelegationRuntime.prototype, "execute").mockRejectedValue(new Error("An NPATI settings question must not be delegated"));
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "Яка модель ШІ зараз використовується за замовчуванням?", contextType: "company", companyId: company.id } });
    expect(response.statusCode).toBe(200);
    expect(delegation).not.toHaveBeenCalled();
    expect(JSON.stringify(requests.map(request => request.messages[0]?.content))).toContain("NPATI AI settings of this user");
  } finally { delegation.mockRestore(); await app.close(); }
});

it("hands work addressed to a named Company Agent to the Company runtime even if a capability is also returned", async () => {
  const { createChatProjectIntentResolver } = await import("../apps/agent-api/src/chat-project-intent");
  const chat = vi.fn(async () => ({ content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [], entityRead: null, coreCapability: "npati_company_action", coreMutation: false, assignsWorkToCompanyAgent: true }) }));
  const resolve = createChatProjectIntentResolver({ engine: { chat }, getAIContext: async () => ({}), log: { warn: vi.fn() }, listAgentNames: async () => ["Аналітик Маршрутів"] });
  const result = await resolve(auth, { message: "Попроси агента Аналітик Маршрутів назвати 3 причини затримок.", activeCompanyId: "company" });
  expect(result).not.toHaveProperty("coreCapability");
  expect(result.coreRoute?.capability).toBeUndefined();
});
