import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CompanyChatActions } from "../apps/agent-api/src/company-chat-actions";
import { stripInternalChatActions } from "../apps/web/src/ChatMessageContent";
import { buildApp } from "../apps/agent-api/src/app";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";

const alice: AuthContext = { userId: "alice", workspaceId: "shared", permissions: ["workspace:read", "business:manage"] };
const bob: AuthContext = { userId: "bob", workspaceId: "shared", permissions: ["workspace:read", "business:manage"] };
const directive = (value: object) => `Done.\n\n\`\`\`company-action\n${JSON.stringify(value)}\n\`\`\``;

describe("company management from chat", () => {
  it("recognizes explicit company configuration requests in the company chat context", () => {
    expect(CompanyChatActions.isManagementRequest("Створи компанію і трьох агентів")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("Додай нового агента до компанії")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("Зроби таку сітку агентів")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("Create a company with an agent team")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("Create a marketing plan for my company")).toBe(false);
  });

  it("creates a company, agents, their reporting edge and main agent", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(alice, { name: "Test idea", businessStage: "idea" });
    const text = directive({
      action: "create",
      fields: { name: "Studio", businessId: business.id, website: "https://example.com", industry: "Design", description: "Creates brands", productsServices: "Identity", languages: ["Ukrainian"], brandTone: "Direct", companyInstructions: "Be accurate", status: "active" },
      agents: [
        { action: "create", fields: { name: "Lead", role: "Coordinator", systemInstruction: "Coordinate", tools: ["research.web_search"] }, main: true },
        { action: "create", fields: { name: "Researcher", role: "Research", recommendedPrompts: ["Find sources"] }, parentAgentName: "Lead" },
      ],
    });
    const result = await CompanyChatActions.extractAndExecute(alice, text, store, "conversation-1");
    expect(result.companyAction?.action).toBe("create");
    expect(result.cleanText).toContain("/settings/company?company=");
    const company = await store.getCompany(alice, result.companyAction!.companyId);
    expect(company.description).toBe("Creates brands");
    expect(company.businessId).toBe(business.id);
    const agents = await store.listCompanyAgents(alice, company.id);
    expect(agents).toHaveLength(2);
    expect(company.mainAgentId).toBe(agents.find((agent) => agent.name === "Lead")?.id);
    const edges = await store.listCompanyAgentEdges(alice, company.id);
    expect(edges).toEqual([expect.objectContaining({ parentAgentId: company.mainAgentId, childAgentId: agents.find((agent) => agent.name === "Researcher")?.id })]);
    const replay = await CompanyChatActions.extractAndExecute(alice, text, store, "conversation-1");
    expect(replay.companyAction?.companyId).toBe(company.id);
    expect(await store.listCompanyAgents(alice, company.id)).toHaveLength(2);
  });

  it("updates company and agent fields, then deletes only the specified agent", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Studio" }, "company-1");
    const agent = await store.createCompanyAgent(alice, company.id, { name: "Lead", role: "Coordinator" }, "agent-1");
    const updated = await CompanyChatActions.extractAndExecute(alice, directive({ action: "update", companyId: company.id, fields: { brandTone: "Friendly", languages: ["English"] }, agents: [{ action: "update", agentId: agent.id, fields: { role: "Director", isActive: false } }] }), store, "conversation-2");
    expect(updated.companyAction?.action).toBe("update");
    expect((await store.getCompany(alice, company.id)).brandTone).toBe("Friendly");
    expect((await store.getCompanyAgent(alice, company.id, agent.id)).role).toBe("Director");
    expect((await store.getCompanyAgent(alice, company.id, agent.id)).isActive).toBe(false);
    await CompanyChatActions.extractAndExecute(alice, directive({ action: "update", companyId: company.id, agents: [{ action: "delete", agentId: agent.id }] }), store, "conversation-3");
    expect(await store.listCompanyAgents(alice, company.id)).toHaveLength(0);
  });

  it("cannot edit or delete another user's company or link another user's business", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(bob, { name: "Bob Studio" }, "bob-company");
    const business = await store.createBusiness(bob, { name: "Bob Idea", businessStage: "idea" });
    const edit = await CompanyChatActions.extractAndExecute(alice, directive({ action: "update", companyId: company.id, fields: { name: "Taken" } }), store, "conversation-4");
    const remove = await CompanyChatActions.extractAndExecute(alice, directive({ action: "delete", companyId: company.id }), store, "conversation-5");
    const link = await CompanyChatActions.extractAndExecute(alice, directive({ action: "create", fields: { name: "Wrong", businessId: business.id } }), store, "conversation-6");
    expect(edit.companyAction).toBeUndefined();
    expect(remove.companyAction).toBeUndefined();
    expect(link.companyAction).toBeUndefined();
    expect((await store.getCompany(bob, company.id)).name).toBe("Bob Studio");
    expect((await store.listCompanies(alice)).items).toHaveLength(0);
  });

  it("requires company management permission even when chat is accessible", async () => {
    const store = new InMemoryWorkspaceStore();
    const reader: AuthContext = { ...alice, permissions: ["workspace:read", "chat:use"] };
    const result = await CompanyChatActions.extractAndExecute(reader, directive({ action: "create", fields: { name: "Denied" } }), store, "conversation-reader");
    expect(result.companyAction).toBeUndefined();
    expect((await store.listCompanies(alice)).items).toHaveLength(0);
  });

  it("rejects unconfigured models and hides partial company directives while streaming", async () => {
    const store = new InMemoryWorkspaceStore();
    const result = await CompanyChatActions.extractAndExecute(alice, directive({ action: "create", fields: { name: "Studio" }, agents: [{ action: "create", fields: { name: "Lead", role: "Coordinator", modelId: "unapproved/model" } }] }), store, "conversation-7");
    expect(result.companyAction).toBeUndefined();
    expect((await store.listCompanies(alice)).items).toHaveLength(0);
    const raw = directive({ action: "delete", companyName: "Studio" });
    for (let i = "Done.".length; i <= raw.length; i++) expect(stripInternalChatActions(raw.slice(0, i), true).trim()).toBe("Done.");
    const incomplete = await CompanyChatActions.extractAndExecute(alice, "Done.\n```company-action\n{", store, "conversation-incomplete");
    expect(incomplete.cleanText).not.toContain("company-action");
  });

  it("runs company cleanup before deletion", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Studio" }, "company-cleanup");
    const cleaned: string[] = [];
    const result = await CompanyChatActions.extractAndExecute(alice, directive({ action: "delete", companyId: company.id }), store, "conversation-8", { beforeDeleteCompany: async (id) => { cleaned.push(id); } });
    expect(result.companyAction?.action).toBe("delete");
    expect(cleaned).toEqual([company.id]);
    expect((await store.listCompanies(alice)).items).toHaveLength(0);
  });

  it("executes a company directive through the streamed chat API", async () => {
    const store = new InMemoryWorkspaceStore();
    const authProvider = { authenticate: async () => alice };
    const output = directive({ action: "create", fields: { name: "Stream Studio", industry: "Design" }, agents: [{ action: "create", fields: { name: "Lead", role: "Coordinator" }, main: true }] });
    const aiEngine: AIEngine = {
      chat: async () => ({ content: output }),
      async *stream() { yield output.slice(0, 20); yield output.slice(20); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Create a company and main agent", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"companyAction":{"action":"create"');
      expect(response.body).not.toContain('"message":"Done.\\n\\n```company-action');
      const companies = (await store.listCompanies(alice)).items;
      expect(companies.map((company) => company.name)).toEqual(["Stream Studio"]);
      expect((await store.listCompanyAgents(alice, companies[0]!.id)).map((agent) => agent.name)).toEqual(["Lead"]);
    } finally { await app.close(); }
  });

  it("routes explicit settings changes from company chat to the owned company", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Selected Studio" }, "selected-company");
    const output = directive({ action: "update", companyId: company.id, fields: { website: "https://selected.example" } });
    const aiEngine: AIEngine = {
      chat: async () => ({ content: output }), async *stream() { yield output; },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Update company website", contextType: "company", companyId: company.id } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"companyAction":{"action":"update"');
      expect((await store.getCompany(alice, company.id)).website).toBe("https://selected.example");
    } finally { await app.close(); }
  });
});
