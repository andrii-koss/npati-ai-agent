import catalog from "./generated/provider-catalog.json";
import type {
  AIModelSummary,
  AIProviderSummary,
  MarketplaceQuery,
  ProviderAuthType,
  ProviderAvailability,
  ProviderConnectionMode,
  ProviderConnectionSummary,
  ProviderFreeStatus,
} from "./types";

type RegistryProvider = Record<string, unknown> & { id: string; category: string };
type ManifestModel = Record<string, unknown> & { id?: string; name?: string };
type ManifestProvider = Record<string, unknown> & {
  id: string;
  alias?: string;
  auth?: { type?: string };
  capabilities?: string[];
  models?: ManifestModel[];
};

// These adapters were verified against the generic provider endpoint exposed by
// the pinned OmniRoute runtime. Other no-auth catalog records need their own
// adapter/service lifecycle and must not be presented as ordinary connections.
const GENERIC_NO_AUTH_PROVIDER_IDS = new Set(["aihorde", "opencode"]);

export const RECOMMENDED_PROVIDER_IDS = [
  "openai", "gemini", "groq", "mistral", "ollama-local", "anthropic", "opencode", "openrouter",
] as const;

export const RECOMMENDED_CODING_AGENT_IDS = [
  "codex", "claude", "cursor", "github", "opencode", "zed", "kiro", "trae", "antigravity",
] as const;

export const EXCLUDED_GENERAL_AI_PROVIDER_IDS = new Set([
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "mistral",
  "deepseek",
  "openrouter",
  "ollama-local",
  "ollama-cloud",
  "xai",
  "cohere",
  "perplexity",
  "together",
  "fireworks",
  "nvidia",
  "huggingface",
  "ai21",
  "bedrock",
  "vertex",
  "azure-openai",
  "stability-ai",
  "elevenlabs",
  "assemblyai",
  "cerebras",
]);

export const KNOWN_CODING_AGENT_PROVIDER_IDS = new Set([
  "claude",
  "claude-code",
  "codex",
  "codex-app-server",
  "codex-cloud",
  "chatgpt-web-codex",
  "cursor",
  "cursor-api",
  "github",
  "ghe-copilot",
  "copilot-m365-web",
  "copilot-web",
  "zed",
  "zed-hosted",
  "opencode",
  "opencode-go",
  "opencode-zen",
  "trae",
  "kiro",
  "antigravity",
  "agy",
  "amazon-q",
  "command-code",
  "kilocode",
  "kimi-coding",
  "kimi-coding-apikey",
  "codebuddy-cn",
  "codestral",
  "cloudcode-one",
  "gitlab",
  "jules",
  "clinepass",
  "zcode",
  "bailian-coding-plan",
  "volcengine-coding-plan",
  "glm",
  "glm-cn",
  "minimax",
  "v0-vercel-web",
]);

export function isCodingAgentProvider(provider: { id: string; name?: string; alias?: string; category?: string; authHint?: string }): boolean {
  if (EXCLUDED_GENERAL_AI_PROVIDER_IDS.has(provider.id)) return false;
  if (KNOWN_CODING_AGENT_PROVIDER_IDS.has(provider.id)) return true;
  const s = `${provider.id} ${provider.name ?? ""} ${provider.alias ?? ""}`.toLowerCase();
  return /\b(coding|codex|claude-code|copilot|cursor|zed|kiro|trae|opencode)\b/i.test(s);
}

const POPULAR_PROVIDER_IDS = [
  "openai", "anthropic", "gemini", "xai", "openrouter", "groq", "mistral", "deepseek",
  "cohere", "perplexity", "cerebras", "together", "fireworks", "nvidia", "huggingface", "ai21",
  "bedrock", "vertex", "azure-openai", "ollama-cloud", "ollama-local", "stability-ai", "elevenlabs", "assemblyai",
] as const;

export const PINNED_PROVIDER_CATALOG = catalog as {
  sourceVersion: string;
  sourceCommit: string;
  providers: RegistryProvider[];
};

function authType(provider: RegistryProvider, manifest?: ManifestProvider): ProviderAuthType {
  if (provider.category === "local") return "local";
  if (provider.category === "oauth") return "oauth";
  if (provider.category === "noauth") return "none";
  if (provider.category === "web-cookie") return "web_session";
  if (provider.category === "system") return "other";
  const actual = manifest?.auth?.type;
  if (actual === "oauth") return "oauth";
  if (actual === "none") return "none";
  if (actual === "cookie") return "web_session";
  return "api_key";
}

