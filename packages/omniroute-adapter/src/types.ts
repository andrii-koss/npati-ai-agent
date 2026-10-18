import type { ServiceHealth } from "@npati/shared";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ChatToolCall[];
  /** Opaque provider continuation, never user-visible answer content. */
  reasoning_content?: string;
  reasoning_text?: string;
}

export type ChatToolChoice = "auto" | "none" | "required" | {
  type: "function";
  function: { name: string };
};

export interface ChatRequest {
  /** Best-effort metadata observer; never receives credentials, prompts or provider bodies. */
  onProviderAttempt?: (event: {model:string;phase:"started"|"completed"|"failed";durationMs?:number;httpStatus?:number;errorCode?:string;retryScheduled?:boolean}) => void | Promise<void>;
  messages: ChatMessage[];
  model?: string;
  fallbackModel?: string;
  tools?: ChatToolDefinition[];
  toolChoice?: ChatToolChoice;
  temperature?: number;
  compression?: "off" | "default" | "engine:rtk";
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
  admission?: {
    tier?: "critical-orchestration" | "enterprise" | "pro" | "free";
    tenantId?: string;
    queueTimeoutMs?: number;
  };
}

export interface A2AMessageRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string;
  combo?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface A2AMessageResult {
  taskId: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface MCPToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type OmniRouteComboStep =
  | string
  | { kind?: "model"; model: string; prompt?: string; label?: string }
  | { kind: "combo-ref"; comboName: string; label?: string };

export interface OmniRouteComboInput {
  name: string;
  description?: string;
  models: OmniRouteComboStep[];
  strategy: "priority" | "pipeline" | "fusion";
  config?: Record<string, unknown>;
  system_message?: string;
  tool_filter_regex?: string;
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

export type SpeechAudioFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

export interface SpeechSynthesisInput {
  text: string;
  model?: string;
  voice?: string;
  speed?: number;
  format?: SpeechAudioFormat;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SpeechSynthesisResult {
  data: Uint8Array;
  mimeType: string;
  model: string;
  voice: string;
  format: SpeechAudioFormat;
}

export interface EmbeddingInput { input: string[]; model?: string; signal?: AbortSignal; timeoutMs?: number; }
export interface EmbeddingResult { model: string; vectors: number[][]; usage?: Record<string, number>; }
export interface ModerationInput { input: string[]; model?: string; signal?: AbortSignal; timeoutMs?: number; }
export interface ModerationResult {
  id?: string;
  model: string;
  results: Array<{
    flagged: boolean;
    categories: Record<string, boolean>;
    categoryScores: Record<string, number>;
    categoryAppliedInputTypes?: Record<string, string[]>;
  }>;
}
export interface RerankInput { query: string; documents: string[]; model?: string; topN?: number; signal?: AbortSignal; timeoutMs?: number; }
export interface RerankResult { model: string; results: Array<{ index: number; relevanceScore: number }>; }

export interface ChatResult {
  content: string;
  toolCalls?: ChatToolCall[];
  finishReason?: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
  };
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
  };
}

export interface OmniRouteResilienceSnapshot {
  source: "omniroute";
  configuration: {
    requestQueue?: unknown;
    connectionCooldown?: unknown;
    providerBreaker?: unknown;
    waitForCooldown?: unknown;
    comboCooldownWait?: unknown;
    quotaShareConcurrencyLimit?: unknown;
    providerCooldown?: unknown;
    providerQuotaOverrides?: unknown;
  };
  runtime: {
    status: string;
    providerBreakers: unknown[];
    lockouts: unknown[];
    adaptiveAdmission: unknown;
    chatAdmission: unknown;
  };
}

export interface ModelInfo {
  id: string;
  name?: string;
  type?: string;
  apiFormat?: string;
  capabilities?: string[];
  supportedEndpoints?: string[];
  outputModalities?: string[];
  ownedBy?: string;
  parent?: string | null;
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
  supportsNativeTools?(model?: string): boolean;
  chat(request: ChatRequest): Promise<ChatResult>;
  stream(request: ChatRequest): AsyncIterable<string>;
  listModels(): Promise<ModelInfo[]>;
  getModel(id: string): Promise<ModelInfo | undefined>;
  executeTool(name: string, input: unknown): Promise<unknown>;
  moderate?(input: ModerationInput): Promise<ModerationResult>;
  embed?(input: EmbeddingInput): Promise<EmbeddingResult>;
  rerank?(input: RerankInput): Promise<RerankResult>;
  searchMemory(query: string): Promise<unknown[]>;
  saveMemory(value: unknown): Promise<void>;
  getCapabilities(): Promise<string[]>;
  healthCheck(): Promise<ServiceHealth>;
  resilienceStatus?(): Promise<OmniRouteResilienceSnapshot>;
  transcribeAudio?(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult>;
  synthesizeSpeech?(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult>;
  a2aSend?(request: A2AMessageRequest): Promise<A2AMessageResult>;
  cancelA2ATask?(taskId: string, signal?: AbortSignal): Promise<void>;
  ensureA2AEnabled?(): Promise<void>;
  ensureCombo?(input: OmniRouteComboInput, signal?: AbortSignal): Promise<{ name: string }>;
  ensureMCPEnabled?(): Promise<void>;
  mcpCall?(request: MCPToolCallRequest): Promise<unknown>;
  webSearch?(input: WebSearchInput): Promise<WebSearchResponse>;
  webFetch?(input: WebFetchInput): Promise<WebPageResult>;
}

export interface OmniRouteConfig {
  baseUrl?: string;
  apiKey?: string;
  managementPassword?: string;
  timeoutMs?: number;
  catalogTtlMs?: number;
  transcriptionModel?: string;
  ttsModel?: string;
  embeddingModel?: string;
  rerankModel?: string;
}

export type ProviderAuthType = "api_key" | "oauth" | "none" | "local" | "web_session" | "other";
export type ProviderConnectionStatus = "connected" | "not_connected" | "error" | "unknown";
export type ProviderFreeStatus = "free" | "free_tier" | "paid" | "unknown";
export type LocalProviderStatus = "running" | "not_detected" | "needs_configuration" | "unknown";
export type ProviderConnectionMode = "api_key" | "oauth" | "no_auth" | "web_session" | "local" | "local_cli" | "embedded_service" | "cloud_agent" | "internal";
export type ProviderAvailability = "connected" | "ready" | "requires_credentials" | "requires_login" | "requires_local_runtime" | "requires_service" | "unavailable" | "internal";

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
  connectionMode: ProviderConnectionMode;
  availability: ProviderAvailability;
  availabilityReason?: string;
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
  scope?: "all" | "ai" | "code";
  connectableOnly?: boolean;
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
