import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { BusinessActionHandler } from "../apps/agent-api/src/business-action-handler";

const alice: AuthContext = { userId: "goal-assign-alice", workspaceId: "goal-assign-ws", permissions: ["owner"] };
const bob: AuthContext = { userId: "goal-assign-bob", workspaceId: "goal-assign-ws", permissions: ["owner"] };
const directive = (value: object) => "Done.\n```goal-action\n" + JSON.stringify(value) + "\n```";

describe("Goal agent assignment", () => {
  it("persists, disambiguates and clears a Company Agent assignee through the chat goal directive", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(alice, { name: "Assign Business", businessStage: "starting" });
    const goal = await store.createGoal(alice, business.id, { title: "Launch catalog" });
    const bakery = await store.createCompany(alice, { name: "Assign Bakery" }, "goal-assign-bakery");
    const studio = await store.createCompany(alice, { name: "Assign Studio" }, "goal-assign-studio");
    const lead = await store.createCompanyAgent(alice, bakery.id, { name: "Lead", role: "Manager", tools: [] }, "goal-assign-lead");
    await store.createCompanyAgent(alice, studio.id, { name: "Lead", role: "Designer", tools: [] }, "goal-assign-studio-lead");

    const ambiguous = await BusinessActionHandler.extractAndExecute(alice, directive({ action: "update", businessId: business.id, goalId: goal.id, goal: { assignedAgent: "Lead" } }), store);
    expect(ambiguous.goalAction).toBeUndefined();
    expect((await store.listGoals(alice, business.id))[0]?.assignedAgentId).toBeUndefined();

    const assigned = await BusinessActionHandler.extractAndExecute(alice, directive({ action: "update", businessId: business.id, goalId: "Launch catalog", goal: { assignedAgent: "lead", assignedCompany: "Assign Bakery" } }), store);
    expect(assigned.goalAction?.goal?.assignedAgentId).toBe(lead.id);
    expect((await store.listGoals(alice, business.id))[0]?.assignedAgentId).toBe(lead.id);

    // An unrelated update keeps the assignee; null removes it.
    await BusinessActionHandler.extractAndExecute(alice, directive({ action: "update", businessId: business.id, goalId: goal.id, goal: { priority: 1 } }), store);
    expect((await store.listGoals(alice, business.id))[0]).toMatchObject({ priority: 1, assignedAgentId: lead.id });
    await BusinessActionHandler.extractAndExecute(alice, directive({ action: "update", businessId: business.id, goalId: goal.id, goal: { assignedAgent: null } }), store);
    expect((await store.listGoals(alice, business.id))[0]?.assignedAgentId).toBeNull();
  });

  it("refuses an agent of another user's company at the store boundary", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(alice, { name: "Owned Business", businessStage: "starting" });
    const foreignCompany = await store.createCompany(bob, { name: "Foreign Co" }, "goal-assign-foreign");
    const foreignAgent = await store.createCompanyAgent(bob, foreignCompany.id, { name: "Lead", role: "Manager", tools: [] }, "goal-assign-foreign-agent");
    await expect(store.createGoal(alice, business.id, { title: "Leak", assignedAgentId: foreignAgent.id })).rejects.toThrow();
    const goal = await store.createGoal(alice, business.id, { title: "Owned" });
    await expect(store.updateGoal(alice, business.id, goal.id, { assignedAgentId: foreignAgent.id })).rejects.toThrow();
    const viaChat = await BusinessActionHandler.extractAndExecute(alice, directive({ action: "update", businessId: business.id, goalId: goal.id, goal: { assignedAgent: foreignAgent.id } }), store);
    expect(viaChat.goalAction).toBeUndefined();
  });
});

it("shows stored market, audience and services of owned businesses to the chat model", () => {
  const prompt = BusinessActionHandler.buildSystemPrompt([{ id: "b1", name: "Profile Biz", businessStage: "operating", market: "Kyiv", country: "Ukraine", audienceSummary: "local families and small offices", productsServicesSummary: "sourdough bread, coffee, office catering" } as never]);
  expect(prompt).toContain('Market: "Kyiv"');
  expect(prompt).toContain("office catering");
  expect(prompt).toContain("small offices");
});
