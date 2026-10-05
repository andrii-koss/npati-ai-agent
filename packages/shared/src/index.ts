export type ServiceStatus = "ok" | "degraded" | "unavailable" | "not_configured";

export interface ServiceHealth {
  status: ServiceStatus;
  detail?: string;
  version?: string;
  endpoint?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  services: {
    agent: ServiceStatus;
    database: ServiceStatus;
    omniroute: ServiceStatus;
    redis: ServiceStatus;
    crawler: ServiceStatus;
    hub: ServiceStatus;
    storage?: ServiceStatus;
    coreBackend: ServiceStatus;
  };
  details: {
    omniroute: ServiceHealth;
    redis: ServiceHealth;
    crawler?: ServiceHealth;
    database?: ServiceHealth;
    hub: ServiceHealth;
    storage?: ServiceHealth;
    coreBackend: ServiceHealth;
  };
}

export interface AgentMessage {
  message: string;
  intent?: string;
}

export interface AgentReply {
  message: string;
  suggestedActions: string[];
  companyAction?: { action: "create" | "update" | "delete"; companyId: string; companyName: string; agentCount: number };
  workspaceAction?: { action: "activity.run" | "activity.cancel" | "automation.list" | "automation.create" | "automation.update" | "automation.delete" | "automation.run" | "automation.history" | "website.list" | "website.create" | "website.seed_demo" | "website.update" | "website.delete" | "content.create" | "content.update" | "content.delete" | "memory.create" | "memory.update" | "memory.delete"; resourceId: string; companyId?: string; businessId?: string };
  conversationId?: string;
  noMemory?: boolean;
  model?: string;
  memoryCandidate?: { type: string; title: string; content: string };
  research?: { used: boolean; kind?: string; degraded?: string; sources: Array<{ url: string; title?: string; accessedAt: string }> };
  onboarding?: {
    id: string; conversationId: string; scenario: string; status: string;
    currentStep: number; totalFields: number; completedFields: string[]; skippedFields: string[];
    currentField?: string; business: Record<string, unknown>;
  };
  activeContext?: ActiveContext;
  companyRunId?: string;
  projectCard?: ProjectCardData;
  projectAction?: ProjectActionData;
  telemetry?: {
    requestId?: string;
    provider?: string;
    routingStrategy?: string;
    latencyMs: number;
    costUsd?: number;
    costSource?: "upstream" | "estimated";
    cacheHit: boolean;
    cacheSavingsUsd?: number;
    failoverCount: number;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number };
  };
}

export interface AgentAction {
  id: string;
  type: string;
  title: string;
  status: "suggested" | "requires_confirmation" | "approved" | "running" | "completed" | "failed";
}

export interface BusinessProfile {
  id: string;
  name?: string;
  industry?: string;
  stage: "idea" | "new" | "operating" | "growing";
}

export type ContextType = "none" | "business" | "company" | "project";

export interface ActiveContext {
  contextType: ContextType;
  businessId: string | null;
  companyId: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
}

export interface RunContextSnapshot extends ActiveContext {
  workspaceId: string;
  userId: string;
  agentId?: string | null;
  companyRevision?: number | null;
  capturedAt: string;
}

export interface ProjectCardData {
  id: string;
  projectId?: string;
  name: string;
  status: string;
  companyId: string;
  companyName?: string;
  framework?: string;
  lastBuildStatus?: string | null;
  buildStatus?: string | null;
  previewUrl?: string | null;
  agentName?: string;
  agentRole?: string;
  runId?: string;
}

export interface ProjectActionData {
  action: "create" | "edit" | "build" | "preview" | "test" | "inspect";
  projectId: string;
  projectName: string;
  companyId: string;
  runId?: string;
}

export class ContextValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextValidationError";
  }
}

export function validateActiveContext(input: {
  contextType?: ContextType | string;
  businessId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
}): ActiveContext {
  const rawType = input.contextType ? String(input.contextType).toLowerCase().trim() : undefined;
  const businessId = input.businessId?.trim() || null;
  const companyId = input.companyId?.trim() || null;
  const projectId = input.projectId?.trim() || null;
  const workspaceId = input.workspaceId?.trim() || null;

  const contextType: ContextType = (rawType === "none" || rawType === "business" || rawType === "company" || rawType === "project")
    ? (rawType as ContextType)
    : projectId
    ? "project"
    : companyId
    ? "company"
    : businessId
    ? "business"
    : "none";

  if (businessId && companyId && !projectId) {
    throw new ContextValidationError("businessId and companyId are mutually exclusive and cannot be active simultaneously.");
  }

  if (contextType === "none" && (businessId || companyId || projectId)) {
    throw new ContextValidationError("Neutral context ('none') cannot have businessId, companyId, or projectId.");
  }

  if (contextType === "company" && !companyId) {
    throw new ContextValidationError("Context 'company' requires a valid companyId.");
  }

  if (contextType === "project" && !projectId) {
    throw new ContextValidationError("Context 'project' requires a valid projectId.");
  }

  return {
    contextType,
    businessId,
    companyId,
    projectId,
    workspaceId,
  };
}

export * from "./capabilities";
export * from "./capability-catalog";
export * from "./effective-capabilities";
export * from "./hybrid-router";
export * from "./risk-approval";
export * from "./run-trace";
export * from "./capability-matrix";
export * from "./tool-test-matrix";
export * from "./capability-inspector";
export * from "./project-file-capabilities";
export * from "./project-terminal-capabilities";
export * from "./project-preview-capabilities";
export * from "./project-intent";

export * from "./project-git-capabilities";
export * from "./project-deploy-capabilities";
export * from "./project-qa-capabilities";
export * from "./project-data-capabilities";
export * from "./project-data-templates";
export * from "./project-auth-types";
export * from "./website-schema";
export * from "./website-renderer";
export * from "./static-website-renderer";
export * from "./project-api-types";
export * from "./project-sdk";
export * from "./mobile-app-template";
