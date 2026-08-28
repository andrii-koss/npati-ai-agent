export type AuthType = "api_key" | "oauth" | "none" | "local" | "web_session" | "other";
export type FreeStatus = "free" | "free_tier" | "paid" | "unknown";

export interface ProviderConnection { id: string; status: string; healthy: boolean | null; lastError?: string }
export interface Provider {
  id: string; name: string; description?: string; category: string; authType: AuthType;
  connectionStatus: string; freeStatus: FreeStatus; local: boolean; localStatus?: string;
  modelCount: number; capabilities: string[]; connected: boolean; recommended: boolean;
  experimental: boolean; website?: string; authHint?: string; baseUrlDefault?: string;
  credentialOptional: boolean; connectable: boolean; connections: ProviderConnection[];
}
export interface Model {
  id: string; upstreamId: string; providerId: string; providerName: string; name: string;
  capabilities: string[]; added: boolean; local: boolean; installed?: boolean;
  freeStatus: FreeStatus; contextWindow?: number; maxOutputTokens?: number;
}
export interface MarketplaceData {
  source: { version: string; commit: string; registryProviders: number; routableProviders: number };
  overview: { providers: number; models: number; connectedProviders: number; addedModels: number };
  counts: { connected: number; recommended: number; free: number; local: number; all: number };
  availableFilters: { auth: AuthType[]; cost: FreeStatus[]; capabilities: string[] };
  providers: Provider[];
  pagination: { offset: number; limit: number; returned: number; total: number; hasMore: boolean };
}
export interface Routing {
  mode: "automatic" | "manual";
  defaultModelId: string | null;
  automaticModel: string;
  preferFree: boolean;
  fallbackOnFailure: boolean;
  balanceQualityCost: boolean;
  compression: "stacked" | "off";
  monthlyBudgetUsd: number;
  warningPercent: number;
  stopPaidWhenLimitReached: boolean;
}
