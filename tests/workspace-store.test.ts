import { ContextBuilder } from "@npati/agent";
import type { HubClient } from "@npati/hub-connector";
import { defaultSkillRegistry } from "@npati/skills";
import { InMemoryWorkspaceStore, WorkspaceAccessError, type AuthContext } from "@npati/workspace";
import { describe, expect, it } from "vitest";

const owner: AuthContext = { userId: "user-a", workspaceId: "workspace-a", permissions: ["owner"] };
const outsider: AuthContext = { userId: "user-b", workspaceId: "workspace-b", permissions: ["owner"] };
const hub: HubClient = {
  getConnections: async () => [{ provider: "wordpress", connected: false, status: "not_configured" }],
  getCapabilities: async () => [],
  createSocialDraft: async () => undefined,
  scheduleSocialPost: async () => undefined,
  createListing: async () => undefined,
  createWordPressDraft: async () => undefined,
  publishWordPressPost: async () => undefined,
  healthCheck: async () => ({ status: "not_configured" }),
};

describe("business workspace repository", () => {
  it("supports business CRUD and current business selection", async () => {
    const store = new InMemoryWorkspaceStore();
    const first = await store.createBusiness(owner, { name: "First", businessStage: "starting" });
    const second = await store.createBusiness(owner, { name: "Second", businessStage: "growing" });
    expect((await store.overview(owner)).currentBusiness?.id).toBe(first.id);
    await store.setCurrentBusiness(owner, second.id);
    expect((await store.overview(owner)).currentBusiness?.id).toBe(second.id);
    expect((await store.updateBusiness(owner, second.id, { niche: "Sustainable retail" })).niche).toBe("Sustainable retail");
    await store.deleteBusiness(owner, first.id);
    expect(await store.listBusinesses(owner)).toHaveLength(1);
  });

  it("isolates business data by workspace and conversations by user", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(owner, { name: "Private business" });
    await expect(store.getBusiness(outsider, business.id)).rejects.toBeInstanceOf(WorkspaceAccessError);
    await expect(store.listGoals(outsider, business.id)).rejects.toBeInstanceOf(WorkspaceAccessError);
    await expect(store.listMemory(outsider, business.id)).rejects.toBeInstanceOf(WorkspaceAccessError);
    const conversation = await store.createConversation(owner, business.id, "Owner thread");
    await store.appendMessage(owner, business.id, conversation.id, "user", "Private message");
    const colleague = { ...owner, userId: "user-c" };
    expect(await store.listConversations(colleague, business.id)).toEqual([]);
    await expect(store.getConversation(colleague, business.id, conversation.id)).rejects.toBeInstanceOf(WorkspaceAccessError);
  });

  it("renames and deletes only the owner's conversation", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(owner, { name: "Conversation workspace" });
    const conversation = await store.createConversation(owner, business.id, "First title");
    await store.appendMessage(owner, business.id, conversation.id, "user", "Keep this private");
    expect((await store.updateConversation(owner, business.id, conversation.id, "Planning")).title).toBe("Planning");
    await expect(store.updateConversation({ ...owner, userId: "user-c" }, business.id, conversation.id, "No access")).rejects.toBeInstanceOf(WorkspaceAccessError);
    expect(await store.deleteConversation(owner, business.id, conversation.id)).toBe(true);
    expect(await store.listConversations(owner, business.id)).toEqual([]);
  });

  it("persists goals and memory while rejecting secrets", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(owner, { name: "Commerce Lab" });
    const goal = await store.createGoal(owner, business.id, { title: "Reach 20 qualified leads", priority: 1 });
    expect((await store.updateGoal(owner, business.id, goal.id, { status: "completed" })).status).toBe("completed");
    const memory = await store.createMemory(owner, business.id, { type: "audience", title: "Primary audience", content: "Independent retailers" });
    expect(await store.listMemory(owner, business.id, "retail")).toMatchObject([{ id: memory.id }]);
    await expect(store.createMemory(owner, business.id, { type: "other", title: "Credential", content: "sk-1234567890abcdefghijkl" })).rejects.toThrow(/Secrets/);
    await store.deleteMemory(owner, business.id, memory.id);
    expect(await store.listMemory(owner, business.id)).toEqual([]);
  });

  it("builds bounded business context", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(owner, { name: "Growth Shop", businessStage: "growing" });
    for (let index = 0; index < 7; index += 1) await store.createGoal(owner, business.id, { title: "Goal " + index, status: "active", priority: index });
    await store.createGoal(owner, business.id, { title: "Old goal", status: "completed" });
    await store.createMemory(owner, business.id, { type: "audience", title: "Audience", content: "Local makers and creators" });
    const builder = new ContextBuilder({ store, hub, skills: defaultSkillRegistry, getAIContext: async () => ({ mode: "automatic", model: "auto" }) });
    const context = await builder.build(owner, business.id, "How do I grow with local creators?");
    expect(context.business?.id).toBe(business.id);
    expect(context.goals).toHaveLength(5);
    expect(context.goals.every((goal) => goal.status === "active")).toBe(true);
    expect(context.memory[0]?.content).toContain("creators");
    expect(context.selectedSkill?.id).toBe("business-growth");
    expect(context.connections[0]).toMatchObject({ provider: "wordpress", connected: false });
    expect(context.ai).toEqual({ mode: "automatic", model: "auto" });
  });

  it("persists draft onboarding progress and activates only after confirmation", async () => {
    const store = new InMemoryWorkspaceStore();
    let session = await store.startOnboarding(owner, "seller");
    expect((await store.overview(owner)).currentBusiness).toBeNull();
    expect(await store.listBusinesses(owner)).toEqual([]);
    session = await store.advanceOnboarding(owner, session.id, { value: "A handmade oak chair", businessPatch: { productsServicesSummary: "A handmade oak chair", audienceSummary: "Home owners" } });
    expect(session.business.productsServicesSummary).toBe("A handmade oak chair");
    session = await store.setOnboardingStatus(owner, session.id, "paused");
    expect((await store.getOnboarding(owner))?.status).toBe("paused");
    session = await store.setOnboardingStatus(owner, session.id, "active");
    session = await store.advanceOnboarding(owner, session.id, { value: "Make the first 100 sales." });
    expect(session.status).toBe("awaiting_confirmation");
    await store.completeOnboarding(owner, session.id);
    expect((await store.overview(owner)).currentBusiness).toMatchObject({ activationStatus: "active", productsServicesSummary: "A handmade oak chair" });
    expect(await store.getOnboarding(owner)).toBeNull();
  });

  it("isolates onboarding sessions between workspaces", async () => {
    const store = new InMemoryWorkspaceStore();
    const session = await store.startOnboarding(owner, "starting");
    expect(await store.getOnboarding(outsider)).toBeNull();
    await expect(store.advanceOnboarding(outsider, session.id, { value: "Foreign answer" })).rejects.toBeInstanceOf(WorkspaceAccessError);
  });
});

describe("skill registry", () => {
  it("selects startup, growth, and selling skills", () => {
    expect(defaultSkillRegistry.list().map((skill) => skill.id)).toEqual(["competitor-analysis", "web-research", "business-startup", "business-growth", "sell-product"]);
    expect(defaultSkillRegistry.select({ userMessage: "Analyze my competitors" })?.id).toBe("competitor-analysis");
    expect(defaultSkillRegistry.select({ userMessage: "Analyze https://example.com" })?.id).toBe("web-research");
    expect(defaultSkillRegistry.select({ userMessage: "help me start a business" })?.id).toBe("business-startup");
    expect(defaultSkillRegistry.select({ userMessage: "grow my customer base", businessStage: "growing" })?.id).toBe("business-growth");
    expect(defaultSkillRegistry.select({ userMessage: "I want to sell this product" })?.id).toBe("sell-product");
  });
});
