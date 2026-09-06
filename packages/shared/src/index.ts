export type ServiceStatus = "ok" | "degraded" | "unavailable" | "not_configured";

export interface ServiceHealth {
  status: ServiceStatus;
  detail?: string;
  version?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  services: {
    agent: ServiceStatus;
    database: ServiceStatus;
    omniroute: ServiceStatus;
    crawler: ServiceStatus;
    hub: ServiceStatus;
    storage?: ServiceStatus;
  };
  details: {
    omniroute: ServiceHealth;
    crawler?: ServiceHealth;
    database?: ServiceHealth;
    hub: ServiceHealth;
    storage?: ServiceHealth;
  };
}

export interface AgentMessage {
  message: string;
  intent?: string;
}

export interface AgentReply {
  message: string;
  suggestedActions: string[];
  conversationId?: string;
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
}): ActiveContext {
  const rawType = input.contextType ? String(input.contextType).toLowerCase().trim() : undefined;
  const businessId = input.businessId?.trim() || null;
  const companyId = input.companyId?.trim() || null;

  const contextType: ContextType = (rawType === "none" || rawType === "business" || rawType === "company")
    ? (rawType as ContextType)
    : companyId
    ? "company"
    : businessId
    ? "business"
    : "none";

  if (businessId && companyId) {
    throw new ContextValidationError("businessId and companyId are mutually exclusive and cannot be active simultaneously.");
  }

  if (contextType === "none" && (businessId || companyId)) {
    throw new ContextValidationError("Neutral context ('none') cannot have businessId or companyId.");
  }

  if (contextType === "company" && !companyId) {
    throw new ContextValidationError("Context 'company' requires a valid companyId.");
  }

  return {
    contextType,
    businessId,
    companyId,
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
