/* Client-safe chat and company-run messages.
 * Extracted verbatim from app.ts (step 2a of docs/refactoring/PLAN.md).
 */
import { detectCompanyChatLanguage, resolveConversationLanguage, type CompanyChatLanguage } from "./company-chat-i18n";
import { companyRunNotices } from "./company-run-notice-i18n";
import { providerErrorCopy, type ProviderFailureReason } from "./chat-provider-error-i18n";
import { InferenceRouteFailure } from "./production-resilient-ai-engine";
import { SelfHealingExhaustedError } from "./resilience-admission-queue";

/**
 * The language of a failure notice. A short Latin-script message ("Try again", "Hello") does not reliably show its language,
 * so it gets English unless it carries letters only one language uses; other scripts are unambiguous.
 */
function noticeLanguage(message: string) {
  const language = resolveConversationLanguage(message, []);
  const latinLanguages = ["fr", "de", "es", "it", "pl", "pt", "nl", "tr"];
  if (!latinLanguages.includes(language)) return language;
  const letters = (message.match(/\p{L}/gu) ?? []).length;
  return letters >= 24 || /[äöüßñ¿¡ãõçœèêëîïûùąćęłńśźżğış]/iu.test(message) ? language : "en";
}

/** `requestMessage` decides the language of the provider failure text, so it matches the language the person writes in. */
export function publicChatError(error: unknown, route?: string, requestMessage = "") {
  const raw = error instanceof InferenceRouteFailure && error.cause instanceof Error
    ? error.cause.message
    : error instanceof Error ? error.message : String(error);
  if (/Invalid file format/i.test(raw)) {
    return "The audio container does not match the file extension. Convert or export the file as M4A/AAC, MP3, WAV, WEBM, OGG, or FLAC and try again.";
  }
  if (/Unsupported audio format/i.test(raw)) {
    return "This audio format is not supported. Upload M4A, MP3, WAV, WEBM, OGG, AAC, or FLAC.";
  }
  if (/audio transcription|transcribe|transcription/i.test(raw)) {
    return "The voice message could not be transcribed. Check the audio file and try again.";
  }
  if (error instanceof InferenceRouteFailure || error instanceof SelfHealingExhaustedError) return providerFailureText(error, raw, route, noticeLanguage(requestMessage));
  return providerErrorCopy(noticeLanguage(requestMessage)).generic;
}

/** The localized provider failure: which route failed, its HTTP status and what to do, without the provider's raw text. */
function providerFailureText(error: unknown, raw: string, route: string | undefined, language: CompanyChatLanguage) {
  const attempts = error instanceof InferenceRouteFailure
    ? error.attempts
    : error instanceof SelfHealingExhaustedError
      ? error.attempts.filter((attempt) => !attempt.success).map((attempt) => ({
          modelId: attempt.modelId,
          httpStatus: Number(/\bHTTP\s+(\d{3})\b/i.exec(attempt.error ?? "")?.[1]) || undefined,
        }))
      : [];
  const selected = attempts[0]?.modelId ?? route;
  const routeName = selected && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,100}$/.test(selected) ? selected : "NPATI";
  const status = Number(/\bAPI\s*\[(\d{3})\]/i.exec(raw)?.[1]) || attempts[0]?.httpStatus || (Number(/\bHTTP\s+(\d{3})\b/i.exec(raw)?.[1]) || undefined);
  const fallback = attempts.length > 1 ? attempts.at(-1) : undefined;
  const text = providerErrorCopy(language);
  const fallbackLabel = fallback?.modelId && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,100}$/.test(fallback.modelId) ? text.fallback(fallback.modelId, fallback.httpStatus) : "";
  // A provider outage (5xx, timeout) is temporary: the advice is to try again, not to change the AI mode.
  const reason: ProviderFailureReason = /no active credentials for provider/i.test(raw) ? "noCredential"
    : status === 401 || status === 403 ? "denied"
    : status === 404 ? "notFound"
    : status === 429 ? "rateLimit"
    : status === 400 ? "rejected"
    : (status !== undefined && status >= 500) || /timed? ?out|ECONNRESET|ECONNREFUSED|unavailable|overload/i.test(raw) ? "unavailable"
    : selected?.startsWith("auto") ? "switchMode" : "tryAgain";
  return `${text.failed(routeName, status)}${fallbackLabel} ${text.reasons[reason]}`;
}

/**
 * A coding run whose model call failed. The run showed the adapter's raw English text ("OmniRoute chat failed with
 * HTTP 402: [deepseek] … credits exhausted") to a Russian or Chinese user (V6 step 13).
 */
