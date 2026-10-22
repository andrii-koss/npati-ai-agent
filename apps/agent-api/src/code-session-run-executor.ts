import type { CodingAgentRunInput } from "./coding-agent-runner-contracts";
import type { CompanyChatLanguage } from "./company-chat-i18n";
import type { DevelopmentProcessProgressItem } from "@npati/shared";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { VERIFICATION_APPROVAL_REQUIRED } from "./code-verification-loop";

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
    runId?: string;
    runDetails?: CodingAgentRunInput["runDetails"];
    quotaSessionId?: string;
    initialInboxMessageId?: string;
    verificationTools?: readonly string[];
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
  prepareReference?: (input: CodeSessionRunInput) => Promise<readonly string[]>;
  resolveVerificationTools?: (input: CodeSessionRunInput) => Promise<readonly string[] | undefined>;
  afterRun?: (input: CodeSessionRunInput, result: unknown) => Promise<unknown>;
  settle?: (input: CodeSessionRunInput, result: unknown) => Promise<void>;
  logger?: { warn(payload: unknown, message?: string): void };
}

/** The subset of `CodingAgentRunResult` this module reads. Everything else is passed through untouched. */
interface RunnerResultView {
  status?: unknown;
  reason?: unknown;
  code?: unknown;
  summary?: { remaining?: unknown } | null;
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
      const model = await this.options.resolveModel?.(input.ctx, input);
      if (input.websiteEdit && input.images?.length && !model) throw new Error("vision_model_unavailable");
      input = { ...input, resolvedModel: model };
      if (input.referenceImageRequired) {
        if (!this.options.prepareReference) throw new Error("vision_analysis_unavailable");
        const analysis = await this.options.prepareReference(input);
        input = { ...input, extraSystemPromptLines: [...(input.extraSystemPromptLines ?? []), ...analysis] };
      }
      const verificationTools = await this.options.resolveVerificationTools?.(input);
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
        ...(input.onActivity ? { onActivity: input.onActivity } : {}),
        // Step 5: assistant prose reaches the transport through the sink, before the run settles.
        ...(sink?.emitDelta && !input.referenceImageRequired ? { onTextDelta: (text: string) => sink.emitDelta?.(text) } : {}),
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.initialInboxMessageId ? { initialInboxMessageId: input.initialInboxMessageId } : {}),
        ...(model ? { model } : {}),
        ...(verificationTools ? { verificationTools } : {}),
        ...(verificationTools?.includes("build") ? { forceVerification: true } : {}),
        signal: sink ? sink.signal : controller.signal,
        cancelRequested: input.cancelRequested,
        ...(input.readOnlyIntent ? { readOnlyIntent: true } : {}),
      });
      if (this.options.afterRun && !controller.signal.aborted && !await input.cancelRequested()) {
        result = await this.options.afterRun(input, result);
        const rootRunId = input.runId ?? (result as { runId?: string })?.runId;
        const deadline = Date.now() + 180_000;
        const repairRunIds: string[] = [];
        for (let attempt = 1; attempt <= 2 && Date.now() < deadline; attempt++) {
          const review = result as { visualAcceptance?: { status: string; differences: string[] }; status?: string };
          if (review.visualAcceptance?.status !== "failed" || controller.signal.aborted || await input.cancelRequested()) break;
          const repairRunId = String(rootRunId ?? sessionId) + ":visual-repair:" + attempt;
          repairRunIds.push(repairRunId);
          result = await runner.run({ ctx: input.ctx, session: input.session, model, images: input.images,
            prompt: input.prompt + "\nVisual acceptance failed. Correct these observed screenshot differences in the SAME project, preserving functionality: " + JSON.stringify(review.visualAcceptance.differences) + "\nRead current files before editing. Do not scaffold or reinstall unchanged dependencies. Finish saved edits for automatic build and screenshot review.",
            runId: repairRunId, runDetails: { parentRunId: rootRunId ?? null, visualParentRunId: rootRunId ?? null, visualRepairAttempt: attempt },
            quotaSessionId: sessionId, maxTurns: Math.min(input.maxTurns ?? 12, 12), websiteEdit: true,
            verificationTools, forceVerification: verificationTools?.includes("build"), extraSystemPromptLines: input.extraSystemPromptLines,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
            cancelRequested: input.cancelRequested, onActivity: input.onActivity });
          result = await this.options.afterRun({ ...input, runId: repairRunId }, result);
        }
        if (repairRunIds.length && result && typeof result === "object") result = { ...result, runId: rootRunId, visualRepairRunIds: repairRunIds };
      }
    } catch (error) {
      /**
       * A throw becomes a failed run rather than an exception the caller has to interpret, so one entry point
       * cannot treat a crashed loop as a completed one. The error's own message is the reason; it is logged rather
       * than printed, and a caller that needs it has it in the terminal state.
       */
      this.options.logger?.warn({ err: error, sessionId }, "code_session_run_failed");
      const reason = error instanceof Error ? error.message : "run_failed";
      result = result && typeof result === "object"
        ? { ...result, status: controller.signal.aborted ? "cancelled" : "failed", reason, message: reason }
        : { status: "failed", reason };
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
    sink?.emitResult(result);
    sink?.emitTerminal(terminalStatus, reason);

    return { result, terminalStatus, reason, needsApproval };
  }
}