function freeStatus(provider: RegistryProvider): ProviderFreeStatus {
  if (provider.noAuth === true && provider.hasFree === true) return "free";
  if (provider.hasFree === true) return "free_tier";
  return "unknown";
}

function connectionStatus(connections: ProviderConnectionSummary[]) {
  if (connections.some((connection) => connection.status === "connected")) return "connected" as const;
  if (connections.some((connection) => connection.status === "error")) return "error" as const;
  return connections.length > 0 ? "unknown" as const : "not_connected" as const;
}

export function isEmbeddingModel(model: ManifestModel | { id?: string; upstreamId?: string; type?: string; supportedEndpoints?: string[]; apiFormat?: string }): boolean {
  const id = String(model.upstreamId ?? model.id ?? "").toLowerCase();
  const type = String(model.type ?? "").toLowerCase();
  const apiFormat = String((model as any).apiFormat ?? (model as any).api_format ?? "").toLowerCase();
  const endpoints = Array.isArray((model as any).supportedEndpoints) ? (model as any).supportedEndpoints
    : Array.isArray((model as any).supported_endpoints) ? (model as any).supported_endpoints
    : [];
  if (type === "embedding" || type === "embeddings" || apiFormat === "embedding" || apiFormat === "embeddings") return true;
  if (endpoints.length > 0 && endpoints.every((ep: string) => String(ep).includes("embedding"))) return true;
  if (/\bembed(?:ding)?s?\b/i.test(id) || /-embed(?:ding)?-/i.test(id) || /_embed(?:ding)?_/i.test(id)) return true;
  return false;
}

export function isNonChatSpecialtyModel(model: ManifestModel | { id?: string; upstreamId?: string; type?: string; supportedEndpoints?: string[]; apiFormat?: string }): boolean {
  const id = String(model.upstreamId ?? model.id ?? "").toLowerCase();
  const type = String(model.type ?? "").toLowerCase();
  const apiFormat = String((model as any).apiFormat ?? (model as any).api_format ?? "").toLowerCase();
  const endpoints = Array.isArray((model as any).supportedEndpoints) ? (model as any).supportedEndpoints
    : Array.isArray((model as any).supported_endpoints) ? (model as any).supported_endpoints
    : [];

  if (isEmbeddingModel(model)) return true;
  if (type === "image" || type === "image_generation" || apiFormat === "image") return true;
  if (/\b(?:dall-?e|stable-diffusion|midjourney|flux|imagen|sdxl)\b/i.test(id) || /-image-/i.test(id)) return true;
  if (type === "audio" || type === "tts" || type === "stt" || type === "transcription" || apiFormat === "audio") return true;
  if (/\b(?:whisper|tts|speech)\b/i.test(id) || /-audio-/i.test(id) || /\btranscription\b/i.test(id)) return true;
  if (type === "rerank" || apiFormat === "rerank" || /\brerank(?:er)?\b/i.test(id)) return true;
  if (type === "moderation" || /\bmoderat(?:ion|e)\b/i.test(id)) return true;
  const capabilities = (model as { capabilities?: unknown }).capabilities;
  if (Array.isArray(capabilities) && capabilities.some((capability) => ["embedding", "image", "audio", "rerank", "moderation"].includes(String(capability).toLowerCase()))) return true;
  if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities) && Object.entries(capabilities).some(([key, enabled]) => enabled === true && ["embedding", "image", "audio", "rerank", "moderation"].includes(key.toLowerCase()))) return true;
  const hasChatEndpoint = endpoints.some((ep: string) => /chat|response|messages/i.test(ep));
  if (hasChatEndpoint) return false;
  if (endpoints.length > 0 && !hasChatEndpoint) return true;

  return false;
}

