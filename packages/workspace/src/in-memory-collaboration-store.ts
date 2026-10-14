import { randomUUID } from "node:crypto";
import type {
  AuthContext, Business, BusinessInput, BusinessOnboardingSession, Conversation,
  ConversationMessage, Goal, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview,
} from "./types";
import { WorkspaceAccessError } from "./types";
import { ONBOARDING_FLOWS, onboardingBusinessPatch, onboardingPlaceholder } from "./onboarding";
import { companyPageLimit, decodeBusinessCursor, encodeBusinessCursor } from "./pagination";
import { now } from "./in-memory-clock";

export interface InMemoryCollaborationState {
  identities: Map<string, { displayName: string; workspaceName: string; role: string }>;
  businesses: Map<string, Business>;
  businessCreateRequests: Map<string, string>;
  conversations: Map<string, Conversation>;
  messages: Map<string, ConversationMessage>;
  onboardings: Map<string, Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">>;
  goals: Map<string, Goal>;
  memories: Map<string, MemoryItem>;
  current: Map<string, string>;
  initialize: (context?: AuthContext) => Promise<void>;
  updateMemory: (ctx: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>) => Promise<MemoryItem>;
}

export async function ensure(host: InMemoryCollaborationState, context: AuthContext) {
  const key = `${context.workspaceId}:${context.userId}`;
  if (!host.identities.has(key)) await host.initialize(context);
  return host.identities.get(key)!;
}

export function assertBusiness(host: InMemoryCollaborationState, context: AuthContext, businessId: string): Business {
  const business = host.businesses.get(businessId);
  if (!business || business.workspaceId !== context.workspaceId) throw new WorkspaceAccessError("Business is not available in this workspace");
  return business;
}

export function assertUserBusiness(host: InMemoryCollaborationState, context: AuthContext, businessId: string): Business {
  const business = host.businesses.get(businessId);
  if (!business || business.workspaceId !== context.workspaceId || business.ownerUserId !== context.userId) {
    throw new WorkspaceAccessError("Business is not available or not owned by this user");
  }
  return business;
}

export async function overview(host: InMemoryCollaborationState, context: AuthContext): Promise<WorkspaceOverview> {
  const identity = await ensure(host, context);
  const businesses = await listBusinesses(host, context);
  let currentId = host.current.get(`${context.workspaceId}:${context.userId}`);
  if (!currentId && businesses.length > 0) {
    currentId = businesses[0]!.id;
    host.current.set(`${context.workspaceId}:${context.userId}`, currentId);
  }
  return {
    user: { id: context.userId, displayName: identity.displayName },
    workspace: { id: context.workspaceId, name: identity.workspaceName, role: identity.role },
    businesses,
    currentBusiness: businesses.find((business) => business.id === currentId) ?? null,
    onboarding: (await listOnboardings(host, context))[0] ?? null,
    onboardings: await listOnboardings(host, context),
  };
}

export async function setCurrentBusiness(host: InMemoryCollaborationState, context: AuthContext, businessId: string): Promise<Business> {
  const business = assertBusiness(host, context, businessId);
  host.current.set(`${context.workspaceId}:${context.userId}`, businessId);
  return business;
}

export async function listBusinesses(host: InMemoryCollaborationState, context: AuthContext): Promise<Business[]> {
  return [...host.businesses.values()]
    .filter((business) => business.workspaceId === context.workspaceId && business.activationStatus === "active")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function listBusinessesPage(host: InMemoryCollaborationState, context: AuthContext, requestedLimit = 20, cursor?: string) {
  const limit = companyPageLimit(requestedLimit);
  const after = decodeBusinessCursor(cursor);
  const businesses = (await listBusinesses(host, context))
    .filter((business) => !after || business.createdAt > after.createdAt || (business.createdAt === after.createdAt && business.id > after.id));
  const items = businesses.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: businesses.length > limit && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
}

export async function getBusiness(host: InMemoryCollaborationState, context: AuthContext, businessId: string): Promise<Business> {
  return assertBusiness(host, context, businessId);
}

export async function createBusiness(host: InMemoryCollaborationState, context: AuthContext, input: BusinessInput, idempotencyKey?: string): Promise<Business> {
  await ensure(host, context);
  const requestKey = idempotencyKey ? `${context.workspaceId}:${context.userId}:${idempotencyKey}` : null;
  const existingId = requestKey ? host.businessCreateRequests.get(requestKey) : undefined;
  const existing = existingId ? host.businesses.get(existingId) : undefined;
  if (existing) return existing;
  const timestamp = now();
  const business: Business = {
    id: randomUUID(), workspaceId: context.workspaceId, ownerUserId: context.userId,
    name: input.name.trim(), businessStage: input.businessStage ?? "starting", activationStatus: "active", createdAt: timestamp, updatedAt: timestamp,
    ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
  } as Business;
  if (!business.name) throw new Error("Business name is required");
  host.businesses.set(business.id, business);
  if (requestKey) host.businessCreateRequests.set(requestKey, business.id);
  host.current.set(`${context.workspaceId}:${context.userId}`, business.id);
  return business;
}

export async function updateBusiness(host: InMemoryCollaborationState, context: AuthContext, businessId: string, input: Partial<BusinessInput>): Promise<Business> {
  const current = assertBusiness(host, context, businessId);
  const updated = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), updatedAt: now() };
  if (!updated.name.trim()) throw new Error("Business name is required");
  host.businesses.set(businessId, updated);
  return updated;
}

