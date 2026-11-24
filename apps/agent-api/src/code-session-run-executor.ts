import type { CodingAgentRunInput } from "./coding-agent-runner-contracts";
import type { CompanyChatLanguage } from "./company-chat-i18n";
import type { DevelopmentProcessProgressItem } from "@npati/shared";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { VERIFICATION_APPROVAL_REQUIRED } from "./code-verification-loop";
import { visualAcceptanceScreenshot, visualRepairFindings } from "./website-visual-acceptance";

/**
 * C15 — the **one** place a code session is driven.
 *
 * Why this module exists at all, and why it is an extraction rather than a new mechanism:
 *
 *  1. Until C15 there were two things a caller had to get right to run the loop — register the run's
 *     `AbortController` with `CodeRunCancellationRegistry` (so the existing Stop route can reach a step that is
 *     already in flight) and normalise the runner's five-value `status` into the three states the background-run
 *     registry understands. Both existed only as a block of statements **inside** the chat route in `app.ts`, so
 *     the second entry point (the C15 CLI/IDE run-start route) would have had to copy them. A copy of a
 *     cancellation registration is not a style question: a second copy that forgets `clearSession` makes a stale
 *     Stop cancel work nobody asked to stop, and a copy that forgets `unregisterController` leaks a controller
 *     per run.
 *  2. The behaviour here is byte-for-byte the chat path's own sequence: clear the session's cancellation, register
 *     the controller, run, unregister in `finally`. Nothing is added, nothing is reordered, and no new permission,
 *     flag or policy phase is introduced — an extraction may not change what is authorized.
 *  3. It deliberately does **not** resolve the project, the session, the sandbox or the approval notification:
 *     those differ between the chat entry point (which owns a chat card and a conversation) and the CLI entry
 *     point (which owns a terminal and an approval list). Sharing them would mean inventing a common shape for
 *     things that are genuinely different.
 *
 * The result is a plain value, so the caller keeps deciding what a terminal state means for *its* transport — the
 * chat route builds its card from it, the run-start route stores it in the background-run registry. The executor
 * never emits to the transport itself; that is what the caller's `sink` is for.
 */

/** The minimum of the runner this module drives. Narrowed so the loop can be exercised without the whole runner. */
export interface CodeSessionRunPort {
  run(input: {
    ctx: AuthContext;
    session: CodeSession;
    responseLanguage?: CompanyChatLanguage;
    noMemory?: boolean;
    websiteEdit?: boolean;
  referenceImageRequired?: boolean;
  resolvedModel?: string;
    allowStylePreview?: boolean;
    images?: CodingAgentRunInput["images"];
    extraSystemPromptLines?: CodingAgentRunInput["extraSystemPromptLines"];
    prompt: string;
    model?: string;
    signal: AbortSignal;
    cancelRequested: () => boolean | Promise<boolean>;
    readOnlyIntent?: boolean;
    toolContext?: CodingAgentRunInput["toolContext"];
    runId?: string;
    /** `false` for the automatic visual-repair continuation, which must not take the chat's inbox lease. */
    useInbox?: boolean;
    /** `true` for the same continuation: no async collect barrier (it needs the inbox lease). */
    skipAsyncCollect?: boolean;
    runDetails?: CodingAgentRunInput["runDetails"];
    quotaSessionId?: string;
    initialInboxMessageId?: string;
    verificationTools?: readonly string[];
    refreshVerificationTools?: CodingAgentRunInput["refreshVerificationTools"];
    forceVerification?: boolean;
    requireImplementation?: boolean;
    /** Trusted creation context; never set for existing-project edits. */
    emptyHtmlWorkspace?: boolean;
    maxTurns?: number;
    onActivity?: (event: DevelopmentProcessProgressItem) => Promise<void>;
  }): Promise<unknown>;
}

/**
 * The cancellation surface this module needs. Structurally satisfied by `CodeRunCancellationRegistry`, and stated
 * as a port so a test can drive a run without the registry — but the production wiring passes the registry itself.
 */
