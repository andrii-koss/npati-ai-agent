import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CompanyChatActions } from "../apps/agent-api/src/company-chat-actions";
import { detectCompanyChatLanguage, isLocalizedCompanyManagementRequest } from "../apps/agent-api/src/company-chat-i18n";
import { compositeCreationCopy } from "../apps/agent-api/src/composite-chat-i18n";
import { defaultLocalizedAgentProfiles } from "../apps/agent-api/src/company-agent-profile-i18n";
import { stripInternalChatActions } from "../apps/web/src/ChatMessageContent";
import { buildApp } from "../apps/agent-api/src/app";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";

const alice: AuthContext = { userId: "alice", workspaceId: "shared", permissions: ["workspace:read", "business:manage"] };
const bob: AuthContext = { userId: "bob", workspaceId: "shared", permissions: ["workspace:read", "business:manage"] };
const directive = (value: object) => `Done.\n\n\`\`\`company-action\n${JSON.stringify(value)}\n\`\`\``;

describe("company management from chat", () => {
  it("checks long localized settings messages linearly while preserving line boundaries", () => {
    expect(isLocalizedCompanyManagementRequest("Background data. ".repeat(6250))).toBe(false);
    expect(isLocalizedCompanyManagementRequest("Notes\nCrée une entreprise avec trois agents")).toBe(true);
    expect(isLocalizedCompanyManagementRequest("Crée quelque chose\nune entreprise")).toBe(false);
  });

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
    expect(detectCompanyChatLanguage("так")).toBe("uk");
  });

  it("understands a short Ukrainian yes as acceptance of the previous agent-setup question", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Тестова компанія" }, "contextual-follow-up-company");
    for (let index = 0; index < 5; index++) {
      await store.createCompanyAgent(alice, company.id, { name: `Агент ${index + 1}`, role: index === 0 ? "Координатор" : "Спеціаліст" }, `contextual-agent-${index}`);
    }
    const conversation = await store.createNeutralConversation(alice, "Контекстне підтвердження");
    await store.appendNeutralMessage(alice, conversation.id, "assistant", `Готово.\n\n\`\`\`card:Компанія: Тестова компанія\n[Відкрити налаштування компанії →](/settings/company?company=${company.id})\n\`\`\`\n\n**Наступний крок:** хочете, щоб я детальніше налаштував ролі, інструкції та моделі для цих агентів?`);
    const existingAgents = await store.listCompanyAgents(alice, company.id);
    const aiAnswer = `На основі завдань цієї компанії я рекомендую окремі ролі для координації, досліджень, маркетингу, контенту й операцій. Я також підготував для кожної ролі власну системну інструкцію та робочі запити.\n\nХочете, щоб я наступним кроком підібрав доступну модель для кожного агента?\n\n\`\`\`company-action\n${JSON.stringify({
      action: "update",
      companyId: company.id,
      agents: existingAgents.map((agent, index) => ({
        action: "update",
        agentId: agent.id,
        fields: {
          role: ["Керівник команди", "Аналітик-дослідник", "Маркетолог", "Контент-стратег", "Операційний аналітик"][index],
          systemInstruction: `AI-інструкція для агента ${index + 1}`,
          promptGuidelines: `AI-правила промптів для агента ${index + 1}`,
          recommendedPrompts: [`AI-запит ${index + 1}.1`, `AI-запит ${index + 1}.2`],
        },
      })),
    })}\n\`\`\``;
    let modelCalls = 0;
    const aiEngine: AIEngine = {
      chat: async () => { modelCalls += 1; return { content: aiAnswer }; },
      async *stream() { throw new Error("Contextual company follow-up uses one validated AI planning call"); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "так", conversationId: conversation.id, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"companyAction":{"action":"update"');
      expect(response.body).toContain("На основі завдань цієї компанії я рекомендую");
      expect(response.body).toContain("підібрав доступну модель");
      expect(response.body).not.toContain("company-action");
      expect(response.body).not.toContain("Ось що зараз налаштовано");
      expect(response.body).not.toContain("хочете, щоб я детальніше налаштував ролі");
      expect(response.body).not.toContain("Не удалось выполнить задачу компании");
      const agents = await store.listCompanyAgents(alice, company.id);
      expect(agents).toHaveLength(5);
      expect(new Set(agents.map((agent) => agent.role)).size).toBe(5);
      expect(agents.every((agent) => Boolean(agent.systemInstruction) && Boolean(agent.promptGuidelines) && agent.recommendedPrompts.length >= 2)).toBe(true);
      expect(modelCalls).toBeGreaterThanOrEqual(1);
    } finally { await app.close(); }
  });

  it("renames the agent the user named, not the main agent, when the directive omits or mismatches the target", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Пекарня" }, "rename-bakery");
    const olena = await store.createCompanyAgent(alice, company.id, { name: "Олена", role: "COO" }, "olena");
    const marko = await store.createCompanyAgent(alice, company.id, { name: "Марко", role: "Маркетолог" }, "marko");
    await store.setCompanyMainAgent(alice, company.id, olena.id, company.revision);
    const request = "Перейменуй агента Марко на «Марко SMM».";
    await CompanyChatActions.extractAndExecute(alice, directive({ action: "update", companyId: company.id, agents: [{ action: "update", fields: { name: "Марко SMM" } }] }), store, "rename-1", { requestMessage: request, selectedCompanyId: company.id });
    let agents = await store.listCompanyAgents(alice, company.id);
    expect(agents.find((agent) => agent.id === olena.id)?.name).toBe("Олена");
    expect(agents.find((agent) => agent.id === marko.id)?.name).toBe("Марко SMM");
    await CompanyChatActions.extractAndExecute(alice, directive({ action: "update", companyId: company.id, agents: [{ action: "update", agentId: olena.id, fields: { role: "Маркетинг і SMM" } }] }), store, "rename-2", { requestMessage: "Зміни роль агента Марко SMM на «Маркетинг і SMM»", selectedCompanyId: company.id });
    agents = await store.listCompanyAgents(alice, company.id);
    expect(agents.find((agent) => agent.id === olena.id)?.role).toBe("COO");
    expect(agents.find((agent) => agent.id === marko.id)?.role).toBe("Маркетинг і SMM");
  });

  it("does not read a deletion word inside a quoted company name as a deletion request", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.createCompany(alice, { name: "Temp Delete Co" }, "temp-delete");
    expect(await CompanyChatActions.deleteConfirmationMessage(alice, store, "Створи тимчасову компанію «Temp Delete Co» для тесту, без агентів.")).toBeUndefined();
    expect(await CompanyChatActions.deleteConfirmationMessage(alice, store, "Додай агента «Тест» у компанію \"Temp Delete Co\".")).toBeUndefined();
    expect(await CompanyChatActions.deleteConfirmationMessage(alice, store, "Видали компанію «Temp Delete Co».")).toBeTruthy();
    expect(await CompanyChatActions.deleteConfirmationMessage(alice, store, "Додай агента «Тест» у компанію Temp Delete Co.")).toBeUndefined();
    expect(await CompanyChatActions.deleteConfirmationMessage(alice, store, "Видали компанію Temp Delete Co, яку я створив учора.")).toBeTruthy();
  });

  it("does not treat a question about existing companies as a change", () => {
    expect(CompanyChatActions.isManagementRequest("Які дві компанії ми сьогодні створили і яка з них має сайт на Next.js?")).toBe(false);
    expect(CompanyChatActions.isManagementRequest("Which agents did we add to Nordic Fit?")).toBe(false);
    expect(CompanyChatActions.isManagementRequest("Створи компанію Nordic Fit. Які агенти їй потрібні?")).toBe(true);
  });

  it("never applies a change aimed at another, missing company to the selected company", async () => {
    const store = new InMemoryWorkspaceStore();
    const bakery = await store.createCompany(alice, { name: "Пекарня Сонях" }, "named-bakery");
    const message = "Додай агента «Тест» у компанію Temp Delete Co.";
    expect(await CompanyChatActions.buildDeterministicAction(alice, store, message, bakery.id)).toBeUndefined();
    const result = await CompanyChatActions.extractAndExecute(alice, directive({ action: "update", companyId: bakery.id, agents: [{ action: "create", fields: { name: "Тест", role: "Тест" } }] }), store, "named-missing", { requestMessage: message, selectedCompanyId: bakery.id });
    expect(result.companyAction).toBeUndefined();
    expect(await store.listCompanyAgents(alice, bakery.id)).toHaveLength(0);
    const own = await CompanyChatActions.extractAndExecute(alice, directive({ action: "update", companyId: bakery.id, agents: [{ action: "create", fields: { name: "Олег", role: "Бариста" } }] }), store, "named-own", { requestMessage: "Додай агента «Олег» у компанію Пекарня Сонях", selectedCompanyId: bakery.id });
    expect(own.companyAction?.companyId).toBe(bakery.id);
  });

  it("does not take a database field for a company field, and reads Portuguese infinitives", () => {
    expect(CompanyChatActions.isManagementRequest("Я передумав: прибери поле delivery_date з таблиці orders.")).toBe(false);
    expect(CompanyChatActions.isPotentialMutationRequest("Я передумав: прибери поле delivery_date з таблиці orders.")).toBe(false);
    expect(CompanyChatActions.isManagementRequest("Заповни поля компанії: сайт і галузь")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("Usa essa pesquisa para atualizar as instruções da empresa Nordic Fit")).toBe(true);
  });

  it("treats renaming an agent as company management", () => {
    expect(CompanyChatActions.isManagementRequest("Перейменуй агента Марко на «Марко SMM».")).toBe(true);
    expect(CompanyChatActions.isManagementRequest("Rename the agent Leo to Leo Content")).toBe(true);
  });

  it("does not create a duplicate when the planner decorates an existing company name", async () => {
    const store = new InMemoryWorkspaceStore();
    const existing = await store.createCompany(alice, { name: "Nordic Fit" }, "existing-fit");
    const result = await CompanyChatActions.extractAndExecute(alice, directive({ action: "create", fields: { name: "Nordic Fit (New)", industry: "Fitness" } }), store, "conversation-duplicate", { requestMessage: "Create a second company «Nordic Fit» — a boutique fitness studio in Lisbon" });
    expect((await store.listCompanies(alice)).items.map((company) => company.name)).toEqual(["Nordic Fit"]);
    expect(result.companyAction?.companyId).toBe(existing.id);
    const named = await CompanyChatActions.extractAndExecute(alice, directive({ action: "create", fields: { name: "Studio (Lisbon)" } }), store, "conversation-parenthesis", { requestMessage: "Create a company named Studio (Lisbon)" });
    expect(named.companyAction?.action).toBe("create");
    expect((await store.listCompanies(alice)).items.map((company) => company.name)).toContain("Studio (Lisbon)");
  });

  it("plans a company action once more when its directive JSON does not parse", async () => {
    const store = new InMemoryWorkspaceStore();
    const valid = directive({ action: "create", fields: { name: "Malformed Studio", industry: "Fitness" } });
    const broken = "Done.\n\n```company-action\n{\"action\":\"create\",\"fields\":{\"name\":\"Malformed Studio\" \"industry\":\"Fitness\"}}\n```";
    const calls: ChatRequestLike[] = [];
    type ChatRequestLike = { messages: Array<{ role: string; content: unknown }> };
    const aiEngine: AIEngine = {
      chat: async (request) => {
        calls.push(request as ChatRequestLike);
        const retry = (request as ChatRequestLike).messages.some((item) => item.role === "system" && String(item.content).includes("was not valid JSON"));
        return { content: retry ? valid : broken };
      },
      async *stream() { yield { delta: broken }; },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Create a company named Malformed Studio for a fitness studio", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect((await store.listCompanies(alice)).items.map((company) => company.name)).toContain("Malformed Studio");
      expect(calls.filter((request) => request.messages.some((item) => String(item.content).includes("was not valid JSON")))).toHaveLength(1);
    } finally { await app.close(); }
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

  it("creates and links a business idea, goal, company, agents, and memory in one existing chat", async () => {
    const store = new InMemoryWorkspaceStore();
    const conversation = await store.createNeutralConversation(alice, "Комплексне створення");
    let chatCalls = 0;
    let streamCalls = 0;
    const aiEngine: AIEngine = {
      chat: async () => { chatCalls += 1; throw new Error("Composite creation must not depend on an external model"); },
      async *stream() { streamCalls += 1; throw new Error("Composite creation must not depend on an external model"); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const message = "створи ще раз, для тесту, ще одну компанію, ціль, бізнес ідею, і меморі, для теста";
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, conversationId: conversation.id, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(`"conversationId":"${conversation.id}"`);
      expect(response.body).toContain('"businessAction":{"action":"create"');
      expect(response.body).toContain('"goalAction":{"action":"create"');
      expect(response.body).toContain('"companyAction":{"action":"create"');
      expect(response.body).toContain('"workspaceAction":{"action":"memory.create"');
      const businesses = await store.listUserBusinesses(alice);
      expect(businesses).toHaveLength(1);
      const goals = await store.listGoals(alice, businesses[0]!.id);
      expect(goals).toHaveLength(1);
      expect(await store.listMemory(alice, businesses[0]!.id)).toEqual([
        expect.objectContaining({ type: "business_fact", title: "Контекст тестового бізнесу", confidence: 1 }),
      ]);
      const companies = (await store.listCompanies(alice)).items;
      expect(companies).toEqual([expect.objectContaining({ businessId: businesses[0]!.id, name: "Тестова компанія" })]);
      expect(await store.listCompanyAgents(alice, companies[0]!.id)).toHaveLength(5);
      expect(await store.listNeutralConversations(alice)).toHaveLength(1);
      expect(chatCalls).toBe(0);
      expect(streamCalls).toBe(0);
    } finally { await app.close(); }
  });

  it("understands and completes the combined creation flow in all 16 supported languages", async () => {
    const cases = [
      ["en", "Create a test business idea and goal, then create a company with 5 agents and link the idea to it."],
      ["uk", "Створи тестову бізнес-ідею і ціль, потім створи компанію з 5 агентами та прив’яжи до неї ідею."],
      ["fr", "Crée une idée d’entreprise test et un objectif, puis crée une entreprise avec 5 agents et associe l’idée."],
      ["de", "Erstelle eine Test-Geschäftsidee und ein Ziel, dann ein Unternehmen mit 5 Agenten und verknüpfe die Idee."],
      ["es", "Crea una idea de negocio de prueba y un objetivo, luego una empresa con 5 agentes y vincula la idea."],
      ["it", "Crea un’idea imprenditoriale di prova e un obiettivo, poi un’azienda con 5 agenti e collega l’idea."],
      ["pl", "Utwórz testowy pomysł na biznes i cel, następnie firmę z 5 agentami i połącz z nią pomysł."],
      ["pt", "Crie uma ideia de negócio de teste e uma meta, depois uma empresa com 5 agentes e vincule a ideia."],
      ["nl", "Maak een test-businessidee en een doel, daarna een bedrijf met 5 agenten en koppel het idee."],
      ["tr", "Bir test iş fikri ve hedef oluştur, ardından 5 ajan ile bir şirket oluştur ve fikri bağla."],
      ["ru", "Создай тестовую бизнес-идею и цель, затем компанию с 5 агентами и привяжи идею."],
      ["zh", "创建一个测试商业想法和目标，然后创建一家拥有5个智能体的公司并关联该想法。"],
      ["ja", "テスト用のビジネスアイデアと目標を作成し、5人のエージェントを持つ会社を作成してアイデアを関連付けてください。"],
      ["ko", "테스트 비즈니스 아이디어와 목표를 만들고 5명의 에이전트가 있는 회사를 만들어 아이디어를 연결하세요."],
      ["ar", "أنشئ فكرة عمل تجريبية وهدفًا، ثم أنشئ شركة تضم 5 وكلاء واربط الفكرة بها."],
      ["hi", "एक परीक्षण व्यवसाय विचार और लक्ष्य बनाएँ, फिर 5 एजेंटों वाली कंपनी बनाएँ और विचार को उससे जोड़ें।"],
    ] as const;
    const store = new InMemoryWorkspaceStore();
    const aiEngine: AIEngine = {
      chat: async () => { throw new Error("The multilingual deterministic flow must not call chat"); },
      async *stream() { throw new Error("The multilingual deterministic flow must not call stream"); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      for (const [language, message] of cases) {
        expect(detectCompanyChatLanguage(message)).toBe(language);
        const copy = compositeCreationCopy(message);
        const conversation = await store.createNeutralConversation(alice, `composite-${language}`);
        const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, conversationId: conversation.id, contextType: "none" } });
        expect(response.statusCode, language).toBe(200);
        expect(response.body, language).toContain(copy.intro);
        expect(response.body, language).toContain(`card:${copy.businessCard}: ${copy.businessName}`);
        expect(response.body, language).toContain('"companyAction":{"action":"create"');
        const business = (await store.listUserBusinesses(alice)).find((item) => item.name === copy.businessName);
        expect(business, language).toBeDefined();
        expect(await store.listGoals(alice, business!.id), language).toEqual([expect.objectContaining({ title: copy.goalTitle })]);
        const company = (await store.listCompanies(alice, 100)).items.find((item) => item.name === copy.companyName && item.businessId === business!.id);
        expect(company, language).toBeDefined();
        const agents = await store.listCompanyAgents(alice, company!.id);
        expect(agents, language).toHaveLength(5);
        const expectedLead = defaultLocalizedAgentProfiles(message)[0]!;
        expect(agents.find((agent) => agent.name === expectedLead.name), language).toMatchObject(expectedLead);
      }
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
    const conversation = await store.createNeutralConversation(alice, "Видалення компанії");
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
      const question = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Тепер видали її, для теста", conversationId: conversation.id, contextType: "company", companyId: company.id } });
      expect(question.statusCode).toBe(200);
      expect(question.body).toContain("Ви хочете видалити вибрану компанію");
      expect(question.body).toContain("Тестова студія");
      expect(question.body).not.toContain('"companyAction"');
      expect((await store.listCompanies(alice)).items).toHaveLength(1);
      expect(await store.listNeutralConversations(alice)).toHaveLength(1);
      expect(researchCalls).toBe(0);

      const confirmed = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Так, видали компанію Тестова студія", conversationId: conversation.id, contextType: "company", companyId: company.id } });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.body).toContain('"companyAction":{"action":"delete"');
      expect((await store.listCompanies(alice)).items).toHaveLength(0);
      expect(await store.listNeutralConversations(alice)).toHaveLength(1);
      expect((await store.getNeutralConversation(alice, conversation.id)).messages).toHaveLength(4);
      expect(researchCalls).toBe(0);
    } finally { await app.close(); }
  });

  it("uses the selected company for a delete-everything reference", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Щойно створена компанія" }, "delete-everything-company");
    const conversation = await store.createNeutralConversation(alice, "Комплексне видалення");
    let chatCalls = 0;
    const aiEngine: AIEngine = {
      chat: async () => { chatCalls += 1; throw new Error("Selected-company deletion must be deterministic"); },
      async *stream() { chatCalls += 1; throw new Error("Selected-company deletion must be deterministic"); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const question = await app.inject({
        method: "POST",
        url: "/chat/stream",
        payload: {
          message: "тепер видали це все, що тільки що створив",
          conversationId: conversation.id,
          contextType: "company",
          companyId: company.id,
        },
      });
      expect(question.statusCode).toBe(200);
      expect(question.body).toContain("Ви хочете видалити вибрану компанію");
      expect(question.body).toContain("Щойно створена компанія");
      expect(question.body).not.toContain("Уточніть компанію");
      expect((await store.listCompanies(alice)).items).toHaveLength(1);
      expect(chatCalls).toBe(0);

      const confirmed = await app.inject({
        method: "POST",
        url: "/chat/stream",
        payload: {
          message: "Так, видали компанію Щойно створена компанія",
          conversationId: conversation.id,
          contextType: "company",
          companyId: company.id,
        },
      });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.body).toContain('"companyAction":{"action":"delete"');
      expect((await store.listCompanies(alice)).items).toHaveLength(0);
      expect(chatCalls).toBe(0);
    } finally { await app.close(); }
  });

  it("deletes the selected company and its linked business, goals, and memory in one confirmed request", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(alice, { name: "Тестова бізнес-ідея" });
    await store.createGoal(alice, business.id, { title: "Тестова ціль" });
    await store.createMemory(alice, business.id, { type: "business_fact", title: "Тестова пам’ять", content: "Тестовий контекст" });
    const company = await store.createCompany(alice, { name: "Тестова компанія", businessId: business.id }, "compound-delete-company");
    await store.createCompanyAgent(alice, company.id, { name: "Координатор", role: "Керівник" }, "compound-delete-agent");
    const conversation = await store.createNeutralConversation(alice, "Комплексне видалення");
    let chatCalls = 0;
    const aiEngine: AIEngine = {
      chat: async () => { chatCalls += 1; throw new Error("Compound deletion must not call an AI model"); },
      async *stream() { chatCalls += 1; throw new Error("Compound deletion must not call an AI model"); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/chat/stream",
        payload: {
          message: "так, видали компанію, і все що ти створив мені, ціль, меморі, і бузнес ідею також видали",
          conversationId: conversation.id,
          contextType: "company",
          companyId: company.id,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"companyAction":{"action":"delete"');
      expect(response.body).toContain('"businessAction":{"action":"delete"');
      expect(response.body).toContain('"goalAction":{"action":"delete"');
      expect(response.body).toContain('"workspaceAction":{"action":"memory.delete"');
      expect(response.body).toContain("Тестова компанія");
      expect(response.body).toContain("Тестова бізнес-ідея");
      expect((await store.listCompanies(alice)).items).toHaveLength(0);
      expect(await store.listUserBusinesses(alice)).toHaveLength(0);
      expect(await store.listUserGoals(alice)).toHaveLength(0);
      expect(await store.listUserMemories(alice)).toHaveLength(0);
      expect(chatCalls).toBe(0);
    } finally { await app.close(); }
  });

  it("does not recreate resources when an unconfirmed delete-all request mentions what was just created", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(alice, { name: "Щойно створена бізнес-ідея" });
    await store.createGoal(alice, business.id, { title: "Щойно створена ціль" });
    await store.createMemory(alice, business.id, { type: "business_fact", title: "Щойно створена пам’ять", content: "Тест" });
    const company = await store.createCompany(alice, { name: "Щойно створена компанія", businessId: business.id }, "delete-all-regression-company");
    const conversation = await store.createNeutralConversation(alice, "Видалення без повторного створення");
    let chatCalls = 0;
    const aiEngine: AIEngine = {
      chat: async () => { chatCalls += 1; throw new Error("Delete confirmation must not call an AI model"); },
      async *stream() { chatCalls += 1; throw new Error("Delete confirmation must not call an AI model"); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const question = await app.inject({
        method: "POST",
        url: "/chat/stream",
        payload: {
          message: "Я хочу щоб ти видалив усе що ти тільки що створив, компанію, ціль, бізнес ідею усе, потрібно видалити",
          conversationId: conversation.id,
          contextType: "company",
          companyId: company.id,
        },
      });
      expect(question.statusCode).toBe(200);
      expect(question.body).toContain("Ви хочете видалити компанію");
      expect(question.body).toContain("Щойно створена компанія");
      expect(question.body).toContain("Щойно створена бізнес-ідея");
      expect(question.body).not.toContain('"companyAction":{"action":"create"');
      expect(question.body).not.toContain('"businessAction":{"action":"create"');
      expect((await store.listCompanies(alice)).items).toHaveLength(1);
      expect(await store.listUserBusinesses(alice)).toHaveLength(1);
      expect(await store.listUserGoals(alice)).toHaveLength(1);
      expect(await store.listUserMemories(alice)).toHaveLength(1);
      expect(chatCalls).toBe(0);

      const confirmed = await app.inject({
        method: "POST",
        url: "/chat/stream",
        payload: {
          message: "Так, видали компанію Щойно створена компанія, бізнес-ідею Щойно створена бізнес-ідея, її цілі та меморі",
          conversationId: conversation.id,
          contextType: "company",
          companyId: company.id,
        },
      });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.body).toContain('"companyAction":{"action":"delete"');
      expect(confirmed.body).toContain('"businessAction":{"action":"delete"');
      expect((await store.listCompanies(alice)).items).toHaveLength(0);
      expect(await store.listUserBusinesses(alice)).toHaveLength(0);
      expect(await store.listUserGoals(alice)).toHaveLength(0);
      expect(await store.listUserMemories(alice)).toHaveLength(0);
      expect(chatCalls).toBe(0);
    } finally { await app.close(); }
  });

  it.each([
    ["en", "Yes, delete the company, business idea, goal, and memory"],
    ["uk", "Так, видали компанію, бізнес-ідею, ціль і меморі"],
    ["fr", "Oui, supprime l’entreprise, l’idée d’entreprise, l’objectif et la mémoire"],
    ["de", "Ja, lösche das Unternehmen, die Geschäftsidee, das Ziel und das Gedächtnis"],
    ["es", "Sí, elimina la empresa, la idea de negocio, el objetivo y la memoria"],
    ["it", "Sì, elimina l’azienda, l’idea imprenditoriale, l’obiettivo e la memoria"],
    ["pl", "Tak, usuń firmę, pomysł na biznes, cel i pamięć"],
    ["pt", "Sim, exclua a empresa, a ideia de negócio, a meta e a memória"],
    ["nl", "Ja, verwijder het bedrijf, het businessidee, het doel en het geheugen"],
    ["tr", "Evet, şirketi, iş fikrini, hedefi ve hafızayı sil"],
    ["ru", "Да, удали компанию, бизнес-идею, цель и память"],
    ["zh", "是的，删除公司、商业构想、目标和记忆"],
    ["ja", "はい、会社、ビジネスアイデア、目標、メモリを削除"],
    ["ko", "예, 회사, 비즈니스 아이디어, 목표, 메모리를 삭제"],
    ["ar", "نعم، احذف الشركة وفكرة العمل والهدف والذاكرة"],
    ["hi", "हाँ, कंपनी, व्यवसाय विचार, लक्ष्य और मेमोरी हटा दें"],
  ])("deletes all linked composite resources in %s", async (language, message) => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(alice, { name: `Business ${language}` });
    await store.createGoal(alice, business.id, { title: `Goal ${language}` });
    await store.createMemory(alice, business.id, { type: "business_fact", title: `Memory ${language}`, content: "Context" });
    const company = await store.createCompany(alice, { name: `Company ${language}`, businessId: business.id }, `compound-company-${language}`);
    const aiEngine: AIEngine = {
      chat: async () => { throw new Error("Multilingual compound deletion must not call an AI model"); },
      async *stream() { throw new Error("Multilingual compound deletion must not call an AI model"); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      expect(detectCompanyChatLanguage(message)).toBe(language);
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, contextType: "company", companyId: company.id } });
      expect(response.statusCode, language).toBe(200);
      expect(response.body, language).toContain('"companyAction":{"action":"delete"');
      expect(response.body, language).toContain('"businessAction":{"action":"delete"');
      expect(await store.listUserBusinesses(alice), language).toHaveLength(0);
      expect((await store.listCompanies(alice)).items, language).toHaveLength(0);
    } finally { await app.close(); }
  });

  it.each([
    ["en", "Delete everything you just created", "Do you want", "Yes, delete company Acme"],
    ["uk", "Тепер видали це все, що тільки що створив", "Ви хочете", "Так, видали компанію Acme"],
    ["fr", "Supprime tout ce que tu viens de créer", "Voulez-vous", "Oui, supprime l’entreprise Acme"],
    ["de", "Lösche alles, was du gerade erstellt hast", "Möchten Sie", "Ja, lösche das Unternehmen Acme"],
    ["es", "Elimina todo lo que acabas de crear", "¿Quieres", "Sí, elimina la empresa Acme"],
    ["it", "Elimina tutto ciò che hai appena creato per questa azienda", "Vuoi", "Sì, elimina l’azienda Acme"],
    ["pl", "Usuń wszystko, co właśnie utworzyłeś", "Czy chcesz", "Tak, usuń firmę Acme"],
    ["pt", "Exclua tudo o que acabou de criar", "Deseja", "Sim, exclua a empresa Acme"],
    ["nl", "Verwijder alles wat je zojuist hebt gemaakt", "Wil je", "Ja, verwijder bedrijf Acme"],
    ["tr", "Az önce oluşturduğun her şeyi sil", "Seçili", "Evet, Acme şirketini sil"],
    ["ru", "Удали всё, что только что создал", "Вы хотите", "Да, удали компанию Acme"],
    ["zh", "删除刚刚创建的全部内容", "您要删除", "是的，删除公司 Acme"],
    ["ja", "今作成したものをすべて削除して", "選択した会社", "はい、会社 Acme を削除"],
    ["ko", "방금 만든 모든 것을 삭제해", "선택한 회사", "예, 회사 Acme 삭제"],
    ["ar", "احذف كل ما أنشأته للتو", "هل تريد", "نعم، احذف الشركة Acme"],
    ["hi", "अभी बनाई गई सब चीज़ें हटा दें", "क्या आप", "हाँ, कंपनी Acme हटाएँ"],
  ])("confirms and deletes an implicitly selected company in %s", async (language, request, questionStart, confirmation) => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Acme" }, `delete-all-${language}`);
    expect(detectCompanyChatLanguage(request)).toBe(language);
    expect(CompanyChatActions.isPotentialMutationRequest(request)).toBe(true);
    const question = await CompanyChatActions.deleteConfirmationMessage(alice, store, request, company.id);
    expect(question).toContain(questionStart);
    expect(question).toContain("**Acme**");
    const action = await CompanyChatActions.buildDeterministicAction(alice, store, confirmation, company.id);
    expect(action).toContain('"action":"delete"');
    const result = await CompanyChatActions.extractAndExecute(alice, action!, store, `delete-all-${language}`, {
      requestMessage: confirmation,
      selectedCompanyId: company.id,
    });
    expect(result.companyAction?.action).toBe("delete");
    expect((await store.listCompanies(alice)).items).toHaveLength(0);
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
      const conversationId = response.json().conversationId as string;
      expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
      expect((await store.getNeutralConversation(alice, conversationId)).messages.map((item) => item.role)).toEqual(["user", "assistant"]);

      const streamed = await app.inject({
        method: "POST",
        url: "/chat/stream",
        headers: { "idempotency-key": "failure-company-stream" },
        payload: { message: "are you working in stream?", contextType: "company", companyId: company.id },
      });
      expect(streamed.statusCode).toBe(200);
      const streamConversationId = /"conversationId":"([0-9a-f-]{36})"/.exec(streamed.body)?.[1];
      expect(streamConversationId).toBeTruthy();
      expect((await store.getNeutralConversation(alice, streamConversationId!)).messages.map((item) => item.role)).toEqual(["user", "assistant"]);
      expect(await store.listNeutralConversations(alice)).toHaveLength(2);

      expect(response.body).not.toContain("ollama-cloud");
      expect(response.body).not.toContain("diagnostics");
      expect(response.body).not.toContain("HTTP 402");
    } finally { await app.close(); }
  });
});

describe("email action with malformed directive JSON", () => {
  it("is planned once more with the parser error", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Mail Co" }, "mail-co");
    const broken = "```email-action\n{\"actions\":[{\"action\":\"contact.upsert\",\"companyId\":\"" + company.id + "\" \"fields\":{}}]}\n```";
    const notes: number[] = [];
    const aiEngine: AIEngine = {
      chat: async (request) => {
        const retry = request.messages.some((item) => item.role === "system" && String(item.content).includes("email-action block was not valid JSON"));
        notes.push(retry ? 1 : 0);
        return { content: broken };
      },
      async *stream() { yield broken; },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Заблокуй відправника winner@lottery.example у пошті", contextType: "company", companyId: company.id } });
      expect(response.statusCode).toBe(200);
      expect(notes.filter(Boolean)).toHaveLength(1);
    } finally { await app.close(); }
  });
});
