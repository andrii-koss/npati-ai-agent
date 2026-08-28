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
  };
  details: {
    omniroute: ServiceHealth;
    crawler?: ServiceHealth;
    database?: ServiceHealth;
    hub: ServiceHealth;
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
