import { isChatCapableModel, type AIModelSummary, type ModelInfo } from "@npati/omniroute-adapter";

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

/** Revalidate stored image claims against the existing provider catalog before sending any image bytes. */
export async function confirmedVisionInferenceCandidates(
  configured: Array<string | null | undefined>, added: AIModelSummary[],
  loadModels?: (providerId: string) => Promise<AIModelSummary[]>,
): Promise<string[]> {
  if (!loadModels) return [];
  const providers = [...new Set(added.filter(model => model.capabilities.includes("vision") || configured.includes(model.id)).map(model => model.providerId))];
  const fresh = (await Promise.all(providers.map(provider => loadModels(provider).catch(() => [])))).flat();
  return visionInferenceCandidates(configured, added, fresh)
    .filter(id => fresh.some(model => model.id === id && model.capabilities.includes("vision")));
}
