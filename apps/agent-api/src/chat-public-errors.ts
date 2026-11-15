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

const FORMATS = "M4A, MP3, WAV, WEBM, OGG, AAC, FLAC";
const AUDIO_COPY: Record<CompanyChatLanguage, { transcribe: string; format: string; container: string }> = {
  en: { transcribe: "The voice message could not be transcribed. Check the audio file and try again.", format: `This audio format is not supported. Upload ${FORMATS}.`, container: `The audio container does not match the file extension. Export the file as ${FORMATS} and try again.` },
  uk: { transcribe: "Не вдалося розпізнати голосове повідомлення. Перевірте аудіофайл і спробуйте ще раз.", format: `Цей аудіоформат не підтримується. Завантажте ${FORMATS}.`, container: `Вміст аудіофайлу не відповідає його розширенню. Збережіть файл як ${FORMATS} і спробуйте ще раз.` },
  ru: { transcribe: "Не удалось распознать голосовое сообщение. Проверьте аудиофайл и попробуйте ещё раз.", format: `Этот аудиоформат не поддерживается. Загрузите ${FORMATS}.`, container: `Содержимое аудиофайла не соответствует расширению. Сохраните файл как ${FORMATS} и попробуйте ещё раз.` },
  de: { transcribe: "Die Sprachnachricht konnte nicht erkannt werden. Prüfen Sie die Audiodatei und versuchen Sie es erneut.", format: `Dieses Audioformat wird nicht unterstützt. Laden Sie ${FORMATS} hoch.`, container: `Der Inhalt der Audiodatei passt nicht zur Dateiendung. Exportieren Sie sie als ${FORMATS} und versuchen Sie es erneut.` },
  fr: { transcribe: "Le message vocal n’a pas pu être transcrit. Vérifiez le fichier audio et réessayez.", format: `Ce format audio n’est pas pris en charge. Envoyez ${FORMATS}.`, container: `Le contenu du fichier audio ne correspond pas à son extension. Exportez-le en ${FORMATS} et réessayez.` },
  es: { transcribe: "No se pudo transcribir el mensaje de voz. Revisa el archivo de audio e inténtalo de nuevo.", format: `Este formato de audio no es compatible. Sube ${FORMATS}.`, container: `El contenido del audio no coincide con su extensión. Expórtalo como ${FORMATS} e inténtalo de nuevo.` },
  it: { transcribe: "Non è stato possibile trascrivere il messaggio vocale. Controlla il file audio e riprova.", format: `Questo formato audio non è supportato. Carica ${FORMATS}.`, container: `Il contenuto del file audio non corrisponde all’estensione. Esportalo come ${FORMATS} e riprova.` },
  pl: { transcribe: "Nie udało się rozpoznać wiadomości głosowej. Sprawdź plik audio i spróbuj ponownie.", format: `Ten format audio nie jest obsługiwany. Prześlij ${FORMATS}.`, container: `Zawartość pliku audio nie pasuje do rozszerzenia. Wyeksportuj go jako ${FORMATS} i spróbuj ponownie.` },
  pt: { transcribe: "Não foi possível transcrever a mensagem de voz. Verifique o ficheiro de áudio e tente novamente.", format: `Este formato de áudio não é suportado. Envie ${FORMATS}.`, container: `O conteúdo do áudio não corresponde à extensão. Exporte-o como ${FORMATS} e tente novamente.` },
  nl: { transcribe: "Het spraakbericht kon niet worden omgezet. Controleer het audiobestand en probeer het opnieuw.", format: `Dit audioformaat wordt niet ondersteund. Upload ${FORMATS}.`, container: `De inhoud van het audiobestand past niet bij de extensie. Exporteer het als ${FORMATS} en probeer het opnieuw.` },
  tr: { transcribe: "Sesli mesaj metne dönüştürülemedi. Ses dosyasını kontrol edip tekrar deneyin.", format: `Bu ses biçimi desteklenmiyor. ${FORMATS} yükleyin.`, container: `Ses dosyasının içeriği uzantısıyla uyuşmuyor. Dosyayı ${FORMATS} olarak dışa aktarıp tekrar deneyin.` },
  zh: { transcribe: "无法识别这条语音消息。请检查音频文件后重试。", format: `不支持此音频格式。请上传 ${FORMATS}。`, container: `音频文件内容与扩展名不符。请导出为 ${FORMATS} 后重试。` },
  ja: { transcribe: "音声メッセージを文字起こしできませんでした。音声ファイルを確認して、もう一度お試しください。", format: `この音声形式には対応していません。${FORMATS} をアップロードしてください。`, container: `音声ファイルの内容が拡張子と一致しません。${FORMATS} で書き出して、もう一度お試しください。` },
  ko: { transcribe: "음성 메시지를 텍스트로 변환하지 못했습니다. 오디오 파일을 확인하고 다시 시도해 주세요.", format: `지원하지 않는 오디오 형식입니다. ${FORMATS} 파일을 올려 주세요.`, container: `오디오 파일 내용이 확장자와 맞지 않습니다. ${FORMATS}(으)로 내보낸 뒤 다시 시도해 주세요.` },
  ar: { transcribe: "تعذّر تحويل الرسالة الصوتية إلى نص. تحقق من الملف الصوتي وحاول مرة أخرى.", format: `صيغة الصوت هذه غير مدعومة. ارفع ${FORMATS}.`, container: `محتوى الملف الصوتي لا يطابق امتداده. صدّره بصيغة ${FORMATS} وحاول مرة أخرى.` },
  hi: { transcribe: "वॉइस संदेश को पाठ में नहीं बदला जा सका। ऑडियो फ़ाइल जाँचें और फिर से कोशिश करें।", format: `यह ऑडियो फ़ॉर्मेट समर्थित नहीं है। ${FORMATS} अपलोड करें।`, container: `ऑडियो फ़ाइल की सामग्री उसके एक्सटेंशन से मेल नहीं खाती। उसे ${FORMATS} में निर्यात करके फिर से कोशिश करें।` },
};
/** A voice message's caption or the person's earlier messages decide; with neither, English. */
function voiceLanguage(text: string): CompanyChatLanguage {
  return text.trim() ? noticeLanguage(text) : "en";
}

/** `requestMessage` decides the language of the provider failure text, so it matches the language the person writes in. */
export function publicChatError(error: unknown, route?: string, requestMessage = "") {
  const raw = error instanceof InferenceRouteFailure && error.cause instanceof Error
    ? error.cause.message
    : error instanceof Error ? error.message : String(error);
  // The voice message notices were English in every chat language (V6 step 14).
  if (/Invalid file format/i.test(raw)) return AUDIO_COPY[voiceLanguage(requestMessage)].container;
  if (/Unsupported audio format/i.test(raw)) return AUDIO_COPY[voiceLanguage(requestMessage)].format;
  if (/audio transcription|transcribe|transcription/i.test(raw)) return AUDIO_COPY[voiceLanguage(requestMessage)].transcribe;
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
    // An exhausted balance says so, without the provider's or the router's own text (V6 step 13).
    : status === 402 || /credits? exhausted|insufficient (?:balance|credits?|funds)|out of credits/i.test(raw) ? "noCredits"
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