export interface CodeRunControlPort {
  clearSession(sessionId: string): void;
  registerController(sessionId: string, controller: AbortController): void;
  unregisterController(sessionId: string, controller: AbortController): void;
}

/**
 * What a run emits towards its transport. `CodeBackgroundRunRegistry`'s sink satisfies this structurally, and the
 * chat path passes an adapter over the chat SSE writer; the executor does not care which.
 */
export interface CodeRunEventSink {
  signal: AbortSignal;
  /** Records the result after any website build/preview finalization. */
  emitResult(result: unknown): void;
  /** Records how the run ended. Called once, after `emitResult`. */
  emitTerminal(status: CodeRunTerminalStatus, reason: string | null): void;
  /**
   * Step 5: assistant **answer text** as the provider streams it, before the run settles. It is a preview of the
   * final message, never tool arguments or reasoning; a client must replace it with the final `result` message
   * instead of appending both.
   */
  emitDelta?(text: string): void;
}

export type CodeRunTerminalStatus = "completed" | "failed" | "cancelled" | "suspended_by_flag";

export interface CodeSessionRunInput {
  referenceImageRequired?: boolean;
  resolvedModel?: string;
  responseLanguage?: CompanyChatLanguage;
  noMemory?: boolean;
  websiteEdit?: boolean;
  allowStylePreview?: boolean;
  /** Creation must change source before verification can report success. */
  requireImplementation?: boolean;
  /** Trusted creation context; never set for existing-project edits. */
  emptyHtmlWorkspace?: boolean;
  onActivity?: (event: DevelopmentProcessProgressItem) => Promise<void>;
  maxTurns?: number;
  ctx: AuthContext;
  session: CodeSession;
  images?: CodingAgentRunInput["images"];
  extraSystemPromptLines?: CodingAgentRunInput["extraSystemPromptLines"];
  prompt: string;
  runId?: string;
  agentId?: string;
  initialInboxMessageId?: string;
  /** `codeIntentIsReadOnly(intent)` of the resolved intent — never a model argument and never a guess. */
  readOnlyIntent?: boolean;
  /** Signals for the offered tool tiers: the user's own words and the project's data backend state. */
  toolContext?: CodingAgentRunInput["toolContext"];
  /**
   * Where the run reports. When present, this is also the signal the loop runs under: the caller owns the
   * cancellation semantics (the background registry mints its own signal so a closed tab cannot reach the run), and
   * the executor must not substitute a controller of its own for it.
   */
  sink?: CodeRunEventSink | null;
  /**
   * Aborts a run that has no sink. The chat path's unbackgrounded form aborts its transport controller here; the
   * run-start route always has a sink, because a run it cannot reach afterwards would be a run it cannot stop.
   */
  abort?: (reason?: unknown) => void;
  /**
   * The `cancelRequested` probe. Supplied by the caller so the registry identity stays the caller's: the loop asks
   * "was *this session* asked to stop", and only the caller knows which session that is.
   */
  cancelRequested: () => boolean | Promise<boolean>;
}

export interface CodeSessionRunOutcome {
  /** The runner's result, including optional website Preview metadata. */
  result: unknown;
  /** The registry-normalised terminal status: a "stopped" run is `failed`, never a success. */
  terminalStatus: CodeRunTerminalStatus;
  /** Why the run ended, when the runner said so. */
  reason: string | null;
  /**
   * True when the resulting state is a human decision waiting to be made — the runner's own `waiting_for_user`
   * status, the verification summary's `VERIFICATION_APPROVAL_REQUIRED` code, or the runner's machine-readable
   * `approval_required`. Structural, not guessed: the same three signals the chat path used.
   */
  needsApproval: boolean;
}

