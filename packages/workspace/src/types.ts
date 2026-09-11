export interface AuthContext {
  userId: string;
  externalSubject?: string;
  workspaceId: string;
  permissions: string[];
  apiKeyId?: string;
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
export interface BusinessPage { items: Business[]; nextCursor: string | null; }

export interface Company {
  id: string; workspaceId: string; userId: string; businessId?: string;
  name: string; website?: string; industry?: string; description?: string;
  productsServices?: string; languages: string[]; brandTone?: string; companyInstructions?: string;
  knowledge: unknown[]; memory: Record<string, unknown>; mainAgentId?: string;
  status: "active" | "inactive"; revision: number; createdAt: string; updatedAt: string;
}
export type CompanyInput = Partial<Omit<Company, "id" | "workspaceId" | "userId" | "mainAgentId" | "revision" | "createdAt" | "updatedAt">> & { name: string };
export interface CompanyPage { items: Company[]; nextCursor: string | null; }

export interface BusinessToCompanyInput {
  companyName?: string;
  includeConfirmedMemory?: boolean;
  includeGoals?: boolean;
  includeResearchSummary?: boolean;
  includeInstructions?: boolean;
}

export interface CompanyAgent {
  id: string; workspaceId: string; companyId: string; name: string; role: string;
  description?: string; systemInstruction?: string; promptGuidelines?: string;
  recommendedPrompts: string[]; modelId?: string; fallbackModelId?: string;
  tools: string[]; isActive: boolean; positionX?: number; positionY?: number;
  sortOrder: number; revision: number; createdAt: string; updatedAt: string;
}
export type CompanyAgentInput = Partial<Omit<CompanyAgent, "id" | "workspaceId" | "companyId" | "revision" | "createdAt" | "updatedAt">> & { name: string; role: string };
export interface CompanyAgentPage { items: CompanyAgent[]; nextCursor: string | null; }

export interface CompanyAgentEdge {
  id: string; workspaceId: string; companyId: string; parentAgentId: string;
  childAgentId: string; relationType: string; createdAt: string;
}

export type CompanyRunMode = "auto" | "single" | "pipeline" | "fusion";
export type CompanyRunStatus = "queued" | "planning" | "running" | "completed" | "failed" | "cancelling" | "cancelled";
export type ContextType = "none" | "business" | "company";

export interface ActiveContext {
  contextType: ContextType;
  businessId: string | null;
  companyId: string | null;
}

export interface RunContextSnapshot extends ActiveContext {
  workspaceId: string;
  userId: string;
  agentId?: string | null;
  companyRevision?: number | null;
  capturedAt: string;
}

export interface CompanyAgentRun {
  id: string; workspaceId: string; companyId: string; userId: string; mainAgentId: string;
  idempotencyKey: string; task: string; requestedMode: CompanyRunMode;
  executionMode?: Exclude<CompanyRunMode, "auto">; status: CompanyRunStatus;
  selectedAgentIds: string[]; omnirouteTaskId?: string; omnirouteComboName?: string;
  result?: string; errorCode?: string; errorMessage?: string; cancelRequested: boolean;
  workerId?: string; leaseExpiresAt?: string; lastHeartbeatAt?: string;
  attemptCount: number; maxAttempts: number; nextAttemptAt: string;
  contextSnapshot?: RunContextSnapshot;
  agentConfigRevision?: number;
  capabilitySetRevision?: number;
  totalCost?: number;
  totalTokens?: number;
  totalDurationMs?: number;
  createdAt: string; startedAt?: string; completedAt?: string; updatedAt: string;
}
export interface CompanyAgentRunStep {
  id: string; workspaceId: string; companyId: string; runId: string; agentId: string;
  stepOrder: number; lane: number; role: "manager" | "worker" | "reviewer";
  status: "selected" | "delegated" | "completed" | "failed" | "cancelled";
  modelId: string; createdAt: string; updatedAt: string;
}
export interface CompanyAgentToolAudit {
  id: string; workspaceId: string; companyId: string; runId: string; agentId: string;
  toolName: string; decision: "allowed" | "denied";
  status: "requested" | "succeeded" | "failed" | "blocked";
  inputSummary: Record<string, unknown>; errorMessage?: string; createdAt: string; completedAt?: string;
  latencyMs?: number; cost?: number; tokens?: number; reasonCode?: string; sequenceNumber?: number;
}
export interface CompanyAgentRunDetails { run: CompanyAgentRun; steps: CompanyAgentRunStep[]; toolAudit: CompanyAgentToolAudit[]; }

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
  id: string; workspaceId: string; businessId: string | null; userId: string; title: string; createdAt: string; updatedAt: string;
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
  onboardings: BusinessOnboardingSession[];
}

