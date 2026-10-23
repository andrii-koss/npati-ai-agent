import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { WorkspaceChatActions } from "../apps/agent-api/src/workspace-chat-actions";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("webhooks from chat", () => {
  it("recognizes webhook and integration requests as workspace actions", () => {
    expect(WorkspaceChatActions.isManagementRequest("Створи вебхук «Нові замовлення», який передає дані агентці Ірині")).toBe(true);
    expect(WorkspaceChatActions.isManagementRequest("Disable the new orders webhook")).toBe(true);
    expect(WorkspaceChatActions.isManagementRequest("Які інтеграції підключені до пекарні?")).toBe(true);
  });

  it("creates, disables and deletes a company webhook without exposing its secret", async () => {
    const context: AuthContext = { workspaceId: "workspace-webhooks", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(context, { name: "Bakery" }, "bakery");
    const iryna = await store.createCompanyAgent(context, company.id, { name: "Ірина", role: "Підтримка" }, "iryna");
    let next = "";
    const directive = (value: object) => "```workspace-action\n" + JSON.stringify(value) + "\n```";
    const aiEngine: AIEngine = {
      chat: vi.fn(async () => ({ content: next })),
      async *stream() { yield next; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"],
      healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => ({ ...context }) }, aiEngine, marketplace });
    apps.push(app);
    const send = (message: string) => app.inject({ method: "POST", url: "/chat/stream", payload: { message, contextType: "company", companyId: company.id } });
    const list = async () => (await app.inject({ method: "GET", url: `/companies/${company.id}/webhooks` })).json().webhooks as Array<{ id: string; name: string; isActive: boolean; agentId: string | null }>;

    next = directive({ action: "webhook.create", companyId: company.id, webhook: { name: "Нові замовлення", promptTemplate: "Передай дані нового замовлення агентці для обробки", agentId: iryna.id } });
    const created = await send("Створи вебхук «Нові замовлення», який передає дані агентці Ірині");
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain("whsec_");
    expect(await list()).toEqual([expect.objectContaining({ name: "Нові замовлення", isActive: true, agentId: iryna.id })]);

    next = directive({ action: "webhook.update", companyId: company.id, webhookName: "Нові замовлення", webhook: { isActive: false } });
    await send("Вимкни вебхук «Нові замовлення»");
    expect((await list())[0]).toMatchObject({ isActive: false });

    next = directive({ action: "webhook.delete", companyId: company.id, webhookName: "Нові замовлення" });
    await send("Видали вебхук «Нові замовлення»");
    expect(await list()).toEqual([]);
  });
});

describe("enable and disable requests", () => {
  it("are workspace actions in English and Ukrainian", () => {
    expect(WorkspaceChatActions.isManagementRequest("Вимкни цю автоматизацію")).toBe(true);
    expect(WorkspaceChatActions.isManagementRequest("Turn off the weekly automation")).toBe(true);
  });
});

describe("activity from chat", () => {
  it("lists recent company runs with their status and failure reason", async () => {
    const context: AuthContext = { workspaceId: "workspace-activity", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage"] };
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(context, { name: "Bakery" }, "bakery-activity");
    const main = await store.createCompanyAgent(context, company.id, { name: "Олена", role: "COO" }, "olena-activity");
    await store.setCompanyMainAgent(context, company.id, main.id, company.revision);
    const run = await store.createCompanyAgentRun(context, company.id, { task: "Підготуй план постів", requestedMode: "single" } as never, "activity-run");
    await store.updateCompanyAgentRun(context, company.id, (run as { run?: { id: string } }).run?.id ?? (run as { id: string }).id, { status: "failed", errorCode: "TOOL_FORBIDDEN", errorMessage: "Agent may not use storage.company_memory" } as never);
    const result = await WorkspaceChatActions.extractAndExecute(context, "```workspace-action\n" + JSON.stringify({ action: "activity.list", companyId: company.id, intro: "Останні дії:" }) + "\n```", { store } as never, "activity-conversation", { requestMessage: "Покажи останні дії в Activity", selectedCompanyId: company.id });
    expect(result.cleanText).toContain("Підготуй план постів");
    expect(result.cleanText).toContain("TOOL_FORBIDDEN");
    expect(result.cleanText).toContain("storage.company_memory");
  });
});

describe("questions and research mentioning workspace records", () => {
  it("are not planned as workspace actions", () => {
    expect(WorkspaceChatActions.isManagementRequest("Wechsel zu Deutsch: Welche Ziele hat die Bäckerei gerade?")).toBe(false);
    expect(WorkspaceChatActions.isManagementRequest("Recherchiere zwei echte deutsche Bäckerei-Websites und nenne drei Designideen für unsere Startseite, mit Quellen.")).toBe(false);
    expect(WorkspaceChatActions.isManagementRequest("Яка зараз ситуація по цілі 350 замовлень? Встанови поточне значення 120.")).toBe(true);
    expect(WorkspaceChatActions.isManagementRequest("Can you add a goal for 100 customers?")).toBe(true);
  });
});