export interface CodeSessionRunExecutorOptions {
  runner: CodeSessionRunPort;
  control: CodeRunControlPort;
  resolveModel?: (ctx: AuthContext, input: CodeSessionRunInput) => Promise<string | undefined>;
  /** Started, not awaited, when a run begins: e.g. create the project sandbox while the model writes the first files. */
  warmUp?: (input: CodeSessionRunInput) => Promise<unknown>;
  /** Awaited before the model starts: records state the run's result is later compared with (behaviour before a refactor). */
  beforeRun?: (input: CodeSessionRunInput) => Promise<void>;
  /** Started, not awaited, when the self-review begins, with the files the run changed so far. */
  beforeSelfReview?: (input: CodeSessionRunInput, changedFiles: readonly string[]) => void;
  prepareReference?: (input: CodeSessionRunInput) => Promise<readonly string[]>;
  resolveVerificationTools?: (input: CodeSessionRunInput) => Promise<readonly string[] | undefined>;
  afterRun?: (input: CodeSessionRunInput, result: unknown) => Promise<unknown>;
  settle?: (input: CodeSessionRunInput, result: unknown) => Promise<void>;
  logger?: { warn(payload: unknown, message?: string): void };
}

/** The subset of `CodingAgentRunResult` this module reads. Everything else is passed through untouched. */
/** A reply that already says no file changed ("Нічого не змінював", "Файли не змінювалися", "No files were changed"). */
const ACKNOWLEDGES_NO_CHANGE = /(?:нічого\s+не\s+змін|не\s+змінюв|не\s+змінювал|не\s+змінено|не\s+змінювались|без\s+змін|ничего\s+не\s+измен|не\s+изменял|не\s+изменен|no\s+(?:files?|changes?)\s+(?:were\s+|was\s+)?(?:changed|made|modified)|nothing\s+(?:was\s+)?changed|unchanged|did\s+not\s+change|didn['’]t\s+change|left\s+(?:the\s+)?files?\s+as|keine\s+datei\w*\s+(?:wurde\s+)?(?:geändert|verändert)|nichts\s+geändert|nicht\s+geändert|aucun\s+fichier|rien\s+(?:n['’]a\s+été\s+)?modifié|pas\s+modifié|ningún\s+archivo|no\s+(?:se\s+)?(?:modifiqué|cambié|modificó|cambió)|nessun\s+file|non\s+ho\s+modificat|żadn\w+\s+plik|nie\s+zmienia\w*|nie\s+zmieni\w*|nenhum\s+ficheiro|nenhum\s+arquivo|não\s+alterei|não\s+(?:foi|foram)\s+alterad|geen\s+bestand|niets\s+gewijzigd|niet\s+gewijzigd|hiçbir\s+dosya|değiştirilmedi|没有修改|未修改|未更改|変更していません|変更はありません|변경하지\s*않|변경되지\s*않|لم\s+(?:يتم\s+)?(?:أغير|تغيير|يُغيَّر)|कोई\s+फ़ाइल\s+नहीं|नहीं\s+बदल)/iu;
/** Written in the language of the request; it was English under a Portuguese reply (V6 step 14). */
const NO_CHANGE_NOTE: Record<string, string> = {
  uk: "Примітка системи: під час цього запуску жоден файл проєкту не змінено.",
  ru: "Примечание системы: во время этого запуска ни один файл проекта не изменён.",
  en: "System note: no project file was changed during this run.",
  de: "Systemhinweis: In diesem Lauf wurde keine Projektdatei geändert.",
  fr: "Note du système : aucun fichier du projet n’a été modifié pendant cette exécution.",
  es: "Nota del sistema: no se modificó ningún archivo del proyecto en esta ejecución.",
  it: "Nota di sistema: nessun file del progetto è stato modificato in questa esecuzione.",
  pl: "Uwaga systemu: podczas tego uruchomienia nie zmieniono żadnego pliku projektu.",
  pt: "Nota do sistema: nenhum ficheiro do projeto foi alterado nesta execução.",
  nl: "Systeemmelding: tijdens deze uitvoering is geen projectbestand gewijzigd.",
  tr: "Sistem notu: bu çalıştırmada hiçbir proje dosyası değiştirilmedi.",
  zh: "系统提示：本次运行没有修改任何项目文件。",
  ja: "システムメモ：今回の実行ではプロジェクトのファイルは変更されていません。",
  ko: "시스템 안내: 이번 실행에서는 프로젝트 파일이 변경되지 않았습니다.",
  ar: "ملاحظة النظام: لم يتم تغيير أي ملف في المشروع خلال هذا التشغيل.",
  hi: "सिस्टम नोट: इस रन में प्रोजेक्ट की कोई फ़ाइल नहीं बदली गई।",
};

