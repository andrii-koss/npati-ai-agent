import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext, type CompanyAgentRunDetails } from "@npati/workspace";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { CompanyAutomationsRepository } from "../apps/agent-api/src/automations-repository";
import { ContentLibraryStore } from "../apps/agent-api/src/content-library-store";
import { WorkspaceChatActions, type WorkspaceChatActionDependencies } from "../apps/agent-api/src/workspace-chat-actions";
import { stripInternalChatActions } from "../apps/web/src/ChatMessageContent";
import { buildApp } from "../apps/agent-api/src/app";

const alice: AuthContext = { userId: "alice-workspace-actions", workspaceId: "shared-workspace-actions", permissions: ["workspace:read", "business:manage"] };
const bob: AuthContext = { userId: "bob-workspace-actions", workspaceId: "shared-workspace-actions", permissions: ["workspace:read", "business:manage"] };
const directive = (value: object) => `Unverified text\n\n\`\`\`workspace-action\n${JSON.stringify(value)}\n\`\`\``;

function completedRun(companyId: string, task: string, result = "Completed result"): CompanyAgentRunDetails {
  const now = new Date().toISOString();
  return {
    run: {
      id: `run-${Math.random()}`, workspaceId: alice.workspaceId, companyId, userId: alice.userId, mainAgentId: "agent-1",
      idempotencyKey: "test", task, requestedMode: "auto", executionMode: "single", status: "completed", selectedAgentIds: ["agent-1"],
      result, cancelRequested: false, attemptCount: 1, maxAttempts: 1, nextAttemptAt: now, totalDurationMs: 42, createdAt: now, updatedAt: now,
    },
    steps: [], toolAudit: [], backgroundEvents: [],
  };
}

function dependencies(store: InMemoryWorkspaceStore, automations: CompanyAutomationsRepository, runCompany: WorkspaceChatActionDependencies["runCompany"]): WorkspaceChatActionDependencies {
  return { store, automations, content: new ContentLibraryStore(store), runCompany, cancelCompanyRun: async (_auth, companyId, runId) => completedRun(companyId, `Cancel ${runId}`) };
}

