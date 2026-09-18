import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { BusinessActionHandler } from "../apps/agent-api/src/business-action-handler";

const auth: AuthContext = { userId: "user-test", workspaceId: "ws-test", permissions: ["owner"] };

describe("BusinessActionHandler delete support", () => {
  it("deletes a business idea by businessId directive in chat", async () => {
    const store = new InMemoryWorkspaceStore();
    const b1 = await store.createBusiness(auth, { name: "Eco Cafe", businessStage: "starting" });
    const b2 = await store.createBusiness(auth, { name: "Tech Studio", businessStage: "operating" });

    expect(await store.listUserBusinesses(auth)).toHaveLength(2);

    const agentMessage = `Я успішно видалив бізнес-ідею "Eco Cafe" з вашого простору.
\`\`\`business-action
{
  "action": "delete",
  "businessId": "${b1.id}",
  "businessName": "Eco Cafe"
}
\`\`\``;

    let beforeDeleteCalled = false;
    const result = await BusinessActionHandler.extractAndExecute(
      auth,
      agentMessage,
      store,
      undefined,
      async (_ctx, bid) => {
        if (bid === b1.id) beforeDeleteCalled = true;
      }
    );

    expect(beforeDeleteCalled).toBe(true);
    expect(result.businessAction?.action).toBe("delete");
    expect(result.businessAction?.businessId).toBe(b1.id);
    expect(result.cleanText).toBe('Я успішно видалив бізнес-ідею "Eco Cafe" з вашого простору.');

    const remaining = await store.listUserBusinesses(auth);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.name).toBe("Tech Studio");
  });

  it("deletes a business idea by name when businessId is not specified", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.createBusiness(auth, { name: "Онлайн Курси", businessStage: "idea" });

    const agentMessage = `Бізнес-ідею «Онлайн Курси» видалено.
\`\`\`business-action
{
  "action": "delete",
  "businessName": "онлайн курси"
}
\`\`\``;

    const result = await BusinessActionHandler.extractAndExecute(auth, agentMessage, store);
    expect(result.businessAction?.action).toBe("delete");
    expect(result.businessAction?.business?.name).toBe("Онлайн Курси");
    expect(await store.listUserBusinesses(auth)).toHaveLength(0);
  });

  it("deletes a goal by goalId directive in chat", async () => {
    const store = new InMemoryWorkspaceStore();
    const b = await store.createBusiness(auth, { name: "Main Project", businessStage: "operating" });
    const g1 = await store.createGoal(auth, b.id, { title: "Запустити рекламу", priority: 1, status: "active" });
    const g2 = await store.createGoal(auth, b.id, { title: "Найняти дизайнера", priority: 2, status: "active" });

    expect(await store.listGoals(auth, b.id)).toHaveLength(2);

    const agentMessage = `Ціль "Запустити рекламу" видалено.
\`\`\`goal-action
{
  "action": "delete",
  "businessId": "${b.id}",
  "goalId": "${g1.id}"
}
\`\`\``;

    const result = await BusinessActionHandler.extractAndExecute(auth, agentMessage, store);
    expect(result.goalAction?.action).toBe("delete");
    expect(result.goalAction?.goalId).toBe(g1.id);
    expect(result.cleanText).toBe('Ціль "Запустити рекламу" видалено.');

    const remaining = await store.listGoals(auth, b.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.title).toBe("Найняти дизайнера");
  });

  it("deletes a goal by title when goalId is a title string", async () => {
    const store = new InMemoryWorkspaceStore();
    const b = await store.createBusiness(auth, { name: "Coffee Shop", businessStage: "starting" });
    await store.createGoal(auth, b.id, { title: "Купити кавомашину", priority: 2, status: "active" });

    const agentMessage = `Ціль видалено.
\`\`\`goal-action
{
  "action": "delete",
  "businessName": "Coffee Shop",
  "goalId": "Купити кавомашину"
}
\`\`\``;

    const result = await BusinessActionHandler.extractAndExecute(auth, agentMessage, store);
    expect(result.goalAction?.action).toBe("delete");
    expect(result.goalAction?.goal?.title).toBe("Купити кавомашину");

    const remaining = await store.listGoals(auth, b.id);
    expect(remaining).toHaveLength(0);
  });
});