/**
 * A run asked to change the project that ends with no changed file must not read as done: "готово" without a write is
 * a failed task (V6 step 05, CODING_ACCEPTANCE "Невиконання"). When the reply does not already say so, the stored
 * evidence (an empty list of changed files) is added to it.
 */
const REPAIR_HEADING: Record<string, string> = {
  uk: "Автоматична перевірка знайшла помилку і виправила її:",
  ru: "Автоматическая проверка нашла ошибку и исправила её:",
  en: "The automatic check found an error and fixed it:",
  de: "Die automatische Prüfung hat einen Fehler gefunden und behoben:",
  fr: "La vérification automatique a trouvé une erreur et l’a corrigée :",
  es: "La comprobación automática encontró un error y lo corrigió:",
  it: "Il controllo automatico ha trovato un errore e lo ha corretto:",
  pl: "Automatyczna kontrola znalazła błąd i go naprawiła:",
  pt: "A verificação automática encontrou um erro e corrigiu-o:",
  nl: "De automatische controle vond een fout en heeft die verholpen:",
  tr: "Otomatik denetim bir hata buldu ve düzeltti:",
  zh: "自动检查发现了一个错误并已修复：",
  ja: "自動チェックでエラーが見つかり、修正しました：",
  ko: "자동 검사에서 오류를 찾아 수정했습니다:",
  ar: "وجد الفحص التلقائي خطأً وأصلحه:",
  hi: "स्वचालित जाँच में एक त्रुटि मिली और उसे ठीक किया गया:",
};

/** A bold label line: the chat shows it as a section label above the repair's bullets, not as body text. */
function repairHeading(language?: string): string {
  return "**" + (REPAIR_HEADING[language ?? ""] ?? REPAIR_HEADING.en!) + "**";
}

/**
 * The reply of an automatic repair run describes only the repair. Shown alone, it replaced the summary of what was
 * built (V6-D06-01: a new todo app was answered with "replaced crypto.randomUUID"), so the root reply stays first.
 */
export function withRootReply(result: unknown, rootReply: unknown, responseLanguage?: string): unknown {
  if (typeof rootReply !== "string" || !rootReply.trim() || !result || typeof result !== "object") return result;
  const view = result as { message?: unknown; status?: unknown };
  if (typeof view.message !== "string" || !view.message.trim()) return { ...view, message: rootReply };
  if (view.message.includes(rootReply.trim())) return result;
  // A failed repair ends with the failure notice, which already says the error could not be fixed.
  const heading = view.status === "completed" ? repairHeading(responseLanguage) + "\n" : "";
  return { ...view, message: rootReply.trimEnd() + "\n\n" + heading + view.message.trim() };
}

/**
 * The same for a repair inside one run: the automatic check failed after the model's first final answer, the model fixed
 * it and answered again with only the fix (V6 step 08: a new Pygame game was answered with "Fixed the failing test check by
 * adding pytest"). The first answer stays first, the fix follows under the repair heading.
 */
export function withInRunRepair(rootReply: string | undefined, finalText: string, responseLanguage?: string): string {
  if (!rootReply?.trim() || finalText.includes(rootReply.trim())) return finalText;
  return rootReply.trimEnd() + "\n\n" + repairHeading(responseLanguage) + "\n" + finalText.trim();
}