export function isChatCapableModel(model: ManifestModel | AIModelSummary | { id?: string; upstreamId?: string; capabilities?: string[]; type?: string; supportedEndpoints?: string[]; apiFormat?: string }): boolean {
  if (isNonChatSpecialtyModel(model as ManifestModel)) return false;
  const metadata = model as { id?: string; ownedBy?: string; owned_by?: string; parent?: string | null; outputModalities?: string[]; output_modalities?: string[]; apiFormat?: string; api_format?: string };
  if ((metadata.ownedBy ?? metadata.owned_by)?.toLowerCase() === "combo") return false;
  if (metadata.parent) return false;
  const output = metadata.outputModalities ?? metadata.output_modalities;
  if (output?.length && !output.includes("text")) return false;
  const format = (metadata.apiFormat ?? metadata.api_format)?.toLowerCase();
  if (format && /^(?:embeddings?|images?|image-generation|audio|tts|stt|transcription|rerank|moderation|completions?)$/.test(format)) return false;
  const endpoints = (model as { supportedEndpoints?: string[]; supported_endpoints?: string[] }).supportedEndpoints
    ?? (model as { supported_endpoints?: string[] }).supported_endpoints;
  if (Array.isArray(endpoints) && endpoints.length > 0 && !endpoints.some((endpoint) => /chat|response|messages/i.test(endpoint))) return false;
  const type = String((model as { type?: string }).type ?? "").toLowerCase();
  if (type === "completion" && !endpoints?.some((endpoint) => /chat|response|messages/i.test(endpoint))) return false;
  if (type && !["chat", "text", "llm", "language", "completion", "coding", "code"].includes(type)) return false;
  if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
    if (model.capabilities.includes("chat") || model.capabilities.includes("text") || model.capabilities.includes("coding")) {
      return !model.capabilities.includes("embedding")
        && !model.capabilities.includes("image")
        && !model.capabilities.includes("audio")
        && !model.capabilities.includes("rerank")
        && !model.capabilities.includes("moderation");
    }
    return false;
  }
  return true;
}

function modelCapabilities(model: ManifestModel): string[] {
  const result = new Set<string>();
  const id = String(model.id ?? "").toLowerCase();
  const isNonChat = !isChatCapableModel(model);

  if (isEmbeddingModel(model)) {
    result.add("embedding");
  } else if (/\b(?:dall-?e|stable-diffusion|midjourney|flux|imagen|sdxl)\b/i.test(id) || model.type === "image") {
    result.add("image");
  } else if (/\b(?:whisper|tts|speech)\b/i.test(id) || model.type === "audio") {
    result.add("audio");
  } else if (/\brerank(?:er)?\b/i.test(id) || model.type === "rerank") {
    result.add("rerank");
  } else if (/\bmoderat(?:ion|e)\b/i.test(id) || model.type === "moderation") {
    result.add("moderation");
  }

  if (!isNonChat) {
    result.add("text");
    result.add("chat");
    if (/\b(?:code|coder|coding|dev|script)\b/i.test(id)) {
      result.add("coding");
    }
  }

  if (model.supportsReasoning === true) result.add("reasoning");
  if (model.supportsVision === true) result.add("vision");
  if (model.toolCalling === true) result.add("tools");
  const capabilities = model.capabilities;
  if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)) {
    for (const [key, enabled] of Object.entries(capabilities as Record<string, unknown>)) {
      if (enabled === true) result.add(key.replace(/([a-z])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase());
    }
  }
  return [...result].sort();
}

function providerCapabilities(provider: RegistryProvider, manifest?: ManifestProvider): string[] {
  const result = new Set<string>();
  const kinds = Array.isArray(provider.serviceKinds) ? provider.serviceKinds : [];
  for (const kind of kinds) if (typeof kind === "string") result.add(kind === "llm" ? "text" : kind);
  if (provider.category === "local") result.add("text");
  for (const model of manifest?.models ?? []) for (const value of modelCapabilities(model)) result.add(value);
  return [...result].sort();
}