export async function deleteBusiness(host: InMemoryCollaborationState, context: AuthContext, businessId: string): Promise<boolean> {
  assertBusiness(host, context, businessId);
  host.businesses.delete(businessId);
  for (const [id, goal] of host.goals) if (goal.businessId === businessId) host.goals.delete(id);
  for (const [id, memory] of host.memories) if (memory.businessId === businessId) host.memories.delete(id);
  for (const [id, conversation] of host.conversations) if (conversation.businessId === businessId) host.conversations.delete(id);
  if (host.current.get(`${context.workspaceId}:${context.userId}`) === businessId) host.current.delete(`${context.workspaceId}:${context.userId}`);
  return true;
}

export async function linkGoal(host: InMemoryCollaborationState, context: AuthContext, businessId: string, goalId: string): Promise<Goal> {
  assertBusiness(host, context, businessId);
  const goal = host.goals.get(goalId);
  if (!goal || goal.workspaceId !== context.workspaceId) throw new WorkspaceAccessError("Goal not found");
  const updated = { ...goal, businessId, updatedAt: now() };
  host.goals.set(goalId, updated);
  return updated;
}

export async function linkMemory(host: InMemoryCollaborationState, context: AuthContext, businessId: string, memoryId: string): Promise<MemoryItem> {
  assertBusiness(host, context, businessId);
  const memory = host.memories.get(memoryId);
  if (!memory || memory.workspaceId !== context.workspaceId) throw new WorkspaceAccessError("Memory not found");
  const updated = { ...memory, businessId, updatedAt: now() };
  host.memories.set(memoryId, updated);
  return updated;
}

export async function deleteMemory(host: InMemoryCollaborationState, context: AuthContext, businessId: string, memoryId: string): Promise<boolean> {
  await host.updateMemory(context, businessId, memoryId, {});
  return host.memories.delete(memoryId);
}

