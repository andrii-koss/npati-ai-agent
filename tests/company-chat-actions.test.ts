import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CompanyChatActions } from "../apps/agent-api/src/company-chat-actions";
import { detectCompanyChatLanguage } from "../apps/agent-api/src/company-chat-i18n";
import { stripInternalChatActions } from "../apps/web/src/ChatMessageContent";
import { buildApp } from "../apps/agent-api/src/app";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";

const alice: AuthContext = { userId: "alice", workspaceId: "shared", permissions: ["workspace:read", "business:manage"] };
const bob: AuthContext = { userId: "bob", workspaceId: "shared", permissions: ["workspace:read", "business:manage"] };
const directive = (value: object) => `Done.\n\n\`\`\`company-action\n${JSON.stringify(value)}\n\`\`\``;

describe("company management from chat", () => {
  it("detects popular chat languages", () => {
    expect([
      ["Create a company with agents", "en"],
      ["Створи компанію з агентами", "uk"],
      ["Crée une entreprise avec trois agents", "fr"],
      ["Erstelle ein Unternehmen mit drei Agenten", "de"],
      ["Crea una empresa con tres agentes", "es"],
      ["Crea un'azienda con tre agenti", "it"],
      ["Utwórz firmę z trzema agentami", "pl"],
      ["Crie uma empresa com três agentes", "pt"],
      ["Maak een bedrijf met drie agenten", "nl"],
      ["Üç ajanlı bir şirket oluştur", "tr"],
      ["Создай компанию с тремя агентами", "ru"],
      ["创建一家拥有三个智能体的公司", "zh"],
      ["3人のエージェントを持つ会社を作成", "ja"],
      ["세 명의 에이전트가 있는 회사를 만들어 주세요", "ko"],
      ["أنشئ شركة بها ثلاثة وكلاء", "ar"],
      ["तीन एजेंटों वाली कंपनी बनाएँ", "hi"],
    ].map(([message, expected]) => [detectCompanyChatLanguage(message!), expected])).toEqual([
      ["en", "en"], ["uk", "uk"], ["fr", "fr"], ["de", "de"], ["es", "es"], ["it", "it"], ["pl", "pl"], ["pt", "pt"],
      ["nl", "nl"], ["tr", "tr"], ["ru", "ru"], ["zh", "zh"], ["ja", "ja"], ["ko", "ko"], ["ar", "ar"], ["hi", "hi"],
    ]);
  });

  it("returns a completed company card in the request language", async () => {
    const store = new InMemoryWorkspaceStore();
    const result = await CompanyChatActions.extractAndExecute(alice, directive({ action: "create", fields: { name: "Atelier IA", industry: "Technologie" }, agents: [{ action: "create", fields: { name: "Responsable", role: "Coordination" }, main: true }] }), store, "conversation-fr", { requestMessage: "Crée une entreprise avec un agent" });
    expect(result.cleanText).toContain("J’ai créé l’entreprise");
    expect(result.cleanText).toContain("```card:Entreprise: Atelier IA");
    expect(result.cleanText).toContain("**Secteur:** Technologie");
    expect(result.cleanText).toContain("**Étape suivante :**");
    expect(result.cleanText).not.toContain("Here is the current configuration");
  });

  it("recognizes explicit company configuration requests in the company chat context", () => {
    expect(CompanyChatActions.isManagementRequest("Створи компанію і трьох агентів")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("Додай нового агента до компанії")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("Зроби таку сітку агентів")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("Create a company with an agent team")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("Create a marketing plan for my company")).toBe(false);
    expect(CompanyChatActions.isManagementRequest("Компанію мені створи з агентами")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("в компанії, додай текст агенту в полях Instructions, System Instruction, Prompt Guidelines, Recommended Prompts і Tools & Capabilities")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("в компанії, додай ще одного агента, для теста")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("можеш агенту надати роль і Tools & Capabilities?")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("створи додаткового агента в компанії")).toBe(true);
    expect(CompanyChatActions.isPotentialMutationRequest('добре тепер це поле також заповни "Recommended Prompts" для агентів')).toBe(true);
    expect(CompanyChatActions.isPotentialMutationRequest("напиши статтю для компанії")).toBe(false);
    for (const message of [
      "Crée une entreprise avec trois agents",
      "Erstelle ein Unternehmen mit drei Agenten",
      "Crea una empresa con tres agentes",
      "Crea un'azienda con tre agenti",
      "Utwórz firmę z trzema agentami",
      "Crie uma empresa com três agentes",
      "Maak een bedrijf met drie agenten",
      "Üç ajanlı bir şirket oluştur",
      "Создай компанию с тремя агентами",
      "创建一家拥有三个智能体的公司",
      "3人のエージェントを持つ会社を作成",
      "세 명의 에이전트가 있는 회사를 만들어 주세요",
      "أنشئ شركة بها ثلاثة وكلاء",
      "तीन एजेंटों वाली कंपनी बनाएँ",
    ]) expect(CompanyChatActions.isManagementRequest(message)).toBe(true);
  });

  it("includes the selected company even beyond the first prompt page", async () => {
    const store = new InMemoryWorkspaceStore();
    let selectedId = "";
    for (let index = 0; index < 31; index++) {
      selectedId = (await store.createCompany(alice, { name: `Company ${index}` }, `company-${index}`)).id;
    }
    const prompt = await CompanyChatActions.buildActionPlannerPrompt(alice, store, "Update this company", selectedId);
    expect(prompt).toContain(selectedId);
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

  it("creates the requested five-agent test company without waiting for an AI planner", async () => {
    const store = new InMemoryWorkspaceStore();
    let chatCalls = 0;
    let streamCalls = 0;
    const aiEngine: AIEngine = {
      chat: async () => { chatCalls += 1; throw new Error("The model planner must not handle deterministic test-company creation"); }, async *stream() { streamCalls += 1; throw new Error("The general chat model must not handle deterministic test-company creation"); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Привіт, створи мені тестову компанію, із 5 агентів, із різними ролеми", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"companyAction":{"action":"create"');
      expect(response.body).not.toContain("Не вдалося виконати зміну компанії");
      const companies = (await store.listCompanies(alice)).items;
      expect(companies).toEqual([expect.objectContaining({ name: "Тестова компанія", industry: "Тестування та автоматизація", languages: ["Українська"] })]);
      const agents = await store.listCompanyAgents(alice, companies[0]!.id);
      expect(agents).toHaveLength(5);
      expect(new Set(agents.map((agent) => agent.role)).size).toBe(5);
      expect(chatCalls).toBe(0);
      expect(streamCalls).toBe(0);
      const mainAgent = agents.find((agent) => agent.id === companies[0]!.mainAgentId);
      expect(mainAgent).toEqual(expect.objectContaining({ name: "Координатор", role: "Керівник команди", modelId: undefined }));
    } finally { await app.close(); }
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

  it("maps Company UI field labels and updates the selected main agent without repeating IDs", async () => {
    const store = new InMemoryWorkspaceStore();
    let company = await store.createCompany(alice, { name: "Selected Studio" }, "company-ui-fields");
    const agent = await store.createCompanyAgent(alice, company.id, { name: "Lead", role: "Coordinator" }, "agent-ui-fields");
    company = await store.setCompanyMainAgent(alice, company.id, agent.id, company.revision);
    const errors: unknown[] = [];
    const result = await CompanyChatActions.extractAndExecute(alice, directive({
      action: "update",
      agents: [{
        action: "update",
        fields: {
          instructions: {
            "System Instruction": "Керуй тестовою командою.",
            "Prompt Guidelines": "Відповідай стисло.",
            "Recommended Prompts": "Перевір статус\nПідготуй звіт",
          },
          "Tools & Capabilities": ["Knowledge", "Company Memory", "Web Search", "Code Mode / Exec - Critical - Approval required"],
          role: "Керівник тестування",
        },
      }],
    }), store, "conversation-ui-fields", {
      selectedCompanyId: company.id,
      requestMessage: "в компанії, додай текст агенту в полях Instructions і Tools & Capabilities",
      onError: (error) => errors.push(error),
    });
    expect(errors).toEqual([]);
    expect(result.companyAction?.action).toBe("update");
    const updated = await store.getCompanyAgent(alice, company.id, agent.id);
    expect(updated).toMatchObject({
      role: "Керівник тестування",
      systemInstruction: "Керуй тестовою командою.",
      promptGuidelines: "Відповідай стисло.",
      recommendedPrompts: ["Перевір статус", "Підготуй звіт"],
      tools: ["storage.agent_knowledge_retrieval", "storage.company_memory", "research.web_search", "exec"],
    });
  });

  it("adds an agent to the selected company when the planner omits the repeated company ID", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Selected Studio" }, "company-add-agent");
    const result = await CompanyChatActions.extractAndExecute(alice, directive({
      action: "update",
      agents: [{ action: "create", fields: { name: "Тестовий аналітик", role: "Аналітик", description: "Перевіряє роботу команди" } }],
    }), store, "conversation-add-agent", {
      selectedCompanyId: company.id,
      requestMessage: "в компанії, додай ще одного агента, для теста",
    });
    expect(result.companyAction?.action).toBe("update");
    expect((await store.listCompanyAgents(alice, company.id)).map((item) => item.name)).toEqual(["Тестовий аналітик"]);
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
    const result = await CompanyChatActions.extractAndExecute(alice, directive({ action: "create", fields: { name: "Studio" }, agents: [{ action: "create", fields: { name: "Lead", role: "Coordinator", modelId: "unapproved/model" } }] }), store, "conversation-7", { requestMessage: "Create Studio with model unapproved/model" });
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

  it("does not trust a streamed claim of creation and plans a real write", async () => {
    const store = new InMemoryWorkspaceStore();
    const claim = "I created your company and agents.";
    const action = directive({ action: "create", fields: { name: "Verified Studio", industry: "IT / SaaS", description: "Тестова компанія", productsServices: "AI-сервіси", languages: ["Українська"] }, agents: [{ action: "create", fields: { name: "Lead", role: "Coordinator", description: "Керує командою" }, main: true }] });
    const aiEngine: AIEngine = {
      chat: async () => ({ content: action }), async *stream() { yield claim; },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Створи компанію і агента", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("event: delta");
      expect(response.body).toContain('"companyAction":{"action":"create"');
      expect(response.body).toContain("Готово, я створив компанію");
      expect(response.body).toContain("```card:Компанія: Verified Studio");
      expect(response.body).toContain("**Галузь:** IT / SaaS");
      expect(response.body).toContain("**Lead** - Coordinator (головний агент)");
      expect(response.body).toContain("**Наступний крок:** хочете, щоб я детальніше налаштував ролі");
      expect(response.body).not.toContain("Done. I created");
      const companies = (await store.listCompanies(alice)).items;
      expect(companies).toHaveLength(1);
      expect((await store.listCompanyAgents(alice, companies[0]!.id)).map((agent) => agent.name)).toEqual(["Lead"]);
      const page = await app.inject({ method: "GET", url: "/companies?limit=100" });
      expect(page.statusCode).toBe(200);
      expect(page.json().companies).toEqual([expect.objectContaining({ id: companies[0]!.id, name: "Verified Studio" })]);
    } finally { await app.close(); }
  });

  it("reports no saved change when a claimed creation cannot produce an executable action", async () => {
    const store = new InMemoryWorkspaceStore();
    const aiEngine: AIEngine = {
      chat: async () => ({ content: "NO_ACTION" }), async *stream() { yield "I created your company."; },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Створи компанію і агента", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("event: delta");
      expect(response.body).toContain("Компанію та агентів не було змінено");
      expect(response.body).not.toContain("companyAction");
      expect((await store.listCompanies(alice)).items).toHaveLength(0);
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
      expect(response.body).toContain('"activeContext":{"contextType":"company"');
      expect(response.body).toContain(`"companyId":"${company.id}"`);
      expect((await store.getCompany(alice, company.id)).website).toBe("https://selected.example");
    } finally { await app.close(); }
  });

  it("routes a Recommended Prompts follow-up to the selected company's agents", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Prompt Studio" }, "prompt-company");
    const lead = await store.createCompanyAgent(alice, company.id, { name: "Lead", role: "Coordinator" }, "prompt-lead");
    await store.setCompanyMainAgent(alice, company.id, lead.id, company.revision);
    let chatCalls = 0;
    const aiEngine: AIEngine = {
      chat: async () => { chatCalls += 1; throw new Error("The model planner must not handle this deterministic settings follow-up"); }, async *stream() { throw new Error("The general company runtime must not handle this settings follow-up"); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: 'добре тепер це поле також заповни "Recommended Prompts" для агентів', contextType: "company", companyId: company.id } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"companyAction":{"action":"update"');
      expect(chatCalls).toBe(0);
      expect((await store.listCompanyAgents(alice, company.id))[0]?.recommendedPrompts).toEqual([
        "Склади план роботи для ролі «Coordinator»",
        "Проаналізуй поточний стан і запропонуй наступні кроки",
        "Перевір результат роботи та вкажи, що потрібно покращити",
      ]);
    } finally { await app.close(); }
  });

  it("asks for confirmation before deleting the selected company and deletes it only after explicit confirmation", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Тестова студія" }, "delete-confirm-company");
    let researchCalls = 0;
    const aiEngine: AIEngine = {
      chat: async () => { throw new Error("Deletion confirmation must not call an AI model"); }, async *stream() { throw new Error("Deletion confirmation must not call an AI model"); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const webResearch = {
      shouldResearch: () => true,
      run: async () => { researchCalls += 1; return { kind: "web_search" as const, context: "unexpected", sources: [] }; },
    } as any;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace, webResearch });
    try {
      const question = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Тепер видали її, для теста", contextType: "company", companyId: company.id } });
      expect(question.statusCode).toBe(200);
      expect(question.body).toContain("Ви хочете видалити вибрану компанію");
      expect(question.body).toContain("Тестова студія");
      expect(question.body).not.toContain('"companyAction"');
      expect((await store.listCompanies(alice)).items).toHaveLength(1);
      expect(researchCalls).toBe(0);

      const confirmed = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Так, видали компанію Тестова студія", contextType: "company", companyId: company.id } });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.body).toContain('"companyAction":{"action":"delete"');
      expect((await store.listCompanies(alice)).items).toHaveLength(0);
      expect(researchCalls).toBe(0);
    } finally { await app.close(); }
  });

  it("lists owned companies when a delete request has no selected company", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.createCompany(alice, { name: "Alpha" }, "list-alpha");
    await store.createCompany(alice, { name: "Beta" }, "list-beta");
    const message = await CompanyChatActions.deleteConfirmationMessage(alice, store, "Видали компанію", undefined);
    expect(message).toContain("Яку компанію ви хочете видалити?");
    expect(message).toContain("**Alpha**");
    expect(message).toContain("**Beta**");
  });

  it("does not expose provider diagnostics when a company run fails", async () => {
    const store = new InMemoryWorkspaceStore();
    let company = await store.createCompany(alice, { name: "Failure Studio" }, "failure-company");
    const lead = await store.createCompanyAgent(alice, company.id, { name: "Lead", role: "Coordinator" }, "failure-lead");
    company = await store.setCompanyMainAgent(alice, company.id, lead.id, company.revision);
    const rawProviderError = 'NPATI AI A2A message failed with HTTP 500: API [502]: {"diagnostics":{"provider":"ollama-cloud","terminalReason":"HTTP 402"}}';
    const aiEngine: AIEngine = {
      chat: async () => { throw new Error(rawProviderError); }, async *stream() { throw new Error(rawProviderError); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "ти працюєш??", contextType: "company", companyId: company.id } });
      expect(response.statusCode).toBe(200);
      expect(response.json().message).toContain("тимчасову недоступність вибраної AI-моделі");
      expect(response.body).not.toContain("ollama-cloud");
      expect(response.body).not.toContain("diagnostics");
      expect(response.body).not.toContain("HTTP 402");
    } finally { await app.close(); }
  });
});