function connectionMetadata(provider: RegistryProvider, auth: ProviderAuthType, connected: boolean): {
  connectionMode: ProviderConnectionMode;
  availability: ProviderAvailability;
  availabilityReason?: string;
  connectable: boolean;
} {
  const embedded = provider.isEmbeddedService === true || provider.category === "upstream-proxy";
  const localCli = provider.isLocalCli === true;
  const connectionMode: ProviderConnectionMode = provider.category === "system" ? "internal"
    : embedded ? "embedded_service"
    : localCli ? "local_cli"
    : provider.category === "cloud-agent" ? "cloud_agent"
    : auth === "oauth" ? "oauth"
    : auth === "web_session" ? "web_session"
    : auth === "local" ? "local"
    : auth === "none" ? "no_auth"
    : "api_key";

  if (connected) return { connectionMode, availability: "connected", connectable: true };
  if (connectionMode === "internal") return {
    connectionMode, availability: "internal", connectable: false,
    availabilityReason: "Internal routing entry; it is selected by NPATI automatically and is not connected manually.",
  };
  if (connectionMode === "embedded_service") return {
    connectionMode, availability: "requires_service", connectable: false,
    availabilityReason: "This is an embedded OmniRoute service. Install and start the service before synchronizing its models.",
  };
  if (connectionMode === "local_cli") return {
    connectionMode, availability: "requires_local_runtime", connectable: false,
    availabilityReason: "This provider requires its CLI to be installed and authenticated inside the OmniRoute runtime.",
  };
  if (connectionMode === "no_auth" && !GENERIC_NO_AUTH_PROVIDER_IDS.has(provider.id)) return {
    connectionMode, availability: "unavailable", connectable: false,
    availabilityReason: "The installed OmniRoute generic connection API does not support connecting this no-auth adapter.",
  };
  if (connectionMode === "oauth") return { connectionMode, availability: "requires_login", connectable: true };
  if (connectionMode === "web_session") return { connectionMode, availability: "requires_login", connectable: true };
  if (connectionMode === "local") return { connectionMode, availability: "requires_local_runtime", connectable: true };
  if (connectionMode === "api_key" || connectionMode === "cloud_agent") return { connectionMode, availability: "requires_credentials", connectable: true };
  return { connectionMode, availability: "ready", connectable: true };
}

export function normalizeCatalog(
  manifestProviders: ManifestProvider[],
  connections: ProviderConnectionSummary[],
  localHealth: Record<string, unknown> = {},
): AIProviderSummary[] {
  const manifest = new Map(manifestProviders.map((provider) => [provider.id, provider]));
  const connectionMap = new Map<string, ProviderConnectionSummary[]>();
  for (const connection of connections) {
    const list = connectionMap.get(connection.providerId) ?? [];
    list.push(connection);
    connectionMap.set(connection.providerId, list);
  }

  return PINNED_PROVIDER_CATALOG.providers.map((provider) => {
    const plugin = manifest.get(provider.id);
    const providerConnections = connectionMap.get(provider.id) ?? [];
    const local = provider.category === "local";
    const localRuntime = localHealth[provider.id];
    const auth = authType(provider, plugin);
    const metadata = connectionMetadata(provider, auth, providerConnections.length > 0);
    const modelCount = new Set((plugin?.models ?? []).map((model) => model.id).filter(Boolean)).size;
    return {
      id: provider.id,
      name: typeof provider.name === "string" ? provider.name : provider.id,
      description: typeof provider.freeNote === "string" ? provider.freeNote : undefined,
      category: provider.category,
      authType: auth,
      connectionStatus: connectionStatus(providerConnections),
      freeStatus: freeStatus(provider),
      local,
      localStatus: local
        ? localRuntime && typeof localRuntime === "object"
          ? (localRuntime as { running?: boolean }).running === true ? "running" : "not_detected"
          : providerConnections.length ? "needs_configuration" : "not_detected"
        : undefined,
      modelCount,
      capabilities: providerCapabilities(provider, plugin),
      connected: providerConnections.length > 0,
      recommended: (RECOMMENDED_PROVIDER_IDS as readonly string[]).includes(provider.id),
      experimental: provider.deprecated === true || provider.riskNoticeVariant === "deprecated",
      website: typeof provider.website === "string" ? provider.website : undefined,
      authHint: typeof provider.authHint === "string" ? provider.authHint : undefined,
      baseUrlDefault: typeof provider.localDefault === "string" ? provider.localDefault : undefined,
      credentialOptional: auth === "none" || auth === "local" || plugin?.auth?.type === "optional",
      connectable: metadata.connectable,
      connectionMode: metadata.connectionMode,
      availability: metadata.availability,
      availabilityReason: metadata.availabilityReason,
      connections: providerConnections,
    };
  });
}

