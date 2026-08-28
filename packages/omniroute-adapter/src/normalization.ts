import catalog from "./generated/provider-catalog.json";
import type {
  AIModelSummary,
  AIProviderSummary,
  MarketplaceQuery,
  ProviderAuthType,
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

export const RECOMMENDED_PROVIDER_IDS = [
  "openai", "anthropic", "gemini", "openrouter", "groq", "mistral", "opencode", "ollama-local",
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

function modelCapabilities(model: ManifestModel): string[] {
  const result = new Set<string>(["text"]);
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
      connectable: provider.category !== "system",
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

export function filterProviders(
  providers: AIProviderSummary[],
  manifestProviders: ManifestProvider[],
  query: MarketplaceQuery,
): AIProviderSummary[] {
  const manifest = new Map(manifestProviders.map((provider) => [provider.id, provider]));
  const needle = query.search?.trim().toLowerCase();
  return providers.filter((provider) => {
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
}