export interface UserSetting {
  key: string;
  value: unknown;
  revision: number;
  updatedAt: string;
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

export class WorkspaceNotFoundError extends Error {
  readonly status = 404;
  readonly code = "WORKSPACE_NOT_FOUND";
}

export interface WorkspaceStore {
  initialize(context?: AuthContext): Promise<void>;
  getUserSetting(context: AuthContext, key: string): Promise<UserSetting | null>;
  setUserSetting(context: AuthContext, key: string, value: unknown, expectedRevision: number): Promise<UserSetting | null>;
  health(): Promise<"ok" | "unavailable">;
  overview(context: AuthContext): Promise<WorkspaceOverview>;
  setCurrentBusiness(context: AuthContext, businessId: string): Promise<Business>;
  listBusinesses(context: AuthContext): Promise<Business[]>;
  listBusinessesPage(context: AuthContext, limit?: number, cursor?: string): Promise<BusinessPage>;
  getBusiness(context: AuthContext, businessId: string): Promise<Business>;
  createBusiness(context: AuthContext, input: BusinessInput, idempotencyKey?: string): Promise<Business>;
  updateBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>): Promise<Business>;
  deleteBusiness(context: AuthContext, businessId: string): Promise<boolean>;
  listCompanies(context: AuthContext, limit?: number, cursor?: string): Promise<CompanyPage>;
  getCompany(context: AuthContext, companyId: string): Promise<Company>;
  createCompany(context: AuthContext, input: CompanyInput, idempotencyKey: string): Promise<Company>;
  convertBusinessToCompany(context: AuthContext, businessId: string, input: BusinessToCompanyInput, idempotencyKey: string): Promise<{ company: Company; created: boolean }>;
  updateCompany(context: AuthContext, companyId: string, input: Partial<CompanyInput>, expectedRevision: number): Promise<Company>;
  deleteCompany(context: AuthContext, companyId: string): Promise<boolean>;
  setCompanyMainAgent(context: AuthContext, companyId: string, agentId: string | null, expectedRevision: number): Promise<Company>;
  listCompanyAgents(context: AuthContext, companyId: string): Promise<CompanyAgent[]>;
  listCompanyAgentsPage(context: AuthContext, companyId: string, limit?: number, cursor?: string): Promise<CompanyAgentPage>;
  getCompanyAgent(context: AuthContext, companyId: string, agentId: string): Promise<CompanyAgent>;
  createCompanyAgent(context: AuthContext, companyId: string, input: CompanyAgentInput, idempotencyKey: string): Promise<CompanyAgent>;
  updateCompanyAgent(context: AuthContext, companyId: string, agentId: string, input: Partial<CompanyAgentInput>, expectedRevision: number): Promise<CompanyAgent>;
  deleteCompanyAgent(context: AuthContext, companyId: string, agentId: string, expectedRevision: number): Promise<boolean>;
  listCompanyAgentEdges(context: AuthContext, companyId: string, agentIds?: string[]): Promise<CompanyAgentEdge[]>;
  setCompanyAgentParent(context: AuthContext, companyId: string, childAgentId: string, parentAgentId: string | null): Promise<CompanyAgentEdge | null>;
  createCompanyAgentRun(context: AuthContext, companyId: string, input: { task: string; requestedMode: CompanyRunMode }, idempotencyKey: string): Promise<{ run: CompanyAgentRun; created: boolean }>;
  listCompanyAgentRuns(context: AuthContext, companyId: string, limit?: number): Promise<CompanyAgentRun[]>;
  getCompanyAgentRun(context: AuthContext, companyId: string, runId: string): Promise<CompanyAgentRunDetails>;
  updateCompanyAgentRun(context: AuthContext, companyId: string, runId: string, patch: Partial<Pick<CompanyAgentRun, "status" | "executionMode" | "selectedAgentIds" | "omnirouteTaskId" | "omnirouteComboName" | "result" | "errorCode" | "errorMessage" | "cancelRequested" | "totalCost" | "totalTokens" | "totalDurationMs">>): Promise<CompanyAgentRun>;
  replaceCompanyAgentRunSteps(context: AuthContext, companyId: string, runId: string, steps: Array<Pick<CompanyAgentRunStep, "agentId" | "stepOrder" | "lane" | "role" | "status" | "modelId">>): Promise<CompanyAgentRunStep[]>;
  appendCompanyAgentToolAudit(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentToolAudit, "agentId" | "toolName" | "decision" | "status" | "inputSummary" | "errorMessage"> & Partial<Pick<CompanyAgentToolAudit, "latencyMs" | "cost" | "tokens" | "reasonCode" | "sequenceNumber">>): Promise<CompanyAgentToolAudit>;
  claimCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number): Promise<boolean>;
  heartbeatCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number): Promise<boolean>;
  requeueCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, delayMs: number): Promise<boolean>;
  listRecoverableCompanyAgentRuns(limit?: number): Promise<Array<{ context: AuthContext; companyId: string; runId: string }>>;
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
  listNeutralConversations(context: AuthContext): Promise<Conversation[]>;
  createNeutralConversation(context: AuthContext, title: string): Promise<Conversation>;
  getNeutralConversation(context: AuthContext, conversationId: string): Promise<{ conversation: Conversation; messages: ConversationMessage[] }>;
  updateNeutralConversation(context: AuthContext, conversationId: string, title: string): Promise<Conversation>;
  deleteNeutralConversation(context: AuthContext, conversationId: string): Promise<boolean>;
  appendNeutralMessage(context: AuthContext, conversationId: string, role: ConversationMessage["role"], content: string): Promise<ConversationMessage>;
  getOnboarding(context: AuthContext, businessId?: string): Promise<BusinessOnboardingSession | null>;
  listOnboardings(context: AuthContext): Promise<BusinessOnboardingSession[]>;
  startOnboarding(context: AuthContext, scenario: OnboardingScenario, options?: { forceNew?: boolean }): Promise<BusinessOnboardingSession>;
  advanceOnboarding(context: AuthContext, sessionId: string, input: { value?: string; skip?: boolean; businessPatch?: Partial<BusinessInput> }): Promise<BusinessOnboardingSession>;
  setOnboardingStatus(context: AuthContext, sessionId: string, status: "active" | "paused"): Promise<BusinessOnboardingSession>;
  completeOnboarding(context: AuthContext, sessionId: string): Promise<BusinessOnboardingSession>;
}
