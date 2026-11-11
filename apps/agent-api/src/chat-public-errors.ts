/* Client-safe chat and company-run messages.
 * Extracted verbatim from app.ts (step 2a of docs/refactoring/PLAN.md).
 */
import { detectCompanyChatLanguage, resolveConversationLanguage } from "./company-chat-i18n";
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
  if (error instanceof InferenceRouteFailure || error instanceof SelfHealingExhaustedError) {
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
    const text = providerErrorCopy(noticeLanguage(requestMessage));
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
  return providerErrorCopy(noticeLanguage(requestMessage)).generic;
}

/** Run failures caused by the company's own configuration or policy, not by the AI model. */
const COMPANY_RUN_POLICY_ERRORS = new Set(["TOOL_FORBIDDEN", "NO_MEMORY_TOOL_FORBIDDEN", "COMPANY_INACTIVE", "CONTEXT_DELETED", "MAIN_AGENT_INACTIVE", "PERMISSION_REVOKED", "RUN_CANCELLED", "SECURITY_GUARDRAIL_BLOCKED",
  "CIRCULAR_DELEGATION", "CROSS_COMPANY_AGENT_SELECTION", "INVALID_DELEGATION_PLAN", "INVALID_REVIEWER", "TOO_MANY_DELEGATES", "TOOL_LOOP_DETECTED", "BOUND_AGENT_UNAVAILABLE", "AGENT_DELETED",
  "APPROVAL_REQUIRED", "APPROVAL_INVALID", "APPROVAL_ALREADY_USED", "APPROVAL_EXPIRED", "RUN_IDENTITY_MISMATCH"]);

export function publicCompanyRunMessage(result: string | null | undefined, errorMessage: string | null | undefined, requestMessage: string, errorCode?: string | null) {
  if (result?.trim()) return result;
  if (!errorMessage?.trim()) return "Company run completed.";
  const language = detectCompanyChatLanguage(requestMessage);
  if (errorCode && COMPANY_RUN_POLICY_ERRORS.has(errorCode)) {
    const reason = errorMessage.trim().slice(0, 300);
    if (language === "uk") return `Завдання компанії не виконано: ${reason}`;
    if (language === "ru") return `Задача компании не выполнена: ${reason}`;
    return `The company task was not completed: ${reason}`;
  }
  if (language === "uk") return "Не вдалося виконати завдання компанії через тимчасову недоступність вибраної AI-моделі. Перевірте підключення вибраної моделі в AI Marketplace і спробуйте ще раз.";
  if (language === "ru") return "Не удалось выполнить задачу компании из-за временной недоступности выбранной AI-модели. Проверьте подключение выбранной модели в AI Marketplace и попробуйте снова.";
  return "The company task could not be completed because the selected AI model is temporarily unavailable. Check the selected model connection in AI Marketplace, then try again.";
}

export function attachResearchSources(content: string, research?: { sources: Array<{ url: string; title?: string }> }) {
  if (!research?.sources.length) return content;
  const unique = [...new Map(research.sources.map((item) => [item.url, item])).values()];
  const existingUrls = new Set((content.match(/https?:\/\/[^\s<>()]+/g) ?? []).map((url) => url.replace(/[.,;!?]+$/, "")));
  const missing = unique.filter((item) => !existingUrls.has(item.url));
  if (!missing.length) return content;
  return content + "\n\nДжерела:\n" + missing.map((item) => {
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
  const language = detectCompanyChatLanguage(requestMessage);
  if (language === "uk") return `Не вдалося відкрити сторінку ${target}${reason ? ": " + reason : "."}\n\nБез її вмісту я не аналізую сайт, щоб не вигадувати висновки. Перевірте адресу та доступність сайту або надішліть скріншот чи HTML сторінки.`;
  if (language === "ru") return `Не удалось открыть страницу ${target}${reason ? ": " + reason : "."}\n\nБез её содержимого я не анализирую сайт, чтобы не выдумывать выводы. Проверьте адрес и доступность сайта или пришлите скриншот или HTML страницы.`;
  return `The page ${target} could not be opened${reason ? ": " + reason : "."}\n\nWithout its content I will not analyse the site, so as not to invent findings. Check the address and that the site is reachable, or send a screenshot or the page HTML.`;
}

/** The answer when a web search the user asked for returned nothing usable; see `unreachablePageMessage`. */
export function webResearchFailedMessage(error: string | undefined, requestMessage: string) {
  const reason = (error ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const language = detectCompanyChatLanguage(requestMessage);
  if (language === "uk") return `Вебпошук не дав результатів, на які можна спертися${reason ? ": " + reason : "."}\n\nБез знайдених сторінок я не роблю висновків, щоб не вигадувати. Спробуйте уточнити запит або назвіть конкретні сайти.`;
  if (language === "ru") return `Веб-поиск не дал результатов, на которые можно опереться${reason ? ": " + reason : "."}\n\nБез найденных страниц я не делаю выводов, чтобы не выдумывать. Уточните запрос или назовите конкретные сайты.`;
  return `The web search returned nothing usable${reason ? ": " + reason : "."}\n\nWithout retrieved pages I will not draw conclusions, so as not to invent findings. Refine the request or name specific sites.`;
}
