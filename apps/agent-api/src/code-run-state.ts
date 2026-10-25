import type {
  ApplyCodeRunStateEventInput,
  CodeRunStateRecord,
  CodeRunStateStatus,
  CodeRunToolCallOutcome,
  CodeRunToolCallRecord,
  CodeRunTurnRecord,
  CodeRunTurnStatus,
} from "@npati/workspace";
import { clampScanLimit, encodeCodeRunScanCursor } from "@npati/workspace";
import type { CodeAgentLimits } from "./code-agent-config";
import { DEFAULT_CODE_AGENT_LIMITS } from "./code-agent-config";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_OVERDUE_GRACE_MS,
  MAX_SCAN_PAGES,
  RUN_ESTIMATE_SOURCE,
  assertNoSensitiveRunState,
  decideRunRequest,
  refuseResume,
  type CodeRunBoundary,
  type CodeRunEstimateInput,
  type CodeRunOverdueRun,
  type CodeRunOverdueRunScanInput,
  type CodeRunOverdueRunScanPage,
  type CodeRunResumeResult,
  type CodeRunStartInput,
  type CodeRunStartResult,
  type CodeRunStateLogOptions,
  type CodeRunStateStorePort,
  type CodeRunStuckToolCall,
  type CodeRunStuckToolCallPage,
  type CodeRunStuckToolCallScanInput,
} from "./code-run-state-types";

export * from "./code-run-state-types";

/**
 * C6a: the durable run-state log.
 *
 * C6 ran the loop entirely in process memory: a restart lost the boundary between "this tool call finished"
 * and "this tool call may or may not have landed", which is the one piece of information a recovery must not
 * guess. This module is the single writer of that information.
 *
 * Three properties are load-bearing:
 *
 * 1. **The state is written as the run advances, not at the end.** After every turn and after every tool
 *    call, so a process that dies mid-run leaves a usable boundary behind. A run that only wrote its state on
 *    completion would tell a reconciler nothing.
 * 2. **Every write is idempotent.** Each carries a monotonic per-run sequence, and the store ignores a write
 *    whose sequence is not greater than the stored one. A retried write (a retry, a duplicate delivery, a
 *    process that resumes after a short lease hiccup) therefore cannot double-apply anything.
 * 3. **A lease, not a flag, decides who may write.** `leaseOwner` plus `leaseExpiresAt` express liveness; a
 *    run whose lease is gone can be reconciled by another process, and the previous owner must stop rather
 *    than keep writing state (see `CodingAgentRunner`, which treats a refused renewal as `interrupted`).
 *
 * Everything the log stores in a run's `details` bag is metadata: tool names, ids, outcomes, counts and
 * timestamps. File contents, commands and model output never reach it — `assertNoSensitiveRunState` throws if
 * they try.
 *
 * C10 adds exactly one piece of **content** to the run row: the user's own request (`startRun`'s `request`),
 * which is the run's input rather than anything a tool or a model produced. It is bounded, credential-scanned
 * and written once, by the same statement that creates the run; `details` keeps its metadata-only rule, and
 * `code_run_turns.messages` keeps its documented "bounded, metadata-only snapshot of the turn" meaning.
 */

/** Monotonic sequence derived from whatever the store last confirmed. */
export class CodeRunStateLog {
  private readonly store: CodeRunStateStorePort;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly limits: Partial<CodeAgentLimits>;
  private readonly logger?: { warn(input: unknown, message?: string): void };
  /** Last sequence this process wrote or observed, per run. The store remains the source of truth. */
  private readonly seqs = new Map<string, number>();

  constructor(options: CodeRunStateLogOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.limits = options.limits ?? {};
    if (options.logger) this.logger = options.logger;
  }

  leaseMsValue(): number { return this.leaseMs; }
  heartbeatMsValue(): number { return this.heartbeatMs; }