export function withUnchangedFilesNote(result: unknown, input: { readOnlyIntent?: boolean; responseLanguage?: string; session?: { mode?: string } }): unknown {
  if (input.readOnlyIntent || input.session?.mode === "plan" || !result || typeof result !== "object") return result;
  const view = result as { status?: unknown; message?: unknown; summary?: { filesChanged?: unknown } | null };
  if (view.status !== "completed" || typeof view.message !== "string" || !view.message.trim()) return result;
  if (!Array.isArray(view.summary?.filesChanged) || view.summary!.filesChanged.length > 0) return result;
  if (ACKNOWLEDGES_NO_CHANGE.test(view.message)) return result;
  const note = NO_CHANGE_NOTE[input.responseLanguage ?? ""] ?? NO_CHANGE_NOTE.en!;
  return { ...view, message: view.message.trimEnd() + "\n\n" + note };
}

interface RunnerResultView {
  status?: unknown;
  reason?: unknown;
  code?: unknown;
  summary?: { remaining?: unknown } | null;
}

const BUILD_REQUEST = /\b(?:build|rebuild|compile|preview|deploy|launch)\b|збер|зібр|збір|компіл|запусти|перезапусти|прев['’ʼ]?ю|превью/iu;

/**
 * A full build without any source change is only worth its 1-3 minutes when the user asked for a build/preview or a
 * new project is being implemented. Edits still verify because they change files; a Data Studio-only or read-only
 * run no longer pays for a build of an unchanged workspace (E2E S3: 60-200 s per database request).
 */
export function forcesBuild(input: { requireImplementation?: boolean; prompt: string; toolContext?: { userMessage?: string } }): boolean {
  return input.requireImplementation === true || BUILD_REQUEST.test(input.toolContext?.userMessage ?? input.prompt);
}

/**
 * Drives one code session. The returned value is the whole of what a caller may conclude about the run: the
 * runner's result, the normalised terminal status, the reason and whether a human decision is pending.
 */
export class CodeSessionRunExecutor {
  constructor(private readonly options: CodeSessionRunExecutorOptions) {}

  async execute(input: CodeSessionRunInput): Promise<CodeSessionRunOutcome> {
    const { runner, control } = this.options;
    const sessionId = input.session.id;
    const sink = input.sink ?? null;

    /**
     * A live facade over the signal the run really executes under. For a background run that is the registry's own
     * signal, so the Stop route and the reconnect surface cannot disagree about whether a stop happened; for a
     * streamed run it is the caller's transport controller. `abort()` therefore delegates to the caller.
     */
    const controller: AbortController = sink
      ? {
          signal: sink.signal,
          abort: (reason?: unknown) => input.abort?.(reason),
        } as unknown as AbortController
      : new AbortController();

    // A cancellation left over from a previous Stop is cleared first: a stale flag would cancel work the user never
    // asked to stop. Then this run's controller is registered so Stop can interrupt a step already in flight.
    control.clearSession(sessionId);
    control.registerController(sessionId, controller);

    let result: unknown;
    try {
      if (input.referenceImageRequired && !input.images?.length) throw new Error("reference_image_missing");
      void this.options.warmUp?.(input).catch(() => undefined);
      const model = await this.options.resolveModel?.(input.ctx, input);
      if (input.websiteEdit && input.images?.length && !model) throw new Error("vision_model_unavailable");
      input = { ...input, resolvedModel: model };
      if (input.referenceImageRequired) {
        if (!this.options.prepareReference) throw new Error("vision_analysis_unavailable");
        const analysis = await this.options.prepareReference(input);
        input = { ...input, extraSystemPromptLines: [...(input.extraSystemPromptLines ?? []), ...analysis] };
      }
      const verificationTools = await this.options.resolveVerificationTools?.(input);
      // Awaited: what it records (e.g. the app's behaviour before a refactor) must describe the code before any edit.
      await this.options.beforeRun?.(input).catch((error: unknown) => this.options.logger?.warn({ err: error, sessionId }, "code_session_before_run_failed"));
      result = await runner.run({
        ctx: input.ctx,
        session: input.session,
        prompt: input.prompt,
        ...(input.images?.length ? { images: input.images } : {}),
        ...(input.extraSystemPromptLines?.length ? { extraSystemPromptLines: input.extraSystemPromptLines } : {}),
        ...(input.responseLanguage ? { responseLanguage: input.responseLanguage } : {}),
        ...(input.noMemory ? { noMemory: true } : {}),
        ...(input.websiteEdit ? { websiteEdit: true } : {}),
        ...(input.allowStylePreview ? { allowStylePreview: true } : {}),
        ...(input.requireImplementation ? { requireImplementation: true } : {}),
        ...(input.emptyHtmlWorkspace ? { emptyHtmlWorkspace: true } : {}),
        ...(this.options.beforeSelfReview ? { onBeforeSelfReview: (files: readonly string[]) => this.options.beforeSelfReview!(input, files) } : {}),
        ...(input.onActivity ? { onActivity: input.onActivity } : {}),
        // Step 5: assistant prose reaches the transport through the sink, before the run settles.
        ...(sink?.emitDelta && !input.referenceImageRequired ? { onTextDelta: (text: string) => sink.emitDelta?.(text) } : {}),
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.initialInboxMessageId ? { initialInboxMessageId: input.initialInboxMessageId } : {}),
        ...(model ? { model } : {}),
        ...(verificationTools ? { verificationTools } : {}),
        ...(this.options.resolveVerificationTools ? { refreshVerificationTools: () => this.options.resolveVerificationTools!(input) } : {}),
        ...(verificationTools?.includes("build") && forcesBuild(input) ? { forceVerification: true } : {}),
        signal: sink ? sink.signal : controller.signal,
        cancelRequested: input.cancelRequested,
        ...(input.readOnlyIntent ? { readOnlyIntent: true } : {}),
        ...(input.toolContext ? { toolContext: input.toolContext } : {}),
      });
      if (this.options.afterRun && !controller.signal.aborted && !await input.cancelRequested()) {
        // The model's own reply, before a failed check replaces it with the failure notice.
        const rootReply = (result as { message?: unknown } | null)?.message;
        result = await this.options.afterRun(input, result);
        const rootRunId = input.runId ?? (result as { runId?: string })?.runId;
        const deadline = Date.now() + 600_000;
        const repairRunIds: string[] = [];
        for (let attempt = 1; attempt <= 2 && Date.now() < deadline; attempt++) {
          const review = result as { visualAcceptance?: { status: string; differences: string[] }; status?: string };
          if (review.visualAcceptance?.status !== "failed" || controller.signal.aborted || await input.cancelRequested()) break;
          // A repair is a model run: only spend it on concrete, named differences (never on a bare low score).
          const findings = visualRepairFindings(review.visualAcceptance);
          if (!findings.length) break;
          const failedCapture = visualAcceptanceScreenshot(result);
          const repairRunId = String(rootRunId ?? sessionId) + ":visual-repair:" + attempt;
          repairRunIds.push(repairRunId);
          /**
           * The root run still owns the session inbox lease (the chat transport opened it), so a repair cannot open
           * the inbox again. The repair is an automatic continuation of the same run: it consumes no new user
           * messages and must not fail on a lease it cannot take.
           */
          const previous = result;
          let repaired: unknown;
          try {
            // The repair sees the reference AND the screenshot that failed, so it does not need to capture one itself.
            const repairImages = failedCapture && input.images?.length ? [...input.images, failedCapture] : input.images;
            repaired = await runner.run({ ctx: input.ctx, session: input.session, model, images: repairImages, useInbox: false, skipAsyncCollect: true,
            prompt: input.prompt + "\nVisual acceptance failed. Correct these observed screenshot differences in the SAME project, preserving functionality: " + JSON.stringify(findings)
              + (failedCapture ? "\nThe LAST attached image is the current Preview screenshot that failed this check; the other images are the reference. Compare them instead of taking a new screenshot." : "")
              + "\nRead current files before editing. Do not scaffold or reinstall unchanged dependencies. Finish saved edits for automatic build and screenshot review.",
            runId: repairRunId, runDetails: { parentRunId: rootRunId ?? null, visualParentRunId: rootRunId ?? null, visualRepairAttempt: attempt },
            quotaSessionId: sessionId, ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}), websiteEdit: true,
            ...(input.toolContext ? { toolContext: input.toolContext } : {}),
            verificationTools, forceVerification: verificationTools?.includes("build"), extraSystemPromptLines: input.extraSystemPromptLines,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
            cancelRequested: input.cancelRequested, onActivity: input.onActivity });
          } catch (error) {
            /** A repair that cannot start is reported as a difference; the root mismatch stays visible. */
            const root = previous && typeof previous === "object" ? previous as Record<string, unknown> : {};
            const acceptance = (root.visualAcceptance && typeof root.visualAcceptance === "object") ? root.visualAcceptance as Record<string, unknown> : {};
            const differences = Array.isArray(acceptance.differences) ? [...acceptance.differences as string[]] : [];
            differences.push("visual repair " + attempt + " could not start: " + (error instanceof Error ? error.message : String(error)).slice(0, 200));
            result = { ...root, visualAcceptance: { ...acceptance, status: "failed", differences } };
            break;
          }
          /**
           * A repair that never ran (lease, cancellation, provider refusal) must not replace the root result with its
           * own failure and thereby erase the visual mismatch the user needs to see.
           */
          const repairChanged = ((repaired as { summary?: { filesChanged?: unknown[] } } | null)?.summary?.filesChanged?.length ?? 0) > 0;
          if (repaired && typeof repaired === "object" && (repaired as { status?: string }).status === "completed" && !repairChanged) {
            // Same revision as the failed check: a new build + screenshot + review would repeat the same verdict.
            const root = previous && typeof previous === "object" ? previous as Record<string, unknown> : {};
            const acceptance = (root.visualAcceptance && typeof root.visualAcceptance === "object") ? root.visualAcceptance as Record<string, unknown> : {};
            const differences = Array.isArray(acceptance.differences) ? [...acceptance.differences as string[]] : [];
            differences.push("visual repair " + attempt + " made no changes");
            result = { ...root, visualAcceptance: { ...acceptance, status: "failed", differences } };
            break;
          }
          if (repaired && typeof repaired === "object" && (repaired as { status?: string }).status === "completed") {
            result = await this.options.afterRun({ ...input, runId: repairRunId }, repaired);
          } else {
            const root = previous && typeof previous === "object" ? previous as Record<string, unknown> : {};
            const acceptance = (root.visualAcceptance && typeof root.visualAcceptance === "object") ? root.visualAcceptance as Record<string, unknown> : {};
            const differences = Array.isArray(acceptance.differences) ? [...acceptance.differences as string[]] : [];
            differences.push("visual repair " + attempt + " did not complete: " + String((repaired as { reason?: string } | null)?.reason ?? "unknown"));
            result = { ...root, visualAcceptance: { ...acceptance, status: "failed", differences } };
          }
        }
        // The build passed but the app breaks in the browser: the agent gets the errors and fixes them itself.
        // A second repair runs only when the first one changed what the browser reports. With the same error left (same
        // file, line and kind) it repeated the same attempt: in E2E G6 two repairs cost 13 + 7 turns for one unchanged error.
        let previousErrors: string | undefined;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const failed = result as { status?: string; reason?: string; functionalAcceptance?: { diagnostics?: unknown[]; brokenLinks?: unknown[]; findings?: unknown[] } };
          if (failed?.status !== "failed" || failed.reason !== "website_preview_qa_failed" || controller.signal.aborted || await input.cancelRequested()) break;
          const errors = JSON.stringify([failed.functionalAcceptance?.diagnostics ?? [], failed.functionalAcceptance?.brokenLinks ?? [], failed.functionalAcceptance?.findings ?? []]);
          if (errors === previousErrors) break;
          previousErrors = errors;
          const repairRunId = String(rootRunId ?? sessionId) + ":qa-repair:" + attempt;
          const repaired = await runner.run({ ctx: input.ctx, session: input.session, model, images: input.images, useInbox: false, skipAsyncCollect: true,
            prompt: input.prompt + "\nThe build passed, but opening the app in a browser found these errors: " + JSON.stringify({ errors: failed.functionalAcceptance?.diagnostics ?? [], brokenLinks: failed.functionalAcceptance?.brokenLinks ?? [], problems: failed.functionalAcceptance?.findings ?? [] })
              + "\nFind the cause in the SAME project and fix it, preserving what works. Read current files before editing. Do not scaffold or reinstall unchanged dependencies. Finish saved edits for the automatic build and browser check.",
            runId: repairRunId, runDetails: { parentRunId: rootRunId ?? null, qaRepairAttempt: attempt },
            quotaSessionId: sessionId, ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}), websiteEdit: true,
            ...(input.toolContext ? { toolContext: input.toolContext } : {}),
            verificationTools, forceVerification: verificationTools?.includes("build"), extraSystemPromptLines: input.extraSystemPromptLines,
            signal: controller.signal, cancelRequested: input.cancelRequested, onActivity: input.onActivity }).catch((error: unknown) => {
              this.options.logger?.warn({ err: error, sessionId }, "code_session_qa_repair_failed");
              return null;
            });
          repairRunIds.push(repairRunId);
          const changed = ((repaired as { summary?: { filesChanged?: unknown[] } } | null)?.summary?.filesChanged?.length ?? 0) > 0;
          // Nothing changed means the same revision and the same verdict, so the failure stays as reported.
          if ((repaired as { status?: string } | null)?.status !== "completed" || !changed) break;
          result = await this.options.afterRun({ ...input, runId: repairRunId }, repaired);
        }
        if (repairRunIds.length && result && typeof result === "object")
          result = { ...(withRootReply(result, rootReply, input.responseLanguage) as object), runId: rootRunId, visualRepairRunIds: repairRunIds };
      }
    } catch (error) {
      /**
       * A throw becomes a failed run rather than an exception the caller has to interpret, so one entry point
       * cannot treat a crashed loop as a completed one. The error's own message is the reason; it is logged rather
       * than printed, and a caller that needs it has it in the terminal state.
       */
      this.options.logger?.warn({ err: error, sessionId }, "code_session_run_failed");
      const reason = error instanceof Error ? error.message : "run_failed";
      // A missing vision model is the user's to fix in AI settings: its text is written for the user.
      const userFacing = /^vision_model_unavailable:\s*/u.test(reason) ? reason.replace(/^vision_model_unavailable:\s*/u, "") : undefined;
      result = result && typeof result === "object"
        ? { ...result, status: controller.signal.aborted ? "cancelled" : "failed", reason, message: reason }
        : { status: "failed", reason, ...(userFacing ? { message: userFacing } : {}) };
    } finally {
      control.unregisterController(sessionId, controller);
    }

    try { await this.options.settle?.(input, result); }
    catch { result = { ...(result && typeof result === "object" ? result : {}), status: "failed", reason: "acceptance_persistence_failed", message: "Acceptance could not be persisted; completion is not confirmed." }; }
    const view = result && typeof result === "object" ? (result as RunnerResultView) : null;
    const terminalStatus: CodeRunTerminalStatus = view?.status === "suspended_by_flag" ? "suspended_by_flag" : view?.status === "cancelled"
      ? "cancelled"
      : view?.status === "completed"
        ? "completed"
        : "failed";
    const reason = typeof view?.reason === "string" ? view.reason : null;
    const needsApproval = view
      ? view.status === "waiting_for_user"
        || view.summary?.remaining === VERIFICATION_APPROVAL_REQUIRED
        || view.code === "approval_required"
      : false;

    /**
     * The sink sees the result first and the terminal state second, in the run's own order. Both are emitted from
     * the executor **after** the run settled, exactly where the chat path emitted them, so a subscriber that reads
     * the registry cannot observe a "terminal" before the run's own result is in the buffer.
     */
    result = withUnchangedFilesNote(result, input);
    sink?.emitResult(result);
    sink?.emitTerminal(terminalStatus, reason);

    return { result, terminalStatus, reason, needsApproval };
  }
}
