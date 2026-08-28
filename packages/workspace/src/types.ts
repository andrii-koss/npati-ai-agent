export interface AuthContext {
  userId: string;
  externalSubject?: string;
  workspaceId: string;
  permissions: string[];
}

export type BusinessStage = "idea" | "starting" | "operating" | "growing" | "scaling";
export type TeamType = "solo" | "team";
export type PresenceType = "online" | "local" | "both";

export interface Business {
  id: string; workspaceId: string; ownerUserId: string; name: string;
  businessType?: string; industry?: string; niche?: string; country?: string; market?: string; website?: string;
  businessStage: BusinessStage; teamType?: TeamType; businessModel?: string; presenceType?: PresenceType;
  description?: string; audienceSummary?: string; productsServicesSummary?: string;
  activationStatus: "draft" | "active"; createdAt: string; updatedAt: string;
}
export type BusinessInput = Partial<Omit<Business, "id" | "workspaceId" | "ownerUserId" | "activationStatus" | "createdAt" | "updatedAt">> & { name: string };

export type GoalStatus = "active" | "completed" | "paused" | "cancelled";
export interface Goal {
  id: string; workspaceId: string; businessId: string; createdByUserId: string; title: string; description?: string;
  status: GoalStatus; targetValue?: number; targetUnit?: string; currentValue?: number; targetDate?: string;
  priority: number; createdAt: string; updatedAt: string;
}
export type GoalInput = Partial<Omit<Goal, "id" | "workspaceId" | "businessId" | "createdByUserId" | "createdAt" | "updatedAt">> & { title: string };

export type MemoryType = "business_fact" | "audience" | "brand" | "preference" | "decision" | "product" | "channel" | "experiment" | "result" | "other";
export interface MemoryItem {
  id: string; workspaceId: string; businessId: string; userId: string; type: MemoryType; title: string;
  content: string; source: string; confidence?: number; createdAt: string; updatedAt: string;
}
export type MemoryInput = Pick<MemoryItem, "type" | "title" | "content"> & Partial<Pick<MemoryItem, "source" | "confidence">>;

export interface Conversation {
  id: string; workspaceId: string; businessId: string; userId: string; title: string; createdAt: string; updatedAt: string;
}
export interface ConversationMessage {
  id: string; conversationId: string; role: "user" | "assistant" | "system"; content: string; createdAt: string;
}
export interface WorkspaceOverview {
  user: { id: string; displayName: string };
  workspace: { id: string; name: string; role: string };
  businesses: Business[];
  currentBusiness: Business | null;
  onboarding: BusinessOnboardingSession | null;
}

export type OnboardingScenario = "existing" | "starting" | "seller";
export type OnboardingStatus = "active" | "paused" | "awaiting_confirmation" | "completed";
export interface BusinessOnboardingSession {
  id: string; workspaceId: string; userId: string; businessId: string; conversationId: string;
  scenario: OnboardingScenario; status: OnboardingStatus; currentStep: number;
  completedFields: string[]; skippedFields: string[]; totalFields: number; currentField?: string;
  business: Business; createdAt: string; updatedAt: string;
}

export class WorkspaceAccessError extends Error {
  readonly status = 403;
  readonly code = "BUSINESS_ACCESS_DENIED";
}

export interface WorkspaceStore {
  initialize(context?: AuthContext): Promise<void>;
  health(): Promise<"ok" | "unavailable">;
  overview(context: AuthContext): Promise<WorkspaceOverview>;
  setCurrentBusiness(context: AuthContext, businessId: string): Promise<Business>;
  listBusinesses(context: AuthContext): Promise<Business[]>;
  getBusiness(context: AuthContext, businessId: string): Promise<Business>;
  createBusiness(context: AuthContext, input: BusinessInput): Promise<Business>;
  updateBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>): Promise<Business>;
  deleteBusiness(context: AuthContext, businessId: string): Promise<boolean>;
  listGoals(context: AuthContext, businessId: string): Promise<Goal[]>;
  createGoal(context: AuthContext, businessId: string, input: GoalInput): Promise<Goal>;
  updateGoal(context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>): Promise<Goal>;
  deleteGoal(context: AuthContext, businessId: string, goalId: string): Promise<boolean>;
  listMemory(context: AuthContext, businessId: string, query?: string, limit?: number): Promise<MemoryItem[]>;
  createMemory(context: AuthContext, businessId: string, input: MemoryInput): Promise<MemoryItem>;
  updateMemory(context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>): Promise<MemoryItem>;
  deleteMemory(context: AuthContext, businessId: string, memoryId: string): Promise<boolean>;
  listConversations(context: AuthContext, businessId: string): Promise<Conversation[]>;
  createConversation(context: AuthContext, businessId: string, title: string): Promise<Conversation>;
  getConversation(context: AuthContext, businessId: string, conversationId: string): Promise<{ conversation: Conversation; messages: ConversationMessage[] }>;
  updateConversation(context: AuthContext, businessId: string, conversationId: string, title: string): Promise<Conversation>;
  deleteConversation(context: AuthContext, businessId: string, conversationId: string): Promise<boolean>;
  appendMessage(context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string): Promise<ConversationMessage>;
  getOnboarding(context: AuthContext): Promise<BusinessOnboardingSession | null>;
  startOnboarding(context: AuthContext, scenario: OnboardingScenario): Promise<BusinessOnboardingSession>;
  advanceOnboarding(context: AuthContext, sessionId: string, input: { value?: string; skip?: boolean; businessPatch?: Partial<BusinessInput> }): Promise<BusinessOnboardingSession>;
  setOnboardingStatus(context: AuthContext, sessionId: string, status: "active" | "paused"): Promise<BusinessOnboardingSession>;
  completeOnboarding(context: AuthContext, sessionId: string): Promise<BusinessOnboardingSession>;
}