  /**
   * Creates the run row already leased by `owner`. Idempotent by run id: a retried start returns the stored
   * row untouched, so it can neither rewind the cursor nor steal the lease from the process still working.
   *
   * C10: the run's **original request** is stored by this same write, before the first model step. Two
   * properties follow from doing it here rather than in a later call:
   *
   *   - there is no window in which the run exists and its request does not, so a process that dies immediately
   *     after start still leaves the request behind — which is exactly the failure the owner named;
   *   - the store's `ON CONFLICT (run_id) DO NOTHING` (and its in-memory equivalent) makes the request
   *     write-once. A resume re-runs this call with the reconstructed continuation prompt, and the database,
   *     not a convention, is what keeps the user's own words intact.
   */
  async startRun(input: CodeRunStartInput): Promise<CodeRunStartResult> {
    const runId = input.runId ?? `code-run-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (input.details) assertNoSensitiveRunState(input.details);
    const request = decideRunRequest({
      request: input.request ?? null,
      now: new Date(this.now()),
      ...(input.requestMaxChars === undefined ? {} : { maxChars: input.requestMaxChars }),
    });
    const state = await this.store.createCodeRunState({
      runId,
      workspaceId: input.ctx.workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      owner: input.owner,
      leaseMs: this.leaseMs,
      now: new Date(this.now()),
      ...(input.details ? { details: input.details } : {}),
      request,
      ...(input.dataClassification ? { dataClassification: input.dataClassification } : {}),
      ...(input.retentionClass ? { retentionClass: input.retentionClass } : {}),
    });
    if (request.status === "refused_credential") {
      // The run continues: persistence is evidence, never a gate. The refusal is a fact an operator can see
      // and a resume reports it honestly, and the value itself reached neither this store nor any log line.
      this.logger?.warn({ runId, reason: "request_contains_credential" }, "code_run_request_record_refused");
    }
    this.observe(runId, state.lastEventSeq);
    return { runId, state };
  }

  /**
   * C10: the run's recorded original request. Tenant-scoped (the store refuses a foreign run), and `null` only
   * when the run row does not exist — a run with no recorded request answers with a record whose `status` says
   * which of the two reasons applies.
   */
  async loadRunRequest(companyId: string, runId: string): Promise<import("@npati/workspace").CodeRunRequestRecord | null> {
    return this.store.getCodeRunRequest(companyId, runId);
  }

  /** Takes the lease when it is free, expired or already ours. Returns the stored state either way. */
  async acquireLease(input: { companyId: string; runId: string; owner: string; now?: Date }): Promise<{ held: boolean; state: CodeRunStateRecord }> {
    const state = await this.apply(input.runId, {
      companyId: input.companyId,
      runId: input.runId,
      lease: { mode: "acquire", owner: input.owner, now: input.now ?? new Date(this.now()), leaseMs: this.leaseMs },
    });
    return { held: state.leaseOwner === input.owner, state };
  }

  /**
   * C10: the run is live again under a new owner — the one write a resume performs on the run state.
   *
   * Two properties, and both are why this is a method here rather than a sequence the caller assembles:
   *
   *  1. **The lease is acquired first, and the status moves only if it was.** `applyCodeRunStateEvent` applies
   *     the non-lease part of a patch even when the lease predicate fails (deliberately: the status of a run we
   *     no longer own is still true information). For resume that would be wrong — stamping `running` while
   *     another process holds a healthy lease would describe someone else's run as ours. Acquiring first and
   *     only then writing the status closes that: once the acquire succeeded, the lease expiry this write set
   *     (60 s) cannot be taken by anyone else inside the same call.
   *  2. **The status is decided by one rule, exported below.** A `waiting_for_user` run is paused on a question,
   *     not interrupted, and a terminal run is over: resuming either would either orphan the answer that is on
   *     its way or continue a run whose bundle is already closed. Both are refusals, reported as such instead of
   *     silently starting something.
   */
  async resumeRun(input: { companyId: string; runId: string; owner: string }): Promise<CodeRunResumeResult> {
    const current = await this.store.getCodeRunState(input.companyId, input.runId);
    if (!current) return { held: false, state: null, refused: "not_found" };
    const refused = refuseResume(current.status);
    if (refused) return { held: false, state: current, refused };
    const acquired = await this.acquireLease(input);
    if (!acquired.held) return { held: false, state: acquired.state, refused: null };
    const state = await this.apply(input.runId, {
      companyId: input.companyId,
      runId: input.runId,
      status: "running",
      finishedAt: null,
      heartbeatAt: new Date(this.now()),
    });
    return { held: state.leaseOwner === input.owner, state, refused: null };
  }

  /**
   * Renews the lease and records the heartbeat in the same write. `held: false` is the signal that another
   * process owns the run: the caller must stop instead of continuing to mutate state it no longer owns.
   */
  async renewLease(input: { companyId: string; runId: string; owner: string }): Promise<{ held: boolean; state: CodeRunStateRecord }> {
    const at = new Date(this.now());
    const state = await this.apply(input.runId, {
      companyId: input.companyId,
      runId: input.runId,
      heartbeatAt: at,
      lease: { mode: "renew", owner: input.owner, now: at, leaseMs: this.leaseMs },
    });
    return { held: state.leaseOwner === input.owner, state };
  }

  /** Records liveness without touching the lease (used between long tool calls). */
  async markHeartbeat(input: { companyId: string; runId: string }): Promise<CodeRunStateRecord> {
    return this.apply(input.runId, {
      companyId: input.companyId,
      runId: input.runId,
      heartbeatAt: new Date(this.now()),
    });
  }

  async releaseLease(input: { companyId: string; runId: string; owner: string }): Promise<CodeRunStateRecord> {
    return this.apply(input.runId, {
      companyId: input.companyId,
      runId: input.runId,
      lease: { mode: "release", owner: input.owner, now: new Date(this.now()) },
    });
  }

  /** Called after every turn: the cursor and the turn outcome are persisted as the run advances. */
  async appendTurn(input: {
    companyId: string;
    runId: string;
    turnIndex: number;
    status: CodeRunTurnStatus;
    outcome?: CodeRunToolCallOutcome | null;
    checkpointId?: string | null;
    toolCalls?: readonly CodeRunToolCallRecord[];
    messages?: readonly unknown[];
    results?: readonly unknown[];
    startedAt?: Date;
    finishedAt?: Date | null;
  }): Promise<CodeRunTurnRecord> {
    const turn = await this.store.upsertCodeRunTurn({
      runId: input.runId,
      companyId: input.companyId,
      turnIndex: input.turnIndex,
      status: input.status,
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
      ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
      ...(input.messages ? { messages: input.messages } : {}),
      ...(input.results ? { results: input.results } : {}),
      // Timestamps come from **this log's clock**. The store would otherwise fill them from its own wall clock,
      // and "no progress for 300 seconds" would then compare two different clocks — which is exactly the kind of
      // off-by-a-timezone bug that makes a reaper kill a healthy run.
      startedAt: input.startedAt ?? new Date(this.now()),
      finishedAt: input.finishedAt !== undefined
        ? input.finishedAt
        : (input.status === "running" ? null : new Date(this.now())),
    });
    // The turn boundary and the run cursor move together, under the same monotonic sequence: a recovery must
    // never see a turn recorded while the run still claims to be on an earlier one.
    await this.apply(input.runId, {
      companyId: input.companyId,
      runId: input.runId,
      turnIndex: input.turnIndex,
      ...(input.checkpointId ? { details: { lastCheckpointId: input.checkpointId } } : {}),
    });
    return turn;
  }

  /**
   * Called after every tool call. The call is recorded with its outcome; a call that was interrupted leaves
   * `unknown_outcome`, which is what forbids a replay for anything that is not read-only.
   */
  async appendToolCall(input: {
    companyId: string;
    runId: string;
    turnIndex: number;
    toolCallId: string;
    tool: string;
    readOnly: boolean;
    outcome: CodeRunToolCallOutcome;
    errorCode?: string;
    startedAt?: Date;
    finishedAt?: Date | null;
  }): Promise<CodeRunTurnRecord> {
    const call: CodeRunToolCallRecord = {
      toolCallId: input.toolCallId,
      tool: input.tool,
      readOnly: input.readOnly,
      outcome: input.outcome,
      startedAt: input.startedAt ?? new Date(this.now()),
      // An explicit `null` means "still running" (the write-ahead record) and must stay null; only an omitted
      // value means "stamp it now".
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : new Date(this.now()),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    };
    return this.appendTurn({
      companyId: input.companyId,
      runId: input.runId,
      turnIndex: input.turnIndex,
      status: "running",
      toolCalls: [call],
    });
  }

  /**
   * Marks the run as interrupted (lease lost, process death) and bumps the turn cursor so the recovery knows
   * which turn to resume from. The reason is metadata: a short code, never a command or a diff.
   */
  async markInterrupted(input: { companyId: string; runId: string; reason: string; owner?: string }): Promise<CodeRunStateRecord> {
    assertNoSensitiveRunState({ reason: input.reason });
    return this.apply(input.runId, {
      companyId: input.companyId,
      runId: input.runId,
      status: "interrupted",
      details: { interruptedReason: input.reason, interruptedAt: new Date(this.now()).toISOString() },
      ...(input.owner ? { lease: { mode: "release" as const, owner: input.owner, now: new Date(this.now()) } } : {}),
    });
  }

  /**
   * C9: the run pauses on a question. This is a **non-terminal** state, and it is deliberately its own value
   * rather than "still running with no lease": the reconciler exists to turn "running without a live lease" into
   * `interrupted`, so a run waiting for an answer must not look like a crash — otherwise every restart would
   * mark a healthy paused run as interrupted, replay work, and orphan the answer the user is about to give.
   *
   * The lease is deliberately left alone: this method does not know which process holds it, and releasing a lease
   * that belongs to someone else would be worse than leaving a stale one. Nothing depends on the lease here —
   * the status is what pauses the run, and the reconciler ignores a `waiting_for_user` run whatever its lease
   * says (see `isReconcilable`).
   */
  async markWaitingForUser(input: {
    companyId: string;
    runId: string;
    questionId: string;
    toolCallId: string;
  }): Promise<CodeRunStateRecord> {
    assertNoSensitiveRunState({ questionId: input.questionId, toolCallId: input.toolCallId });
    return this.apply(input.runId, {
      companyId: input.companyId,
      runId: input.runId,
      status: "waiting_for_user",
      details: {
        waitingForUser: {
          questionId: input.questionId,
          toolCallId: input.toolCallId,
          since: new Date(this.now()).toISOString(),
        },
      },
    });
  }

  /**
   * C9: the answer arrived, so the pause is over. The run becomes `interrupted` — C6a's word for "not running,
   * continuable from the turn boundary" — and *not* `running`, because nothing is driving it yet: driving the
   * continuation is Resume (C10), which this step must not implement. The reason records that this was an
   * answered question rather than a crash, so the two are never confused in Activity or in a report.
   */
  async resumeAfterAnswer(input: {
    companyId: string;
    runId: string;
    questionId: string;
    answeredBy: string;
  }): Promise<CodeRunStateRecord> {
    assertNoSensitiveRunState({ questionId: input.questionId, answeredBy: input.answeredBy });
    return this.markInterrupted({
      companyId: input.companyId,
      runId: input.runId,
      reason: "user_answered",
    });
  }

  /** Terminal state of a run. `completed`/`failed`/`cancelled` all stamp `finished_at`. */
  async markFinished(input: {
    companyId: string;
    runId: string;
    status: CodeRunStateStatus;
    reason?: string;
    /**
     * The runner's own summary of the run, persisted so a later read can answer "what did this cost?" without the
     * caller having kept the HTTP response. It is an **estimate** (`CodingAgentRunner` fills it from estimated
     * per-call constants when the provider reports no usage), which is why it is stored under an explicit
     * `estimated: true` marker instead of being presented as metering.
     */
    estimate?: CodeRunEstimateInput;
  }): Promise<CodeRunStateRecord> {
    if (input.reason) assertNoSensitiveRunState({ reason: input.reason });
    const details = {
      ...(input.reason ? { stopReason: input.reason } : {}),
      ...(input.estimate ? { estimate: { ...input.estimate, estimated: true as const, source: RUN_ESTIMATE_SOURCE } } : {}),
    };
    return this.apply(input.runId, {
      companyId: input.companyId,
      runId: input.runId,
      status: input.status,
      finishedAt: new Date(this.now()),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    });
  }

  async loadRunState(companyId: string, runId: string): Promise<CodeRunStateRecord | null> {
    const state = await this.store.getCodeRunState(companyId, runId);
    if (state) this.observe(runId, state.lastEventSeq);
    return state;
  }

  /**
   * The last finished turn plus whatever the interrupted turn left in doubt. This is the only place that
   * decides "replayable" versus "never replay":
   *
   * - read-only with an unknown outcome → replayable (a read cannot change the workspace);
   * - anything else with an unknown outcome → never replayed, and reported as such.
   */
  async loadTurnBoundary(companyId: string, runId: string): Promise<CodeRunBoundary | null> {
    const state = await this.loadRunState(companyId, runId);
    if (!state) return null;
    const turns = await this.store.listCodeRunTurns(companyId, runId);
    const finishedTurns = turns.filter((turn) => turn.status === "finished");
    const lastFinished = finishedTurns.reduce<CodeRunTurnRecord | null>(
      (best, turn) => (best === null || turn.turnIndex > best.turnIndex ? turn : best),
      null,
    );
    const incomplete = turns
      .filter((turn) => turn.status === "running" || turn.outcome === "unknown_outcome")
      .reduce<CodeRunTurnRecord | null>(
        (best, turn) => (best === null || turn.turnIndex > best.turnIndex ? turn : best),
        null,
      );
    const inDoubt = turns.flatMap((turn) => turn.toolCalls.filter((call) => call.outcome === "unknown_outcome"));
    return {
      runId,
      companyId,
      lastFinishedTurn: lastFinished?.turnIndex ?? 0,
      incompleteTurn: incomplete,
      replayableReadOnlyToolCalls: inDoubt.filter((call) => call.readOnly),
      unknownOutcomeToolCalls: inDoubt.filter((call) => !call.readOnly),
      checkpointId: lastFinished?.checkpointId ?? null,
    };
  }

  /** The reconciler's scan. Returns runs that claim to be running with a lease that is gone. */
  async listStaleRuns(input: { limit?: number; now?: Date } = {}): Promise<CodeRunStateRecord[]> {
    const states = await this.store.listStaleCodeRunStates({
      now: input.now ?? new Date(this.now()),
      limit: input.limit ?? 100,
    });
    for (const state of states) this.observe(state.runId, state.lastEventSeq);
    return states;
  }

  // --- read-only scans for the run reaper ----------------------------------------------------

  /**
   * Tool calls that have made no progress for longer than `olderThanMs`.
   *
   * The scan exists so the reaper can act on a hung call without having to understand the tool catalogue. It
   * returns `longRunning` explicitly, because the decision "this is expected to take minutes, do not kill it"
   * belongs to the tool's declared timeout — not to a name the reaper matches against a list. A reaper that
   * killed `code.deps.add` after five minutes because it looked idle would break the run it was protecting.
   *
   * Read-only, company-scoped (`companyId: null` is the documented system scope) and bounded by `limit` with a
   * keyset cursor, so a busy deployment cannot make the reaper pull an unbounded result set.
   */
  async listStuckToolCalls(input: CodeRunStuckToolCallScanInput): Promise<CodeRunStuckToolCallPage> {
    const limits = this.effectiveLimits();
    const olderThanMs = input.olderThanMs ?? limits.toolCallNoProgressMs;
    const now = input.now ?? new Date(this.now());
    const cutoff = new Date(now.getTime() - olderThanMs);
    const limit = clampScanLimit(input.limit);
    const items: CodeRunStuckToolCall[] = [];
    let cursor = input.cursor ?? null;
    const heartbeatCache = new Map<string, Date | null>();

    // Pages are walked until enough matches are collected or the scan is exhausted. The page guard bounds the
    // work one call can do; `nextCursor` then tells the reaper to continue from where this call stopped.
    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
      const scanned = await this.store.listCodeRunTurnsForScan({
        companyId: input.companyId,
        startedBefore: cutoff,
        limit: Math.min(200, limit * 2),
        ...(cursor ? { cursor } : {}),
        statuses: ["running"],
      });
      for (const turn of scanned.items) {
        for (const call of turn.toolCalls) {
          if (call.outcome !== "unknown_outcome") continue;
          let heartbeat = heartbeatCache.get(turn.runId);
          if (heartbeat === undefined) {
            const state = await this.store.getCodeRunState(turn.companyId, turn.runId);
            heartbeat = state?.heartbeatAt ?? null;
            heartbeatCache.set(turn.runId, heartbeat);
          }
          const lastProgressAt = heartbeat && heartbeat.getTime() > call.startedAt.getTime()
            ? heartbeat
            : call.startedAt;
          if (lastProgressAt.getTime() > cutoff.getTime()) continue;
          const { longRunning, declaredTimeoutMs } = this.classifyToolDuration(call.tool, olderThanMs, input.longRunningTools);
          const state = await this.store.getCodeRunState(turn.companyId, turn.runId);
          items.push({
            runId: turn.runId,
            sessionId: state?.sessionId ?? "",
            companyId: turn.companyId,
            toolCallId: call.toolCallId,
            toolName: call.tool,
            startedAt: call.startedAt,
            lastProgressAt,
            longRunning,
            declaredTimeoutMs,
          });
          if (items.length >= limit) {
            return { items, nextCursor: scanned.nextCursor ?? this.pageCursorFor(turn) };
          }
        }
      }
      if (!scanned.nextCursor) return { items, nextCursor: null };
      cursor = scanned.nextCursor;
    }
    return { items, nextCursor: cursor };
  }

  /**
   * Runs that have exceeded `maxRunMinutes` **plus** a grace period.
   *
   * The grace is not a rounding detail: a run that reports "30 minutes" is allowed to finish a tool call that
   * takes another two minutes, so killing it at exactly 30 minutes would destroy work in progress. Read-only,
   * company-scoped and bounded like `listStuckToolCalls`.
   */
  async listOverdueRuns(input: CodeRunOverdueRunScanInput): Promise<CodeRunOverdueRunScanPage> {
    const limits = this.effectiveLimits();
    const maxRunMinutes = input.maxRunMinutes ?? limits.maxRunMinutes;
    if (maxRunMinutes <= 0) return { items: [], nextCursor: null };
    const graceMs = input.graceMs ?? DEFAULT_OVERDUE_GRACE_MS;
    const now = input.now ?? new Date(this.now());
    const thresholdMs = maxRunMinutes * 60_000 + graceMs;
    const startedBefore = new Date(now.getTime() - thresholdMs);
    const limit = clampScanLimit(input.limit);
    const items: CodeRunOverdueRun[] = [];
    let cursor = input.cursor ?? null;

    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
      const scanned = await this.store.listCodeRunStatesForScan({
        companyId: input.companyId,
        startedBefore,
        limit: Math.min(200, limit * 2),
        ...(cursor ? { cursor } : {}),
      });
      for (const state of scanned.items) {
        const elapsedMs = now.getTime() - state.startedAt.getTime();
        if (elapsedMs <= thresholdMs) continue;
        items.push({
          runId: state.runId,
          sessionId: state.sessionId,
          companyId: state.companyId,
          status: state.status,
          startedAt: state.startedAt,
          heartbeatAt: state.heartbeatAt,
          leaseExpiresAt: state.leaseExpiresAt,
          elapsedMs,
        });
        if (items.length >= limit) {
          return {
            items,
            nextCursor: scanned.nextCursor
              ?? encodeCodeRunScanCursor({ startedAt: state.startedAt.toISOString(), runId: state.runId, turnIndex: 0 }),
          };
        }
      }
      if (!scanned.nextCursor) return { items, nextCursor: null };
      cursor = scanned.nextCursor;
    }
    return { items, nextCursor: cursor };
  }

  /** The limits table, filled in from the plan defaults so a partially injected object is still usable. */
  effectiveLimits(): CodeAgentLimits {
    return { ...DEFAULT_CODE_AGENT_LIMITS, ...this.limits };
  }

  /**
   * Whether a call is expected to run longer than the no-progress threshold. The rule comes from the limits
   * table the tool runtime itself enforces (`code.deps.*` gets the install/build timeout, everything else the
   * command timeout), plus an explicit operator override for tools whose duration the table does not describe.
   */
  private classifyToolDuration(
    tool: string,
    olderThanMs: number,
    explicitLongRunning?: readonly string[],
  ): { longRunning: boolean; declaredTimeoutMs: number } {
    if (explicitLongRunning?.includes(tool)) {
      return { longRunning: true, declaredTimeoutMs: Number.POSITIVE_INFINITY };
    }
    const limits = this.effectiveLimits();
    const declaredTimeoutMs = tool.startsWith("code.deps.") ? limits.installBuildTimeoutMs : limits.commandTimeoutMs;
    return { longRunning: declaredTimeoutMs > olderThanMs, declaredTimeoutMs };
  }

  private pageCursorFor(turn: CodeRunTurnRecord): string {
    return encodeCodeRunScanCursor({
      startedAt: turn.startedAt.toISOString(), runId: turn.runId, turnIndex: turn.turnIndex,
    });
  }

  // --- internals -----------------------------------------------------------------------------
  /**
   * Applies a patch with the next sequence. If the store reports a *higher* sequence than the one we sent, we
   * lost a race with another writer: we adopt their sequence and retry exactly once, so a live run cannot be
   * silently starved of state writes by a reconciler that also writes to the same row.
   */
  private async apply(
    runId: string,
    patch: Omit<ApplyCodeRunStateEventInput, "seq" | "lease"> & { lease?: ApplyCodeRunStateEventInput["lease"] },
  ): Promise<CodeRunStateRecord> {
    const first = this.nextSeq(runId);
    const stored = await this.store.applyCodeRunStateEvent({ ...patch, seq: first } as ApplyCodeRunStateEventInput);
    // An equal sequence proves the write only when it also carries this patch's status: another process may have
    // used the same number first, and a terminal write lost that way left the run "running" until its lease expired.
    if (stored.lastEventSeq === first && (patch.status === undefined || stored.status === patch.status)) {
      this.observe(runId, stored.lastEventSeq);
      return stored;
    }
    if (stored.lastEventSeq >= first) {
      this.observe(runId, stored.lastEventSeq);
      const retried = await this.store.applyCodeRunStateEvent({
        ...patch,
        seq: this.nextSeq(runId),
      } as ApplyCodeRunStateEventInput);
      this.observe(runId, retried.lastEventSeq);
      this.logger?.warn({ runId, attempted: first, observed: stored.lastEventSeq }, "code_run_state_seq_race");
      return retried;
    }
    this.observe(runId, stored.lastEventSeq);
    return stored;
  }

  /** Reserves the number at once, so two writes of one run in this process (a heartbeat and a terminal write) never share it. */
  private nextSeq(runId: string): number {
    const next = (this.seqs.get(runId) ?? 0) + 1;
    this.seqs.set(runId, next);
    return next;
  }

  private observe(runId: string, seq: number): void {
    const current = this.seqs.get(runId) ?? 0;
    if (seq > current) this.seqs.set(runId, seq);
  }
}

/**
 * Standalone form of the stuck-call scan, so a reaper can depend on a function rather than on the log's class
 * shape. It is a one-line delegation: there is exactly one implementation.
 */
export function listStuckToolCalls(
  log: CodeRunStateLog,
  input: CodeRunStuckToolCallScanInput,
): Promise<CodeRunStuckToolCallPage> {
  return log.listStuckToolCalls(input);
}

/** Standalone form of the overdue-run scan; same single implementation as the method. */
export function listOverdueRuns(
  log: CodeRunStateLog,
  input: CodeRunOverdueRunScanInput,
): Promise<CodeRunOverdueRunScanPage> {
  return log.listOverdueRuns(input);
}