export function codingProviderFailureMessage(error: unknown, route: string | undefined, language: CompanyChatLanguage = "en") {
  const raw = error instanceof InferenceRouteFailure && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error);
  const plainStatus = /\bHTTP\s+\d{3}\b/i.test(raw) || /\bAPI\s*\[\d{3}\]/i.test(raw);
  if (error instanceof InferenceRouteFailure || error instanceof SelfHealingExhaustedError || plainStatus) return providerFailureText(error, raw, route, language);
  // Other failures (a policy guard such as provider_data_classification_exceeded) keep their own reason.
  return raw || providerErrorCopy(language).generic;
}

/** Run failures caused by the company's own configuration or policy, not by the AI model. */
const COMPANY_RUN_POLICY_ERRORS = new Set(["TOOL_FORBIDDEN", "NO_MEMORY_TOOL_FORBIDDEN", "COMPANY_INACTIVE", "CONTEXT_DELETED", "MAIN_AGENT_INACTIVE", "PERMISSION_REVOKED", "RUN_CANCELLED", "SECURITY_GUARDRAIL_BLOCKED",
  "CIRCULAR_DELEGATION", "CROSS_COMPANY_AGENT_SELECTION", "INVALID_DELEGATION_PLAN", "INVALID_REVIEWER", "TOO_MANY_DELEGATES", "TOOL_LOOP_DETECTED", "BOUND_AGENT_UNAVAILABLE", "AGENT_DELETED",
  "APPROVAL_REQUIRED", "APPROVAL_INVALID", "APPROVAL_ALREADY_USED", "APPROVAL_EXPIRED", "RUN_IDENTITY_MISMATCH",
  // V6 step 11: "Knowledge is disabled for the Main Agent" was shown as "the selected AI model is temporarily unavailable".
  "KNOWLEDGE_PERMISSION_REQUIRED", "PROJECT_SCOPE_MISMATCH", "INVALID_TOOL_AGENT", "EXEC_REVIEW_BLOCKED"]);

export function publicCompanyRunMessage(result: string | null | undefined, errorMessage: string | null | undefined, requestMessage: string, errorCode?: string | null) {
  if (result?.trim()) return result;
  const text = companyRunNotices(detectCompanyChatLanguage(requestMessage));
  if (!errorMessage?.trim()) return text.completed;
  if (errorCode && COMPANY_RUN_POLICY_ERRORS.has(errorCode)) return text.notCompleted + errorMessage.trim().slice(0, 300);
  return text.unavailable;
}

// The sources label follows the conversation language: an English answer ended with "Джерела:" (V6 step 11).
const SOURCES_LABEL: Record<string, string> = { en: "Sources", uk: "Джерела", ru: "Источники", de: "Quellen", fr: "Sources", es: "Fuentes", it: "Fonti", pl: "Źródła", pt: "Fontes", nl: "Bronnen", tr: "Kaynaklar", zh: "来源", ja: "出典", ko: "출처", ar: "المصادر", hi: "स्रोत" };
export function attachResearchSources(content: string, research?: { sources: Array<{ url: string; title?: string }> }, language = "uk") {
  if (!research?.sources.length) return content;
  const unique = [...new Map(research.sources.map((item) => [item.url, item])).values()];
  const existingUrls = new Set((content.match(/https?:\/\/[^\s<>()]+/g) ?? []).map((url) => url.replace(/[.,;!?]+$/, "")));
  const missing = unique.filter((item) => !existingUrls.has(item.url));
  if (!missing.length) return content;
  return content + "\n\n" + (SOURCES_LABEL[language] ?? SOURCES_LABEL.en) + ":\n" + missing.map((item) => {
    const rawTitle = item.title?.replace(/[\[\]\r\n]+/g, " ").trim() || item.url;
    return "- [" + rawTitle + "](" + item.url + ")";
  }).join("\n");
}


/**
 * The answer when the page a user asked to analyse could not be opened. Built here rather than by the model: with
 * no page content, models describe a familiar site from memory, which reads like an analysis of the live page.
 */
export function unreachablePageMessage(target: string, error: string | undefined, requestMessage: string) {
  const reason = (error ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return companyRunNotices(detectCompanyChatLanguage(requestMessage)).unreachable(target, reason ? ": " + reason : ".");
}

/** The answer when a web search the user asked for returned nothing usable; see `unreachablePageMessage`. */
export function webResearchFailedMessage(error: string | undefined, requestMessage: string) {
  const reason = (error ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return companyRunNotices(detectCompanyChatLanguage(requestMessage)).researchFailed(reason ? ": " + reason : ".");
}
