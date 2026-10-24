import { isChatCapableModel, type AIModelSummary, type ModelInfo, type OmniRouteMarketplace } from "@npati/omniroute-adapter";

/** Models eligible for the chat inference interface, ordered by user preference. */
export function chatInferenceCandidates(
  configured: Array<string | null | undefined>,
  added: AIModelSummary[],
  available: ModelInfo[],
): string[] {
  const known = new Map<string, AIModelSummary | ModelInfo>([...added, ...available].map((model) => [model.id, model]));
  const ordered = [...added.map((model) => model.id), ...configured, ...available.map((model) => model.id)];
  return [...new Set(ordered.filter((id): id is string => Boolean(id && id !== "auto" && !id.startsWith("auto/"))))]
    .filter((id) => isChatCapableModel(known.get(id) ?? { id }));
}

export function isUnavailableInferenceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:401|403|404)\b|unsupported|not a chat model|model_unavailable|model.*(?:missing|not found|disabled|invalid)|auth|unauthorized|no.*credentials/i.test(message);
}

/** Prefer the selected, known vision-capable model; text-only or unknown defaults cannot consume photos. */
export function visionInferenceCandidates(configured: Array<string | null | undefined>, added: AIModelSummary[], available: ModelInfo[] = []): string[] {
  const known = new Map<string, AIModelSummary | ModelInfo>([...added, ...available].map(model => [model.id, model]));
  const eligible = chatInferenceCandidates(configured, added, available);
  return [...new Set([...configured, ...eligible])].filter((id): id is string => !!id && eligible.includes(id)
    && known.get(id)?.capabilities?.includes("vision") === true);
}

/**
 * Vision models confirmed by the refreshed catalog of every provider the user connected (not only providers whose
 * stored models claim vision): the configured models first, then added ones, then the remaining confirmed models.
 * A stored or configured claim alone never qualifies, so image bytes only reach a model the provider says can see.
 */
export async function confirmedVisionInferenceCandidates(
  configured: Array<string | null | undefined>, added: AIModelSummary[],
  catalog?: Pick<OmniRouteMarketplace, "models">,
): Promise<string[]> {
  if (!catalog) return [];
  const providerOf = (id: string) => added.find(model => model.id === id)?.providerId ?? id.split("/")[0]!;
  const providers = [...new Set([...added.map(model => model.providerId), ...configured.filter((id): id is string => !!id).map(providerOf)])].filter(Boolean);
  const fresh = (await Promise.all(providers.map(provider => catalog.models(provider, [], true).catch(() => [])))).flat();
  const confirmed = new Set(fresh.filter(model => model.capabilities.includes("vision") && isChatCapableModel(model)).map(model => model.id));
  return [...new Set([...configured, ...added.map(model => model.id), ...fresh.map(model => model.id)])]
    .filter((id): id is string => !!id && confirmed.has(id));
}

/** The confirmed vision model of a connected provider that receives image bytes, or undefined when there is none. */
export async function resolveConfirmedVisionModel(
  configured: Array<string | null | undefined>, added: AIModelSummary[],
  catalog?: Pick<OmniRouteMarketplace, "models" | "provider">,
): Promise<string | undefined> {
  if (!catalog) return undefined;
  for (const id of await confirmedVisionInferenceCandidates(configured, added, catalog)) {
    const providerId = added.find(model => model.id === id)?.providerId ?? id.split("/")[0]!;
    if ((await catalog.provider(providerId).catch(() => null))?.connected) return id;
  }
  return undefined;
}
