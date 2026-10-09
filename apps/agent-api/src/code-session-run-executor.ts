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
    prompt: string;
    model?: string;
    signal: AbortSignal;
    cancelRequested: () => boolean | Promise<boolean>;
    readOnlyIntent?: boolean;
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
  /** Records the run's own result. `result` is the unchanged value `CodingAgentRunner.run` returned. */
  emitResult(result: unknown): void;
  /** Records how the run ended. Called once, after `emitResult`. */
  emitTerminal(status: CodeRunTerminalStatus, reason: string | null): void;
}

export type CodeRunTerminalStatus = "completed" | "failed" | "cancelled";

export interface CodeSessionRunInput {
  ctx: AuthContext;
  session: CodeSession;
  prompt: string;
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
  /** The runner's own result, unchanged. `unknown` because the runner's result type is the runner's business. */
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
  resolveModel?: (ctx: AuthContext) => Promise<string | undefined>;
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
      const model = await this.options.resolveModel?.(input.ctx);
      result = await runner.run({
        ctx: input.ctx,
        session: input.session,
        prompt: input.prompt,
        ...(model ? { model } : {}),
        signal: sink ? sink.signal : controller.signal,
        cancelRequested: input.cancelRequested,
        ...(input.readOnlyIntent ? { readOnlyIntent: true } : {}),
      });
    } catch (error) {
      /**
       * A throw becomes a failed run rather than an exception the caller has to interpret, so one entry point
       * cannot treat a crashed loop as a completed one. The error's own message is the reason; it is logged rather
       * than printed, and a caller that needs it has it in the terminal state.
       */
      this.options.logger?.warn({ err: error, sessionId }, "code_session_run_failed");
      result = { status: "failed", reason: error instanceof Error ? error.message : "run_failed" };
    } finally {
      control.unregisterController(sessionId, controller);
    }

    const view = result && typeof result === "object" ? (result as RunnerResultView) : null;
    const terminalStatus: CodeRunTerminalStatus = view?.status === "cancelled"
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
