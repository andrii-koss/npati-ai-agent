/**
 * One chat answer can save the same goal and memory twice: the Business Profile tool creates them with the Business,
 * and a separate goal or memory command in the same answer asks for them again. A record with the same title in the
 * same Business is updated, never duplicated.
 */
import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { BusinessActionHandler } from "../apps/agent-api/src/business-action-handler";
import { CompanyAutomationsRepository } from "../apps/agent-api/src/automations-repository";
import { ContentLibraryStore } from "../apps/agent-api/src/content-library-store";
import { WorkspaceChatActions } from "../apps/agent-api/src/workspace-chat-actions";

const auth: AuthContext = { userId: "user-no-duplicates", workspaceId: "ws-no-duplicates", permissions: ["workspace:read", "workspace:write", "business:manage"] };

async function businessWithProfileRecords() {
  const store = new InMemoryWorkspaceStore();
  const business = await store.createBusiness(auth, { name: "Тестова кав'ярня КаваПошта", businessStage: "idea" });
  // What the Business Profile tool created together with the Business.
  await store.createGoal(auth, business.id, { title: "Залучити перших 50 передплатників", targetValue: 50, targetUnit: "передплатників", status: "active", priority: 1 });
  await store.createMemory(auth, business.id, { type: "business_fact", title: "Тестовий запис", content: "Перший факт.", confidence: 1, source: "chat:business-profile" });
  return { store, business };
}

describe("chat does not duplicate a goal or a memory it already saved", () => {
  it("updates the goal with the same title instead of creating a second one", async () => {
    const { store, business } = await businessWithProfileRecords();
    const reply = `Ціль створено.\n\`\`\`goal-action\n${JSON.stringify({ action: "create", businessId: business.id, goal: { title: "залучити перших 50 передплатників", targetValue: 60, targetUnit: "передплатників" } })}\n\`\`\``;
    await BusinessActionHandler.extractAndExecute(auth, reply, store);
    const goals = await store.listGoals(auth, business.id);
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ title: "Залучити перших 50 передплатників", targetValue: 60 });
  });

  it("updates the memory with the same title instead of creating a second one", async () => {
    const { store, business } = await businessWithProfileRecords();
    const deps = { store, automations: new CompanyAutomationsRepository(), content: new ContentLibraryStore(store), runCompany: async () => { throw new Error("not used"); }, cancelCompanyRun: async () => { throw new Error("not used"); } };
    const reply = `Готово.\n\n\`\`\`workspace-action\n${JSON.stringify({ action: "memory.create", businessId: business.id, memory: { type: "business_fact", title: "ТЕСТОВИЙ ЗАПИС", content: "Оновлений факт.", confidence: 0.9 } })}\n\`\`\``;
    await WorkspaceChatActions.extractAndExecute(auth, reply, deps as never, "memory-again");
    const memories = await store.listMemory(auth, business.id);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ title: "Тестовий запис", content: "Оновлений факт.", confidence: 0.9 });
  });

  it("still creates a goal and a memory with a new title", async () => {
    const { store, business } = await businessWithProfileRecords();
    await BusinessActionHandler.extractAndExecute(auth, `\`\`\`goal-action\n${JSON.stringify({ action: "create", businessId: business.id, goal: { title: "Відкрити другу точку" } })}\n\`\`\``, store);
    const deps = { store, automations: new CompanyAutomationsRepository(), content: new ContentLibraryStore(store), runCompany: async () => { throw new Error("not used"); }, cancelCompanyRun: async () => { throw new Error("not used"); } };
    await WorkspaceChatActions.extractAndExecute(auth, `\`\`\`workspace-action\n${JSON.stringify({ action: "memory.create", businessId: business.id, memory: { type: "business_fact", title: "Постачальник зерна", content: "Кава з Ефіопії." } })}\n\`\`\``, deps as never, "memory-new");
    expect((await store.listGoals(auth, business.id)).map((goal) => goal.title).sort()).toEqual(["Відкрити другу точку", "Залучити перших 50 передплатників"]);
    expect((await store.listMemory(auth, business.id)).map((memory) => memory.title).sort()).toEqual(["Постачальник зерна", "Тестовий запис"]);
  });
});

describe("one chat turn: a business idea with a goal and a memory", () => {
  it("keeps only the goal and memory saved with the Business when the model also asks for another one", async () => {
    const { buildApp } = await import("../apps/agent-api/src/app");
    const store = new InMemoryWorkspaceStore();
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as never;
    const ai = {
      supportsNativeTools: () => true,
      chat: async (request: { tools?: unknown[]; messages: Array<{ role: string }> }) => {
        if (!request.tools?.length) return { content: "NO_ACTION" };
        // The step follows the tool results already in the conversation (planning calls before the loop carry none).
        const step = request.messages.filter((message) => message.role === "tool").length + 1;
        // 1: the Business with its goal and memory; 2: the model asks again for a different goal and memory.
        if (step === 1) return { content: "", toolCalls: [{ id: "profile", type: "function", function: { name: "npati_business_profile", arguments: JSON.stringify({
          action: "create", profile: { name: "Тестова кав'ярня", businessStage: "idea", description: "Кава на виніс біля бізнес-центрів." },
          goals: [{ title: "Залучити перших 50 постійних клієнтів", targetValue: 50, targetUnit: "клієнтів" }],
          memories: [{ type: "business_fact", title: "Тестова точка біля бізнес-центру", content: "Кав'ярня на виніс." }],
        }) } }] };
        if (step === 2 && request.messages.at(-1)?.role === "tool") return { content: "", toolCalls: [
          { id: "goal", type: "function", function: { name: "npati_goal_action", arguments: JSON.stringify({ action: "create", title: "Запустити точку за 60 днів", targetValue: 60, targetUnit: "днів" }) } },
          { id: "memory", type: "function", function: { name: "npati_workspace_action", arguments: JSON.stringify({ action: "memory.create", memory: { type: "business_fact", title: "Інший факт", content: "Зайвий запис." } }) } },
        ] };
        return { content: "Бізнес-ідею створено." };
      },
      async *stream() { throw new Error("native tools are used"); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai as never, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "створи тестову бізнес ідею із цілю і меморі", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      const [business] = await store.listUserBusinesses(auth);
      expect(business?.name).toBe("Тестова кав'ярня");
      expect((await store.listGoals(auth, business!.id)).map((goal) => goal.title)).toEqual(["Залучити перших 50 постійних клієнтів"]);
      expect((await store.listMemory(auth, business!.id)).map((memory) => memory.title)).toEqual(["Тестова точка біля бізнес-центру"]);
    } finally { await app.close(); }
  }, 60_000);
});
