import type { Business } from "./common";

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
export type CompanyRunStatus = "queued" | "planning" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelling" | "cancelled";
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
  id: string; workspaceId: string; companyId: string; projectId?: string; userId: string; mainAgentId: string;
  idempotencyKey: string; task: string; requestedMode: CompanyRunMode;
  executionMode?: Exclude<CompanyRunMode, "auto">; status: CompanyRunStatus;
  selectedAgentIds: string[]; omnirouteTaskId?: string; omnirouteComboName?: string;
  result?: string; errorCode?: string; errorMessage?: string; cancelRequested: boolean;
  /**
   * Why the run was cancelled. The in-memory store keeps the whole patch (`updateCompanyAgentRun` spreads
   * it into the stored run), so a cancelled run really carries this field at runtime; the Postgres writer
   * maps named columns only.
   */
  cancelReason?: string;
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
export type CompanyAgentRunEventType = "queued" | "claimed" | "started" | "retry_scheduled" | "completed" | "failed" | "cancelled";
export interface CompanyAgentRunEvent {
  id: string; workspaceId: string; companyId: string; runId: string; eventKey: string;
  eventType: CompanyAgentRunEventType; runStatus: CompanyRunStatus; workerId?: string;
  attemptCount: number; message: string; details: Record<string, unknown>; createdAt: string;
}
export interface CompanyAgentCompletionReport {
  runId: string; companyId: string; status: "completed" | "failed" | "cancelled";
  result?: string; errorCode?: string; errorMessage?: string; workerId?: string;
  attemptCount: number; totalCost: number; totalTokens: number; totalDurationMs: number; completedAt: string;
}
export interface CompanyAgentRunDetails {
  run: CompanyAgentRun; steps: CompanyAgentRunStep[]; toolAudit: CompanyAgentToolAudit[];
  backgroundEvents: CompanyAgentRunEvent[]; completionReport?: CompanyAgentCompletionReport;
}

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

