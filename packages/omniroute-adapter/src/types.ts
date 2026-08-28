import type { ServiceHealth } from "@npati/shared";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string | ChatContentPart[] }>;
  model?: string;
  fallbackModel?: string;
  compression?: "off" | "default" | "engine:rtk";
}

export interface AudioTranscriptionInput {
  data: Uint8Array;
  mimeType: string;
  filename: string;
  model?: string;
  language?: string;
}

export interface AudioTranscriptionResult {
  text: string;
  model?: string;
}

export interface ChatResult {
  content: string;
  model?: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
}

export interface WebSearchInput {
  query: string;
  maxResults?: number;
  searchType?: "web" | "news";
  provider?: string;
  country?: string;
  language?: string;
  bypassCache?: boolean;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
  publishedAt?: string;
  position?: number;
  retrievedAt?: string;
}

export interface WebSearchResponse {
  provider: string;
  query: string;
  cached: boolean;
  results: WebSearchResult[];
}

export interface WebFetchInput {
  url: string;
  provider?: "firecrawl" | "jina-reader" | "tavily-search" | "tinyfish";
  format?: "markdown" | "html" | "links";
  includeMetadata?: boolean;
}

export interface WebPageResult {
  url: string;
  finalUrl?: string;
  title?: string;
  text?: string;
  markdown?: string;
  description?: string;
  links?: string[];
  provider?: string;
  fetchedAt: string;
}

export interface AIEngine {
  chat(request: ChatRequest): Promise<ChatResult>;
  stream(request: ChatRequest): AsyncIterable<string>;
  listModels(): Promise<ModelInfo[]>;
  getModel(id: string): Promise<ModelInfo | undefined>;
  executeTool(name: string, input: unknown): Promise<unknown>;
  searchMemory(query: string): Promise<unknown[]>;
  saveMemory(value: unknown): Promise<void>;
  getCapabilities(): Promise<string[]>;
  healthCheck(): Promise<ServiceHealth>;
  transcribeAudio?(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult>;
}

export interface OmniRouteConfig {
  baseUrl?: string;
  apiKey?: string;
  managementPassword?: string;
  timeoutMs?: number;
  catalogTtlMs?: number;
  transcriptionModel?: string;
}

export type ProviderAuthType = "api_key" | "oauth" | "none" | "local" | "web_session" | "other";
export type ProviderConnectionStatus = "connected" | "not_connected" | "error" | "unknown";
export type ProviderFreeStatus = "free" | "free_tier" | "paid" | "unknown";
export type LocalProviderStatus = "running" | "not_detected" | "needs_configuration" | "unknown";

export interface ProviderConnectionSummary {
  id: string;
  providerId: string;
  name?: string;
  active: boolean;
  status: ProviderConnectionStatus;
  healthy: boolean | null;
  lastError?: string;
}

export interface AIProviderSummary {
  id: string;
  name: string;
  description?: string;
  category: string;
  authType: ProviderAuthType;
  connectionStatus: ProviderConnectionStatus;
  freeStatus: ProviderFreeStatus;
  local: boolean;
  localStatus?: LocalProviderStatus;
  modelCount: number;
  capabilities: string[];
  connected: boolean;
  recommended: boolean;
  experimental: boolean;
  website?: string;
  authHint?: string;
  baseUrlDefault?: string;
  credentialOptional: boolean;
  connectable: boolean;
  connections: ProviderConnectionSummary[];
}

export interface AIModelSummary {
  id: string;
  upstreamId: string;
  providerId: string;
  providerName: string;
  name: string;
  capabilities: string[];
  added: boolean;
  local: boolean;
  installed?: boolean;
  freeStatus: ProviderFreeStatus;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface MarketplaceQuery {
  tab?: "connected" | "recommended" | "free" | "local" | "all";
  search?: string;
  type?: "cloud" | "local";
  auth?: ProviderAuthType;
  cost?: ProviderFreeStatus;
  capability?: string;
  offset?: number;
  limit?: number;
  refresh?: boolean;
}

export interface MarketplaceResponse {
  source: { version: string; commit: string; registryProviders: number; routableProviders: number };
  overview: { providers: number; models: number; connectedProviders: number; addedModels: number };
  counts: { connected: number; recommended: number; free: number; local: number; all: number };
  availableFilters: { auth: ProviderAuthType[]; cost: ProviderFreeStatus[]; capabilities: string[] };
  providers: AIProviderSummary[];
  pagination: { offset: number; limit: number; returned: number; total: number; hasMore: boolean };
}

export interface ProviderConnectInput {
  apiKey?: string;
  name?: string;
  baseUrl?: string;
  providerSpecificData?: Record<string, unknown>;
}

export interface OAuthStartResult {
  flowId: string;
  method: "device_code" | "authorization_code";
  authorizationUrl: string;
  userCode?: string;
  expiresIn?: number;
  interval?: number;
  message?: string;
}

export interface OAuthProgressResult {
  status: "pending" | "connected" | "error";
  message?: string;
}