export async function listConversations(host: InMemoryCollaborationState, context: AuthContext, businessId: string): Promise<Conversation[]> {
  assertBusiness(host, context, businessId);
  return [...host.conversations.values()]
    .filter((item) => item.workspaceId === context.workspaceId && item.businessId === businessId && item.userId === context.userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createConversation(host: InMemoryCollaborationState, context: AuthContext, businessId: string, title: string): Promise<Conversation> {
  assertBusiness(host, context, businessId);
  const timestamp = now();
  const conversation: Conversation = {
    id: randomUUID(),
    workspaceId: context.workspaceId,
    businessId,
    userId: context.userId,
    title: title.trim().slice(0, 120) || "New conversation",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  host.conversations.set(conversation.id, conversation);
  return conversation;
}

export async function getConversation(host: InMemoryCollaborationState, context: AuthContext, businessId: string, conversationId: string): Promise<{ conversation: Conversation; messages: ConversationMessage[] }> {
  assertBusiness(host, context, businessId);
  const conversation = host.conversations.get(conversationId);
  if (!conversation || conversation.workspaceId !== context.workspaceId || conversation.businessId !== businessId || conversation.userId !== context.userId) {
    throw new WorkspaceAccessError("Conversation is not available for this business");
  }
  const messages = [...host.messages.values()]
    .filter((item) => item.conversationId === conversationId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { conversation, messages };
}

export async function updateConversation(host: InMemoryCollaborationState, context: AuthContext, businessId: string, conversationId: string, title: string): Promise<Conversation> {
  const { conversation } = await getConversation(host, context, businessId, conversationId);
  const updated = { ...conversation, title: title.trim().slice(0, 120) || "New conversation", updatedAt: now() };
  host.conversations.set(conversationId, updated);
  return updated;
}

export async function deleteConversation(host: InMemoryCollaborationState, context: AuthContext, businessId: string, conversationId: string): Promise<boolean> {
  await getConversation(host, context, businessId, conversationId);
  for (const [messageId, message] of host.messages) {
    if (message.conversationId === conversationId) host.messages.delete(messageId);
  }
  return host.conversations.delete(conversationId);
}

export async function appendMessage(host: InMemoryCollaborationState, context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string): Promise<ConversationMessage> {
  const { conversation } = await getConversation(host, context, businessId, conversationId);
  const last = Math.max(0, ...[...host.messages.values()].filter(item => item.conversationId === conversationId).map(item => Date.parse(item.createdAt)));
  const message: ConversationMessage = {
    id: randomUUID(),
    conversationId,
    role,
    content,
    createdAt: new Date(Math.max(Date.now(), last + 1)).toISOString(),
  };
  host.messages.set(message.id, message);
  host.conversations.set(conversationId, { ...conversation, updatedAt: message.createdAt });
  return message;
}

export async function listNeutralConversations(host: InMemoryCollaborationState, context: AuthContext): Promise<Conversation[]> {
  await ensure(host, context);
  return [...host.conversations.values()]
    .filter((item) => item.workspaceId === context.workspaceId && item.businessId === null && item.userId === context.userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createNeutralConversation(host: InMemoryCollaborationState, context: AuthContext, title: string): Promise<Conversation> {
  await ensure(host, context);
  const timestamp = now();
  const conversation: Conversation = {
    id: randomUUID(),
    workspaceId: context.workspaceId,
    businessId: null,
    userId: context.userId,
    title: title.trim().slice(0, 120) || "New conversation",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  host.conversations.set(conversation.id, conversation);
  return conversation;
}

export async function getNeutralConversation(host: InMemoryCollaborationState, context: AuthContext, conversationId: string): Promise<{ conversation: Conversation; messages: ConversationMessage[] }> {
  await ensure(host, context);
  const conversation = host.conversations.get(conversationId);
  if (!conversation || conversation.workspaceId !== context.workspaceId || conversation.businessId !== null || conversation.userId !== context.userId) {
    throw new WorkspaceAccessError("Conversation is not available to this user");
  }
  const messages = [...host.messages.values()]
    .filter((item) => item.conversationId === conversationId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { conversation, messages };
}

export async function updateNeutralConversation(host: InMemoryCollaborationState, context: AuthContext, conversationId: string, title: string): Promise<Conversation> {
  const { conversation } = await getNeutralConversation(host, context, conversationId);
  const updated = { ...conversation, title: title.trim().slice(0, 120) || "New conversation", updatedAt: now() };
  host.conversations.set(conversationId, updated);
  return updated;
}

export async function deleteNeutralConversation(host: InMemoryCollaborationState, context: AuthContext, conversationId: string): Promise<boolean> {
  await getNeutralConversation(host, context, conversationId);
  for (const [messageId, message] of host.messages) {
    if (message.conversationId === conversationId) host.messages.delete(messageId);
  }
  return host.conversations.delete(conversationId);
}

export async function appendNeutralMessage(host: InMemoryCollaborationState, context: AuthContext, conversationId: string, role: ConversationMessage["role"], content: string): Promise<ConversationMessage> {
  const { conversation } = await getNeutralConversation(host, context, conversationId);
  const message: ConversationMessage = {
    id: randomUUID(),
    conversationId,
    role,
    content,
    createdAt: now(),
  };
  host.messages.set(message.id, message);
  host.conversations.set(conversationId, { ...conversation, updatedAt: message.createdAt });
  return message;
}

export function hydrateOnboarding(host: InMemoryCollaborationState, row: Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">): BusinessOnboardingSession {
  const flow = ONBOARDING_FLOWS[row.scenario];
  const legacy = row.currentStep > 0 && !row.completedFields.some((field) => field === "businessSnapshot" || field === "businessGoal");
  const currentStep = legacy && row.status === "active" ? 1 : row.currentStep;
  const completedFields = legacy && row.status === "active" ? ["businessSnapshot"] : row.completedFields;
  return {
    ...row,
    currentStep,
    completedFields,
    business: host.businesses.get(row.businessId)!,
    totalFields: flow.length,
    currentField: flow[currentStep]?.field,
  };
}

export async function listOnboardings(host: InMemoryCollaborationState, context: AuthContext): Promise<BusinessOnboardingSession[]> {
  await ensure(host, context);
  return [...host.onboardings.values()]
    .filter((item) => item.workspaceId === context.workspaceId && item.userId === context.userId && item.status !== "completed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((row) => hydrateOnboarding(host, row));
}

export async function getOnboarding(host: InMemoryCollaborationState, context: AuthContext, businessId?: string): Promise<BusinessOnboardingSession | null> {
  const rows = await listOnboardings(host, context);
  return rows.find((row) => !businessId || row.businessId === businessId) ?? null;
}

export async function getOnboardingSession(host: InMemoryCollaborationState, context: AuthContext, sessionId: string): Promise<BusinessOnboardingSession | null> {
  const rows = await listOnboardings(host, context);
  return rows.find((row) => row.id === sessionId) ?? null;
}

export async function startOnboarding(host: InMemoryCollaborationState, context: AuthContext, scenario: OnboardingScenario, options?: { forceNew?: boolean }): Promise<BusinessOnboardingSession> {
  const existing = options?.forceNew ? null : await getOnboarding(host, context);
  if (existing) return setOnboardingStatus(host, context, existing.id, "active");
  const timestamp = now();
  const placeholder = onboardingPlaceholder(scenario);
  const business: Business = {
    id: randomUUID(), workspaceId: context.workspaceId, ownerUserId: context.userId,
    ...placeholder, activationStatus: "draft", createdAt: timestamp, updatedAt: timestamp,
  };
  host.businesses.set(business.id, business);
  const conversation: Conversation = {
    id: randomUUID(), workspaceId: context.workspaceId, businessId: business.id, userId: context.userId,
    title: "Business setup", createdAt: timestamp, updatedAt: timestamp,
  };
  host.conversations.set(conversation.id, conversation);
  const row: Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField"> = {
    id: randomUUID(), workspaceId: context.workspaceId, userId: context.userId, businessId: business.id,
    conversationId: conversation.id, scenario, status: "active", currentStep: 0,
    completedFields: [], skippedFields: [], createdAt: timestamp, updatedAt: timestamp,
  };
  host.onboardings.set(row.id, row);
  return hydrateOnboarding(host, row);
}

export async function advanceOnboarding(
  host: InMemoryCollaborationState,
  context: AuthContext,
  sessionId: string,
  input: { value?: string; skip?: boolean; businessPatch?: Partial<BusinessInput> },
): Promise<BusinessOnboardingSession> {
  const current = await getOnboardingSession(host, context, sessionId);
  if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
  const step = ONBOARDING_FLOWS[current.scenario][current.currentStep];
  if (!step) return current;
  if (!input.skip) {
    const value = input.value?.trim();
    if (!value) throw new Error("An answer is required or this step can be skipped");
    const stepPatch = step.field === "businessSnapshot" ? input.businessPatch ?? {} : step.field === "businessGoal" ? {} : onboardingBusinessPatch(step.field, value);
    const business = { ...current.business, ...stepPatch, updatedAt: now() };
    host.businesses.set(business.id, business);
  }
  const nextStep = current.currentStep + 1;
  const row = host.onboardings.get(sessionId)!;
  const updated = {
    ...row, currentStep: nextStep,
    completedFields: input.skip ? current.completedFields : [...current.completedFields, step.field],
    skippedFields: input.skip ? [...current.skippedFields, step.field] : current.skippedFields,
    status: nextStep >= ONBOARDING_FLOWS[current.scenario].length ? "awaiting_confirmation" as const : "active" as const,
    updatedAt: now(),
  };
  host.onboardings.set(sessionId, updated);
  return hydrateOnboarding(host, updated);
}

export async function setOnboardingStatus(host: InMemoryCollaborationState, context: AuthContext, sessionId: string, status: "active" | "paused"): Promise<BusinessOnboardingSession> {
  const current = await getOnboardingSession(host, context, sessionId);
  if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
  const row = { ...host.onboardings.get(sessionId)!, status, updatedAt: now() };
  host.onboardings.set(sessionId, row);
  return hydrateOnboarding(host, row);
}

export async function completeOnboarding(host: InMemoryCollaborationState, context: AuthContext, sessionId: string): Promise<BusinessOnboardingSession> {
  const current = await getOnboardingSession(host, context, sessionId);
  if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
  const business = { ...current.business, activationStatus: "active" as const, updatedAt: now() };
  host.businesses.set(business.id, business);
  const row = { ...host.onboardings.get(sessionId)!, status: "completed" as const, updatedAt: now() };
  host.onboardings.set(sessionId, row);
  host.current.set(`${context.workspaceId}:${context.userId}`, business.id);
  return hydrateOnboarding(host, row);
}
