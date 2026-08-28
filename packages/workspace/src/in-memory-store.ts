import { randomUUID } from "node:crypto";
import { assertNoSecrets } from "@npati/memory";
import type { AuthContext, Business, BusinessInput, BusinessOnboardingSession, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview, WorkspaceStore } from "./types";
import { WorkspaceAccessError } from "./types";
import { ONBOARDING_FLOWS, onboardingBusinessPatch, onboardingPlaceholder } from "./onboarding";

const now = () => new Date().toISOString();
export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly identities = new Map<string, { displayName: string; workspaceName: string; role: string }>();
  private readonly businesses = new Map<string, Business>();
  private readonly current = new Map<string, string>();
  private readonly goals = new Map<string, Goal>();
  private readonly memories = new Map<string, MemoryItem>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, ConversationMessage>();
  private readonly onboardings = new Map<string, Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">>();

  async initialize(context?: AuthContext) {
    if (context) this.identities.set(`${context.workspaceId}:${context.userId}`, { displayName: "Dev User", workspaceName: "My Workspace", role: "owner" });
  }

  async health() { return "ok" as const; }

  private async ensure(context: AuthContext) {
    const key = `${context.workspaceId}:${context.userId}`;
    if (!this.identities.has(key)) await this.initialize(context);
    return this.identities.get(key)!;
  }

  private assertBusiness(context: AuthContext, businessId: string) {
    const business = this.businesses.get(businessId);
    if (!business || business.workspaceId !== context.workspaceId) throw new WorkspaceAccessError("Business is not available in this workspace");
    return business;
  }

  async overview(context: AuthContext): Promise<WorkspaceOverview> {
    const identity = await this.ensure(context);
    const businesses = await this.listBusinesses(context);
    let currentId = this.current.get(`${context.workspaceId}:${context.userId}`);
    if (!currentId && businesses.length > 0) {
      currentId = businesses[0]!.id;
      this.current.set(`${context.workspaceId}:${context.userId}`, currentId);
    }
    return {
      user: { id: context.userId, displayName: identity.displayName },
      workspace: { id: context.workspaceId, name: identity.workspaceName, role: identity.role },
      businesses,
      currentBusiness: businesses.find((business) => business.id === currentId) ?? null,
      onboarding: await this.getOnboarding(context),
    };
  }

  async setCurrentBusiness(context: AuthContext, businessId: string) {
    const business = this.assertBusiness(context, businessId);
    this.current.set(`${context.workspaceId}:${context.userId}`, businessId);
    return business;
  }

  async listBusinesses(context: AuthContext) {
    return [...this.businesses.values()].filter((business) => business.workspaceId === context.workspaceId && business.activationStatus === "active").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getBusiness(context: AuthContext, businessId: string) { return this.assertBusiness(context, businessId); }

  async createBusiness(context: AuthContext, input: BusinessInput) {
    await this.ensure(context);
    const timestamp = now();
    const business: Business = {
      id: randomUUID(), workspaceId: context.workspaceId, ownerUserId: context.userId,
      name: input.name.trim(), businessStage: input.businessStage ?? "starting", activationStatus: "active", createdAt: timestamp, updatedAt: timestamp,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    } as Business;
    if (!business.name) throw new Error("Business name is required");
    this.businesses.set(business.id, business);
    if ((await this.listBusinesses(context)).length === 1) this.current.set(`${context.workspaceId}:${context.userId}`, business.id);
    return business;
  }

  async updateBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>) {
    const current = this.assertBusiness(context, businessId);
    const updated = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), updatedAt: now() };
    if (!updated.name.trim()) throw new Error("Business name is required");
    this.businesses.set(businessId, updated);
    return updated;
  }

  async deleteBusiness(context: AuthContext, businessId: string) {
    this.assertBusiness(context, businessId);
    this.businesses.delete(businessId);
    for (const [id, goal] of this.goals) if (goal.businessId === businessId) this.goals.delete(id);
    for (const [id, memory] of this.memories) if (memory.businessId === businessId) this.memories.delete(id);
    for (const [id, conversation] of this.conversations) if (conversation.businessId === businessId) this.conversations.delete(id);
    if (this.current.get(`${context.workspaceId}:${context.userId}`) === businessId) this.current.delete(`${context.workspaceId}:${context.userId}`);
    return true;
  }

  async listGoals(context: AuthContext, businessId: string) {
    this.assertBusiness(context, businessId);
    return [...this.goals.values()].filter((goal) => goal.workspaceId === context.workspaceId && goal.businessId === businessId).sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt));
  }

  async createGoal(context: AuthContext, businessId: string, input: GoalInput) {
    this.assertBusiness(context, businessId);
    const timestamp = now();
    const goal: Goal = { id: randomUUID(), workspaceId: context.workspaceId, businessId, createdByUserId: context.userId, status: input.status ?? "active", priority: input.priority ?? 3, createdAt: timestamp, updatedAt: timestamp, ...input, title: input.title.trim() };
    if (!goal.title) throw new Error("Goal title is required");
    this.goals.set(goal.id, goal);
    return goal;
  }

  async updateGoal(context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>) {
    this.assertBusiness(context, businessId);
    const goal = this.goals.get(goalId);
    if (!goal || goal.workspaceId !== context.workspaceId || goal.businessId !== businessId) throw new WorkspaceAccessError("Goal is not available for this business");
    const updated = { ...goal, ...input, updatedAt: now() };
    this.goals.set(goalId, updated);
    return updated;
  }

  async deleteGoal(context: AuthContext, businessId: string, goalId: string) {
    await this.updateGoal(context, businessId, goalId, {});
    return this.goals.delete(goalId);
  }

  async listMemory(context: AuthContext, businessId: string, query = "", limit = 100) {
    this.assertBusiness(context, businessId);
    const needle = query.trim().toLowerCase();
    return [...this.memories.values()]
      .filter((item) => item.workspaceId === context.workspaceId && item.businessId === businessId && (!needle || `${item.type} ${item.title} ${item.content}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  async createMemory(context: AuthContext, businessId: string, input: MemoryInput) {
    this.assertBusiness(context, businessId); assertNoSecrets(input);
    const timestamp = now();
    const item: MemoryItem = { id: randomUUID(), workspaceId: context.workspaceId, businessId, userId: context.userId, source: input.source ?? "user", ...input, createdAt: timestamp, updatedAt: timestamp };
    this.memories.set(item.id, item);
    return item;
  }

  async updateMemory(context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>) {
    this.assertBusiness(context, businessId); assertNoSecrets(input);
    const item = this.memories.get(memoryId);
    if (!item || item.workspaceId !== context.workspaceId || item.businessId !== businessId) throw new WorkspaceAccessError("Memory is not available for this business");
    const updated = { ...item, ...input, updatedAt: now() };
    this.memories.set(memoryId, updated);
    return updated;
  }

  async deleteMemory(context: AuthContext, businessId: string, memoryId: string) {
    await this.updateMemory(context, businessId, memoryId, {});
    return this.memories.delete(memoryId);
  }

  async listConversations(context: AuthContext, businessId: string) {
    this.assertBusiness(context, businessId);
    return [...this.conversations.values()].filter((item) => item.workspaceId === context.workspaceId && item.businessId === businessId && item.userId === context.userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createConversation(context: AuthContext, businessId: string, title: string) {
    this.assertBusiness(context, businessId);
    const timestamp = now();
    const conversation: Conversation = { id: randomUUID(), workspaceId: context.workspaceId, businessId, userId: context.userId, title: title.trim().slice(0, 120) || "New conversation", createdAt: timestamp, updatedAt: timestamp };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async getConversation(context: AuthContext, businessId: string, conversationId: string) {
    this.assertBusiness(context, businessId);
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.workspaceId !== context.workspaceId || conversation.businessId !== businessId || conversation.userId !== context.userId) throw new WorkspaceAccessError("Conversation is not available for this business");
    const messages = [...this.messages.values()].filter((item) => item.conversationId === conversationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { conversation, messages };
  }

  async updateConversation(context: AuthContext, businessId: string, conversationId: string, title: string) {
    const { conversation } = await this.getConversation(context, businessId, conversationId);
    const updated = { ...conversation, title: title.trim().slice(0, 120) || "New conversation", updatedAt: now() };
    this.conversations.set(conversationId, updated);
    return updated;
  }

  async deleteConversation(context: AuthContext, businessId: string, conversationId: string) {
    await this.getConversation(context, businessId, conversationId);
    for (const [messageId, message] of this.messages) {
      if (message.conversationId === conversationId) this.messages.delete(messageId);
    }
    return this.conversations.delete(conversationId);
  }

  async appendMessage(context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string) {
    const { conversation } = await this.getConversation(context, businessId, conversationId);
    const message: ConversationMessage = { id: randomUUID(), conversationId, role, content, createdAt: now() };
    this.messages.set(message.id, message);
    this.conversations.set(conversationId, { ...conversation, updatedAt: message.createdAt });
    return message;
  }

  private hydrateOnboarding(row: Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">): BusinessOnboardingSession {
    const flow = ONBOARDING_FLOWS[row.scenario];
    const legacy = row.currentStep > 0 && !row.completedFields.some((field) => field === "businessSnapshot" || field === "businessGoal");
    const currentStep = legacy && row.status === "active" ? 1 : row.currentStep;
    const completedFields = legacy && row.status === "active" ? ["businessSnapshot"] : row.completedFields;
    return { ...row, currentStep, completedFields, business: this.businesses.get(row.businessId)!, totalFields: flow.length, currentField: flow[currentStep]?.field };
  }

  async getOnboarding(context: AuthContext) {
    await this.ensure(context);
    const row = [...this.onboardings.values()]
      .filter((item) => item.workspaceId === context.workspaceId && item.userId === context.userId && item.status !== "completed")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return row ? this.hydrateOnboarding(row) : null;
  }

  async startOnboarding(context: AuthContext, scenario: OnboardingScenario) {
    const existing = await this.getOnboarding(context);
    if (existing) return this.setOnboardingStatus(context, existing.id, "active");
    const timestamp = now();
    const placeholder = onboardingPlaceholder(scenario);
    const business: Business = {
      id: randomUUID(), workspaceId: context.workspaceId, ownerUserId: context.userId,
      ...placeholder, activationStatus: "draft", createdAt: timestamp, updatedAt: timestamp,
    };
    this.businesses.set(business.id, business);
    const conversation: Conversation = {
      id: randomUUID(), workspaceId: context.workspaceId, businessId: business.id, userId: context.userId,
      title: "Business setup", createdAt: timestamp, updatedAt: timestamp,
    };
    this.conversations.set(conversation.id, conversation);
    const row: Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField"> = {
      id: randomUUID(), workspaceId: context.workspaceId, userId: context.userId, businessId: business.id,
      conversationId: conversation.id, scenario, status: "active", currentStep: 0,
      completedFields: [], skippedFields: [], createdAt: timestamp, updatedAt: timestamp,
    };
    this.onboardings.set(row.id, row);
    return this.hydrateOnboarding(row);
  }

  async advanceOnboarding(context: AuthContext, sessionId: string, input: { value?: string; skip?: boolean; businessPatch?: Partial<BusinessInput> }) {
    const current = await this.getOnboarding(context);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    const step = ONBOARDING_FLOWS[current.scenario][current.currentStep];
    if (!step) return current;
    if (!input.skip) {
      const value = input.value?.trim();
      if (!value) throw new Error("An answer is required or this step can be skipped");
      const stepPatch = step.field === "businessSnapshot" ? input.businessPatch ?? {} : step.field === "businessGoal" ? {} : onboardingBusinessPatch(step.field, value);
      const business = { ...current.business, ...stepPatch, updatedAt: now() };
      this.businesses.set(business.id, business);
    }
    const nextStep = current.currentStep + 1;
    const row = this.onboardings.get(sessionId)!;
    const updated = {
      ...row, currentStep: nextStep,
      completedFields: input.skip ? current.completedFields : [...current.completedFields, step.field],
      skippedFields: input.skip ? [...current.skippedFields, step.field] : current.skippedFields,
      status: nextStep >= ONBOARDING_FLOWS[current.scenario].length ? "awaiting_confirmation" as const : "active" as const,
      updatedAt: now(),
    };
    this.onboardings.set(sessionId, updated);
    return this.hydrateOnboarding(updated);
  }

  async setOnboardingStatus(context: AuthContext, sessionId: string, status: "active" | "paused") {
    const current = await this.getOnboarding(context);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    const row = { ...this.onboardings.get(sessionId)!, status, updatedAt: now() };
    this.onboardings.set(sessionId, row);
    return this.hydrateOnboarding(row);
  }

  async completeOnboarding(context: AuthContext, sessionId: string) {
    const current = await this.getOnboarding(context);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    const business = { ...current.business, activationStatus: "active" as const, updatedAt: now() };
    this.businesses.set(business.id, business);
    const row = { ...this.onboardings.get(sessionId)!, status: "completed" as const, updatedAt: now() };
    this.onboardings.set(sessionId, row);
    this.current.set(`${context.workspaceId}:${context.userId}`, business.id);
    return this.hydrateOnboarding(row);
  }
}