describe("workspace resources from chat", () => {
  it("recognizes explicit requests across supported scripts", () => {
    for (const message of [
      "Create an automation for my company",
      "Створи тестову автоматизацію на сторінці Automations & Scheduled Tasks",
      "Створи автоматизацію для моєї компанії",
      "Crée une automatisation pour mon entreprise",
      "Erstelle eine Automatisierung für mein Unternehmen",
      "Crea una automatización para mi empresa",
      "Crea una automazione per la mia azienda",
      "Utwórz automatyzację dla mojej firmy",
      "Crie uma automação para minha empresa",
      "Maak een automatisering voor mijn bedrijf",
      "Şirketim için otomasyon oluştur",
      "Создай автоматизацию для моей компании",
      "创建一个定时任务",
      "自動化を作成してください",
      "자동화를 생성해 주세요",
      "أنشئ مهمة مجدولة",
      "एक निर्धारित कार्य बनाएं",
    ]) expect(WorkspaceChatActions.isManagementRequest(message)).toBe(true);
    for (const message of [
      "Delete this automation", "Видали цю автоматизацію", "Supprime cette automatisation", "Lösche diese Automatisierung",
      "Elimina esta automatización", "Elimina questa automazione", "Usuń tę automatyzację", "Exclua esta automação",
      "Verwijder deze automatisering", "Bu otomasyonu sil", "Удалить эту автоматизацию", "删除此自动化",
      "この自動化を削除", "이 자동화를 삭제", "احذف هذه الأتمتة", "यह ऑटोमेशन हटाएं",
    ]) expect(WorkspaceChatActions.isManagementRequest(message)).toBe(true);
    expect(WorkspaceChatActions.isManagementRequest("Explain what an automation is")).toBe(false);
  });

  it("shows the newest and the named company to the planner when more than 30 companies exist", async () => {
    const store = new InMemoryWorkspaceStore();
    for (let index = 0; index < 34; index += 1) await store.createCompany(alice, { name: `Old Company ${index}` }, `old-${index}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const bakery = await store.createCompany(alice, { name: "Sunflower Bakery" }, "bakery");
    const prompt = await WorkspaceChatActions.buildSystemPrompt(alice, store, "Create an automation for the bakery: every Monday at 9:00 plan posts");
    expect(prompt).toContain(bakery.id);
    const selected = (await store.listCompanies(alice, 1)).items[0]!;
    const selectedPrompt = await WorkspaceChatActions.buildSystemPrompt(alice, store, "Create an automation every Monday", selected.id);
    expect(selectedPrompt.indexOf(selected.id)).toBeLessThan(selectedPrompt.indexOf(bakery.id));
  });

  it("does not treat company or business profile fields (brand tone, audience) as a workspace resource", () => {
    for (const message of [
      "Створи компанію «Пекарня Сонях» — крафтова пекарня на Подолі. Тон бренду теплий і дружній. Мови: українська та англійська.",
      "Create a company Nordic Fit, brand voice energetic, audience professionals aged 25-40",
      "Cria uma empresa Café Lisboa com voz da marca acolhedora",
    ]) expect(WorkspaceChatActions.isManagementRequest(message)).toBe(false);
    expect(WorkspaceChatActions.isManagementRequest("Запам'ятай тон бренду компанії: теплий і дружній")).toBe(true);
    expect(WorkspaceChatActions.isManagementRequest("Save our brand voice: warm and friendly")).toBe(true);
    expect(WorkspaceChatActions.isManagementRequest("Створи автоматизацію для компанії: щопонеділка план постів")).toBe(true);
  });

  it("creates a validated automation for an owned company", async () => {
    const store = new InMemoryWorkspaceStore();
    const automations = new CompanyAutomationsRepository();
    const company = await store.createCompany(alice, { name: "Alice Studio" }, "alice-company");
    const deps = dependencies(store, automations, async (_auth, companyId, input) => completedRun(companyId, input.task));
    const result = await WorkspaceChatActions.extractAndExecute(alice, directive({
      action: "automation.create", companyId: company.id, intro: "Готово, автоматизацію створено.", followUp: "Створити ще щотижневий звіт?",
      automation: { name: "Ранковий звіт", prompt: "Підготуй звіт", cronExpression: "0 9 * * 1", timezone: "Europe/Kyiv" },
    }), deps, "conversation-automation", { requestMessage: "Створи автоматизацію" });
    expect(result.workspaceAction).toEqual(expect.objectContaining({ action: "automation.create", companyId: company.id }));
    expect(result.cleanText).toContain("```card:Ранковий звіт");
    expect(result.cleanText).toContain("/settings/automations");
    expect(await automations.list(alice, company.id)).toEqual([expect.objectContaining({ cronExpression: "0 9 * * 1", prompt: "Підготуй звіт" })]);
  });

  it("creates durable memory only in the selected owned business", async () => {
    const store = new InMemoryWorkspaceStore();
    const automations = new CompanyAutomationsRepository();
    const business = await store.createBusiness(alice, { name: "Alice Idea", businessStage: "idea" });
    const deps = dependencies(store, automations, async (_auth, companyId, input) => completedRun(companyId, input.task));
    const result = await WorkspaceChatActions.extractAndExecute(alice, directive({
      action: "memory.create", intro: "已保存到业务记忆。", followUp: "要添加品牌语气规则吗？",
      memory: { type: "audience", title: "主要受众", content: "面向乌克兰的小型电商企业。", confidence: 1 },
    }), deps, "conversation-memory", { requestMessage: "保存受众信息", selectedBusinessId: business.id });
    expect(result.workspaceAction).toEqual(expect.objectContaining({ action: "memory.create", businessId: business.id }));
    expect(result.cleanText).toContain("已保存到业务记忆");
    expect(result.cleanText).toContain("**类型:** audience");
    expect(result.cleanText).toContain("**业务:** Alice Idea");
    expect(result.cleanText).toContain("/settings/memory");
    expect(await store.listMemory(alice, business.id)).toEqual([expect.objectContaining({ title: "主要受众", type: "audience" })]);
  });

  it("recognizes deletion of a Settings Memory record in chat", () => {
    const request = "\u041d\u0430 \u0441\u0442\u043e\u0440\u0456\u043d\u0446\u0456 https://ai.npati.com/settings/memory \u0454 \u043c\u0435\u043c\u043e\u0440\u0456, \u043c\u043e\u0436\u0435\u0448 \u0432\u0438\u0434\u0430\u043b\u0438\u0442\u0438 \u0439\u043e\u0433\u043e?";
    expect(WorkspaceChatActions.isBusinessMemoryDeletionRequest(request)).toBe(true);
    expect(WorkspaceChatActions.isManagementRequest(request)).toBe(true);
    expect(WorkspaceChatActions.noSavedMemoryMessage(request)).toContain("\u043d\u0435 \u0437\u043d\u0430\u0439\u0448\u043e\u0432");
    expect(WorkspaceChatActions.isBusinessMemoryDeletionRequest("Delete company memory")).toBe(false);
  });

  it("removes goals and memory when their business is deleted", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(alice, { name: "Expired idea", businessStage: "idea" });
    await store.createMemory(alice, business.id, { type: "business_fact", title: "Core focus", content: "Automation" });
    await store.createGoal(alice, business.id, { title: "Launch" });
    await store.deleteBusiness(alice, business.id);
    expect(await store.listUserMemories(alice)).toHaveLength(0);
    expect(await store.listUserGoals(alice)).toHaveLength(0);
  });
  it("deletes the only owned Business Memory record without a selected business", async () => {
    const store = new InMemoryWorkspaceStore();
    const first = await store.createBusiness(alice, { name: "First idea", businessStage: "idea" });
    const second = await store.createBusiness(alice, { name: "Second idea", businessStage: "idea" });
    const memory = await store.createMemory(alice, second.id, { type: "business_fact", title: "Core focus", content: "Automation" });
    const deps = dependencies(store, new CompanyAutomationsRepository(), async (_auth, companyId, input) => completedRun(companyId, input.task));

    const deleted = await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "memory.delete", intro: "Deleted." }), deps, "delete-only-memory", { requestMessage: "Delete the memory on Settings > Memory" });
    expect(deleted.workspaceAction).toMatchObject({ action: "memory.delete", resourceId: memory.id, businessId: second.id });
    expect(await store.listMemory(alice, second.id)).toHaveLength(0);
    expect(await store.listMemory(alice, first.id)).toHaveLength(0);
  });

  it("keeps multiple Business Memory records when deletion has no unique target", async () => {
    const store = new InMemoryWorkspaceStore();
    const first = await store.createBusiness(alice, { name: "First idea", businessStage: "idea" });
    const second = await store.createBusiness(alice, { name: "Second idea", businessStage: "idea" });
    await store.createMemory(alice, first.id, { type: "business_fact", title: "First fact", content: "First" });
    await store.createMemory(alice, second.id, { type: "business_fact", title: "Second fact", content: "Second" });
    const deps = dependencies(store, new CompanyAutomationsRepository(), async (_auth, companyId, input) => completedRun(companyId, input.task));

    const result = await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "memory.delete", intro: "Deleted." }), deps, "ambiguous-memory", { requestMessage: "Delete the memory" });
    expect(result.workspaceAction).toBeUndefined();
    expect(await store.listMemory(alice, first.id)).toHaveLength(1);
    expect(await store.listMemory(alice, second.id)).toHaveLength(1);
  });

  it("runs real company work for Activity and Content and returns verified cards", async () => {
    const store = new InMemoryWorkspaceStore();
    const automations = new CompanyAutomationsRepository();
    const company = await store.createCompany(alice, { name: "Run Studio" }, "run-company");
    const calls: string[] = [];
    const deps = dependencies(store, automations, async (_auth, companyId, input) => { calls.push(input.task); return completedRun(companyId, input.task, "## Generated output"); });
    const activity = await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "activity.run", companyId: company.id, intro: "Run completed.", activity: { title: "Market scan", task: "Analyze the market", mode: "pipeline" } }), deps, "conversation-activity", { requestMessage: "Run a market activity" });
    const content = await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "content.create", companyId: company.id, intro: "Article created.", content: { title: "AI Guide", type: "article", task: "Write an AI guide" } }), deps, "conversation-content", { requestMessage: "Create an article" });
    expect(activity.workspaceAction?.action).toBe("activity.run");
    expect(activity.cleanText).toContain("/settings/activity");
    expect(content.workspaceAction?.action).toBe("content.create");
    expect(content.cleanText).toContain("```card:AI Guide");
    expect(content.cleanText).toContain("/settings/content");
    expect(calls[0]).toBe("Analyze the market");
    expect(calls[1]).toMatch(/^\[NPATI_CONTENT:article:/);
  });

  it("updates and deletes owned automations, memory and content", async () => {
    const store = new InMemoryWorkspaceStore();
    const automations = new CompanyAutomationsRepository();
    const deps = dependencies(store, automations, async (_auth, companyId, input) => completedRun(companyId, input.task, "Original body"));
    const company = await store.createCompany(alice, { name: "Editable Studio" }, "editable-company");
    const mainAgent = await store.createCompanyAgent(alice, company.id, { name: "Lead", role: "Lead" }, "editable-main-agent");
    await store.setCompanyMainAgent(alice, company.id, mainAgent.id, company.revision);
    const business = await store.createBusiness(alice, { name: "Editable Business", businessStage: "idea" });
    const automation = await automations.create(alice, company.id, { name: "Old automation", prompt: "Old prompt", cronExpression: "0 8 * * *", agentId: mainAgent.id });
    const memory = await store.createMemory(alice, business.id, { type: "brand", title: "Old memory", content: "Old voice" });
    const contentRun = await store.createCompanyAgentRun(alice, company.id, { task: `[NPATI_CONTENT:article:${Buffer.from("Old article").toString("base64url")}] Write`, requestedMode: "auto" }, "content-update-run");
    await store.updateCompanyAgentRun(alice, company.id, contentRun.run.id, { status: "completed", result: "Original body" });

    const automationUpdate = await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "automation.update", companyId: company.id, automationId: automation.id, intro: "Updated.", automation: { name: "New automation", cronExpression: "0 10 * * *", status: "paused", agentId: null } }), deps, "edit-auto", { requestMessage: "Update automation" });
    const memoryUpdate = await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "memory.update", businessId: business.id, memoryId: memory.id, intro: "Updated.", memory: { title: "New memory", content: "New voice", confidence: 0.9 } }), deps, "edit-memory", { requestMessage: "Update memory" });
    const contentUpdate = await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "content.update", companyId: company.id, contentId: contentRun.run.id, intro: "Updated.", content: { title: "New article", type: "seo_blueprint", content: "Revised body" } }), deps, "edit-content", { requestMessage: "Update content" });
    expect(automationUpdate.workspaceAction?.action).toBe("automation.update");
    expect(await automations.get(alice, company.id, automation.id)).toEqual(expect.objectContaining({ name: "New automation", cronExpression: "0 10 * * *", status: "paused", agentId: null }));
    expect(memoryUpdate.workspaceAction?.action).toBe("memory.update");
    expect((await store.listMemory(alice, business.id))[0]).toEqual(expect.objectContaining({ title: "New memory", content: "New voice", confidence: 0.9 }));
    expect(contentUpdate.workspaceAction?.action).toBe("content.update");
    expect(await deps.content.get(alice, contentRun.run.id)).toEqual(expect.objectContaining({ title: "New article", type: "seo_structure", content: "Revised body", deleted: false }));

    expect((await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "automation.delete", companyId: company.id, automationId: automation.id, intro: "Deleted." }), deps, "delete-auto", { requestMessage: "Delete automation" })).workspaceAction?.action).toBe("automation.delete");
    expect((await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "memory.delete", businessId: business.id, memoryId: memory.id, intro: "Deleted." }), deps, "delete-memory", { requestMessage: "Delete memory" })).workspaceAction?.action).toBe("memory.delete");
    expect((await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "content.delete", companyId: company.id, contentId: contentRun.run.id, intro: "Deleted." }), deps, "delete-content", { requestMessage: "Delete content" })).workspaceAction?.action).toBe("content.delete");
    expect(await automations.list(alice, company.id)).toHaveLength(0);
    expect(await store.listMemory(alice, business.id)).toHaveLength(0);
    expect(await deps.content.get(alice, contentRun.run.id)).toEqual(expect.objectContaining({ deleted: true }));
  });

  it("cancels active activity but keeps completed audit traces immutable", async () => {
    const store = new InMemoryWorkspaceStore();
    const automations = new CompanyAutomationsRepository();
    const company = await store.createCompany(alice, { name: "Trace Studio" }, "trace-company");
    const mainAgent = await store.createCompanyAgent(alice, company.id, { name: "Lead", role: "Lead" }, "trace-main-agent");
    await store.setCompanyMainAgent(alice, company.id, mainAgent.id, company.revision);
    const queued = await store.createCompanyAgentRun(alice, company.id, { task: "Long activity", requestedMode: "auto" }, "long-activity");
    const deps = dependencies(store, automations, async (_auth, companyId, input) => completedRun(companyId, input.task));
    deps.cancelCompanyRun = async (auth, companyId, runId) => {
      await store.updateCompanyAgentRun(auth, companyId, runId, { status: "cancelled", cancelRequested: true });
      return store.getCompanyAgentRun(auth, companyId, runId);
    };
    const cancelled = await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "activity.cancel", companyId: company.id, intro: "Cancelled.", activity: { runId: queued.run.id } }), deps, "cancel-run", { requestMessage: "Cancel activity" });
    expect(cancelled.workspaceAction?.action).toBe("activity.cancel");
    expect((await store.getCompanyAgentRun(alice, company.id, queued.run.id)).run.status).toBe("cancelled");
    const rejected = await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "activity.cancel", companyId: company.id, activity: { runId: queued.run.id } }), deps, "cancel-again", { requestMessage: "Delete activity" });
    expect(rejected.workspaceAction).toBeUndefined();
  });

  it("rejects cross-user targets, invalid cron and hides the internal directive", async () => {
    const store = new InMemoryWorkspaceStore();
    const automations = new CompanyAutomationsRepository();
    const bobCompany = await store.createCompany(bob, { name: "Bob Studio" }, "bob-company");
    const bobBusiness = await store.createBusiness(bob, { name: "Bob Idea", businessStage: "idea" });
    let runCount = 0;
    const deps = dependencies(store, automations, async (_auth, companyId, input) => { runCount++; return completedRun(companyId, input.task); });
    const activity = await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "activity.run", companyId: bobCompany.id, activity: { task: "Take data" } }), deps, "bad-company", { requestMessage: "Create activity" });
    const memory = await WorkspaceChatActions.extractAndExecute(alice, directive({ action: "memory.create", businessId: bobBusiness.id, memory: { type: "brand", title: "Wrong", content: "Wrong" } }), deps, "bad-business", { requestMessage: "Save memory" });
    const invalidCron = await WorkspaceChatActions.extractAndExecute(bob, directive({ action: "automation.create", companyId: bobCompany.id, automation: { name: "Bad", prompt: "Run", cronExpression: "99 99 * * *" } }), deps, "bad-cron", { requestMessage: "Create automation" });
    expect(activity.workspaceAction).toBeUndefined();
    expect(memory.workspaceAction).toBeUndefined();
    expect(invalidCron.workspaceAction).toBeUndefined();
    expect(runCount).toBe(0);
    expect(await store.listMemory(bob, bobBusiness.id)).toHaveLength(0);
    expect(await automations.list(bob, bobCompany.id)).toHaveLength(0);
    const raw = directive({ action: "memory.create", businessId: bobBusiness.id });
    expect(stripInternalChatActions(raw, true)).toBe("Unverified text\n\n");
  });

  it("executes an automation directive through streamed chat without exposing internal JSON", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Stream Workspace" }, "stream-workspace-company");
    const output = directive({
      action: "automation.create", companyId: company.id, intro: "Automation created.", followUp: "Would you like a weekly version?",
      automation: { name: "Daily report", prompt: "Prepare the daily report", cronExpression: "0 9 * * *", timezone: "Europe/Kyiv" },
    });
    const aiEngine: AIEngine = {
      chat: async () => ({ content: output }), async *stream() { yield output.slice(0, 30); yield output.slice(30); },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Create an automation for my company", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"workspaceAction":{"action":"automation.create"');
      expect(response.body).toContain("Automation created.");
      expect(response.body).not.toContain("workspace-action");
      const list = await app.inject({ method: "GET", url: `/companies/${company.id}/automations` });
      expect(list.statusCode).toBe(200);
      expect(list.json().automations).toEqual([expect.objectContaining({ name: "Daily report", prompt: "Prepare the daily report" })]);
    } finally { await app.close(); }
  });

  it("turns an AI success claim into a persisted automation for the selected company", async () => {
    const store = new InMemoryWorkspaceStore();
    const firstCompany = await store.createCompany(alice, { name: "First Company" }, "automation-first-company");
    const selectedCompany = await store.createCompany(alice, { name: "Selected Company" }, "automation-selected-company");
    const output = directive({
      action: "automation.create",
      intro: "Готово, тестову автоматизацію створено.",
      followUp: "Бажаєте змінити час запуску?",
      automation: { name: "Тестова автоматизація", prompt: "Підготуй тестовий звіт", cronExpression: "0 9 * * *", timezone: "Europe/Kyiv" },
    });
    const aiEngine: AIEngine = {
      chat: async () => ({ content: output }), async *stream() { yield "Готово, я створив автоматизацію."; },
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
        payload: { message: "Створи тестову автоматизацію на сторінці Automations & Scheduled Tasks", contextType: "company", companyId: selectedCompany.id },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"workspaceAction":{"action":"automation.create"');
      expect(response.body).toContain(`/settings/automations?company=${selectedCompany.id}`);
      expect(response.body).not.toContain('"delta":"Готово, я створив автоматизацію."');
      const selectedList = await app.inject({ method: "GET", url: `/companies/${selectedCompany.id}/automations` });
      const firstList = await app.inject({ method: "GET", url: `/companies/${firstCompany.id}/automations` });
      expect(selectedList.json().automations).toEqual([expect.objectContaining({ name: "Тестова автоматизація", prompt: "Підготуй тестовий звіт" })]);
      expect(firstList.json().automations).toEqual([]);
    } finally { await app.close(); }
  });

  it("persists Content Hub edits and deletion through the server API", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(alice, { name: "Content API Studio" }, "content-api-company");
    const agent = await store.createCompanyAgent(alice, company.id, { name: "Writer", role: "Writer" }, "content-api-agent");
    await store.setCompanyMainAgent(alice, company.id, agent.id, company.revision);
    const created = await store.createCompanyAgentRun(alice, company.id, { task: "Write article", requestedMode: "auto" }, "content-api-run");
    await store.updateCompanyAgentRun(alice, company.id, created.run.id, { status: "completed", result: "Original" });
    const aiEngine: AIEngine = {
      chat: async () => ({ content: "ok" }), async *stream() { yield "ok"; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const update = await app.inject({ method: "PATCH", url: `/companies/${company.id}/content/${created.run.id}`, payload: { title: "Edited", type: "seo_structure", content: "Revised" } });
      expect(update.statusCode).toBe(200);
      const list = await app.inject({ method: "GET", url: "/content/overrides" });
      expect(list.json().overrides[created.run.id]).toEqual(expect.objectContaining({ title: "Edited", type: "seo_structure", content: "Revised", deleted: false }));
      const remove = await app.inject({ method: "DELETE", url: `/companies/${company.id}/content/${created.run.id}` });
      expect(remove.statusCode).toBe(204);
      const after = await app.inject({ method: "GET", url: "/content/overrides" });
      expect(after.json().overrides[created.run.id].deleted).toBe(true);
    } finally { await app.close(); }
  });

  it("creates and deletes Business Memory through the real business chat route", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(alice, { name: "Memory Business", businessStage: "operating" });
    let output = directive({ action: "memory.create", businessId: business.id, intro: "Пам’ять створено.", memory: { type: "audience", title: "Основна аудиторія", content: "Малі інтернет-магазини України", confidence: 1 } });
    const aiEngine: AIEngine = {
      chat: async () => ({ content: output }), async *stream() { yield output; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine, marketplace });
    try {
      const create = await app.inject({ method: "POST", url: "/chat", payload: { message: "Створи memory про мою аудиторію", contextType: "business", businessId: business.id } });
      expect(create.statusCode).toBe(200);
      expect(create.json().workspaceAction.action).toBe("memory.create");
      const saved = await store.listMemory(alice, business.id);
      expect(saved).toEqual([expect.objectContaining({ title: "Основна аудиторія", content: "Малі інтернет-магазини України" })]);

      output = directive({ action: "memory.delete", businessId: business.id, memoryId: saved[0]!.id, intro: "Пам’ять видалено." });
      const remove = await app.inject({ method: "POST", url: "/chat", payload: { message: "Видали її", conversationId: create.json().conversationId, contextType: "business", businessId: business.id } });
      expect(remove.statusCode).toBe(200);
      expect(remove.json().workspaceAction.action).toBe("memory.delete");
      expect(await store.listMemory(alice, business.id)).toHaveLength(0);
    } finally { await app.close(); }
  });
});