export function normalizeModels(
  provider: AIProviderSummary,
  models: ManifestModel[],
  addedIds: Set<string> = new Set(),
): AIModelSummary[] {
  const seen = new Set<string>();
  const result: AIModelSummary[] = [];
  for (const raw of models) {
    const upstreamId = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!upstreamId) continue;
    const id = `${provider.id}/${upstreamId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      upstreamId,
      providerId: provider.id,
      providerName: provider.name,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : upstreamId,
      capabilities: modelCapabilities(raw),
      added: addedIds.has(id),
      local: provider.local,
      installed: provider.local ? provider.localStatus === "running" : undefined,
      freeStatus: raw.free === true ? "free" : provider.freeStatus,
      contextWindow: typeof raw.contextLength === "number" ? raw.contextLength : typeof raw.context_length === "number" ? raw.context_length : undefined,
      maxOutputTokens: typeof raw.maxOutputTokens === "number" ? raw.maxOutputTokens : typeof raw.max_output_tokens === "number" ? raw.max_output_tokens : undefined,
    });
  }
  return result;
}

function searchRelevance(provider: AIProviderSummary, needle: string): number {
  const id = provider.id.toLowerCase();
  const name = provider.name.toLowerCase();

  // 1. Exact ID or Name match -> top priority (e.g. searching "openai" -> provider "openai")
  if (id === needle || name === needle) return 1000;

  // 2. Starts with ID or Name -> second priority (e.g. "openai-codex", "OpenAI Codex")
  if (id.startsWith(needle) || name.startsWith(needle)) return 600;

  // 3. Name or ID contains needle (e.g. "Azure OpenAI")
  if (name.includes(needle) || id.includes(needle)) return 300;

  // 4. Description or auth matches
  if (provider.description?.toLowerCase().includes(needle) || provider.authHint?.toLowerCase().includes(needle)) return 100;

  // 5. Capability matches
  if (provider.capabilities.some((c) => c.toLowerCase().includes(needle))) return 50;

  // 6. Model ID / model name matches
  return 10;
}

export function filterProviders(
  providers: AIProviderSummary[],
  manifestProviders: ManifestProvider[],
  query: MarketplaceQuery,
): AIProviderSummary[] {
  const manifest = new Map(manifestProviders.map((provider) => [provider.id, provider]));
  const needle = query.search?.trim().toLowerCase();
  const filtered = providers.filter((provider) => {
    if (query.scope === "code" && !isCodingAgentProvider(provider)) return false;
    if (query.scope === "ai" && isCodingAgentProvider(provider)) return false;
    if (query.connectableOnly && !provider.connected && (
      !provider.connectable || provider.connectionMode === "web_session"
    )) return false;
    if (query.tab === "connected" && !provider.connected) return false;
    if (query.tab === "recommended" && !provider.recommended) return false;
    if (query.tab === "free" && !["free", "free_tier"].includes(provider.freeStatus)) return false;
    if (query.tab === "local" && !provider.local) return false;
    if (query.type === "local" && !provider.local) return false;
    if (query.type === "cloud" && provider.local) return false;
    if (query.auth && provider.authType !== query.auth) return false;
    if (query.cost && provider.freeStatus !== query.cost) return false;
    if (query.capability && !provider.capabilities.includes(query.capability)) return false;
    if (needle) {
      const plugin = manifest.get(provider.id);
      const haystack = [
        provider.id, provider.name, provider.category, provider.authType,
        ...provider.capabilities,
        ...(plugin?.models ?? []).flatMap((model) => [model.id ?? "", model.name ?? "", ...modelCapabilities(model)]),
      ].join(" ").toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  if (needle) {
    return [...filtered].sort((a, b) => {
      const aScore = searchRelevance(a, needle);
      const bScore = searchRelevance(b, needle);
      if (bScore !== aScore) return bScore - aScore;
      if (a.connected !== b.connected) return (b.connected ? 1 : 0) - (a.connected ? 1 : 0);
      if (a.recommended !== b.recommended) return (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0);
      return a.name.localeCompare(b.name);
    });
  }

  if (query.tab === "recommended") {
    const list = query.scope === "code" ? RECOMMENDED_CODING_AGENT_IDS : RECOMMENDED_PROVIDER_IDS;
    const order = new Map((list as readonly string[]).map((id, index) => [id, index]));
    return [...filtered].sort((a, b) => {
      const aIdx = order.get(a.id) ?? 999;
      const bIdx = order.get(b.id) ?? 999;
      return aIdx - bIdx;
    });
  }

  if (query.tab === "all" || query.tab === undefined) {
    const list = query.scope === "code" ? RECOMMENDED_CODING_AGENT_IDS : POPULAR_PROVIDER_IDS;
    const order = new Map((list as readonly string[]).map((id, index) => [id, index]));
    return [...filtered].sort((a, b) => {
      const aIdx = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bIdx = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (aIdx !== bIdx) return aIdx - bIdx;
      if (a.connected !== b.connected) return (b.connected ? 1 : 0) - (a.connected ? 1 : 0);
      return a.name.localeCompare(b.name);
    });
  }

  return filtered;
}
