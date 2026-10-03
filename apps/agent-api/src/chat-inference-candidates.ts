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
