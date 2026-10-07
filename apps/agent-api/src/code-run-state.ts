import type {
  ApplyCodeRunStateEventInput,
  AuthContext,
  CodeRunRequestInput,
  CodeRunRequestRecord,
  CodeRunScanPage,
  CodeRunStateRecord,
  CodeRunStateScanInput,
  CodeRunStateStatus,
  CodeRunToolCallOutcome,
  CodeRunToolCallRecord,
  CodeRunTurnRecord,
  CodeRunTurnScanInput,
  CodeRunTurnStatus,
  CreateCodeRunStateInput,
  DataClassification,
  RetentionClass,
  UpsertCodeRunTurnInput,
} from "@npati/workspace";
import { clampScanLimit, encodeCodeRunScanCursor } from "@npati/workspace";
import { createHash } from "node:crypto";
import type { CodeAgentLimits } from "./code-agent-config";
import { DEFAULT_CODE_AGENT_LIMITS } from "./code-agent-config";
import { scanTextForSecrets } from "./code-secret-scanner";

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

/** The store surface this log needs. Structural, so a test can inject an in-memory double. */
export interface CodeRunStateStorePort {
  createCodeRunState(input: CreateCodeRunStateInput): Promise<CodeRunStateRecord>;
  applyCodeRunStateEvent(input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord>;
  getCodeRunState(companyId: string, runId: string): Promise<CodeRunStateRecord | null>;
  listStaleCodeRunStates(input: { now: Date; limit: number }): Promise<CodeRunStateRecord[]>;
  upsertCodeRunTurn(input: UpsertCodeRunTurnInput): Promise<CodeRunTurnRecord>;
  getCodeRunTurn(companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null>;
  listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]>;
  /** C10: the run's original request; the one read that returns content (see `loadRunRequest`). */
  getCodeRunRequest(companyId: string, runId: string): Promise<CodeRunRequestRecord | null>;
  /** Read-only keyset scans, used by `listStuckToolCalls` / `listOverdueRuns` (and by the reaper). */
  listCodeRunStatesForScan(input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>>;
  listCodeRunTurnsForScan(input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>>;
}

export interface CodeRunStateLogOptions {
  store: CodeRunStateStorePort;
  now?: () => number;
  /** Lease TTL from `NPATI_CODE_RUN_LEASE_MS`; the runner resolves the limits and passes them in. */
  leaseMs?: number;
  heartbeatMs?: number;
  /**
   * The same limits table the runner and the reaper use. The scans below derive "is this tool long-running?"
   * from the tool's own declared timeout here instead of guessing from a tool name.
   */
  limits?: Partial<CodeAgentLimits>;
  logger?: { warn(input: unknown, message?: string): void };
}

export interface CodeRunStartInput {
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId: string;
  /** Stable lease identity of the process driving the run. */
  owner: string;
  /** Caller-supplied run id; the log generates one when absent so every run has durable state. */
  runId?: string;
  details?: Record<string, unknown>;
  /**
   * C10: the run's **original request**, stored by the same write that creates the run. Only the first
   * `startRun` of a run id can write it — the row creation is idempotent by run id — so a resume re-running this
   * call with its continuation prompt cannot replace the user's own words. Omitted means "this caller has no
   * request to record", which is stored as `not_recorded` rather than as an empty string.
   */
  request?: string | null;
  /** C10: the class in force at creation, copied from the session so the record states its own class. */
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  /** The request ceiling; defaults to `CODE_RUN_REQUEST_MAX_CHARS`. Injectable so a test can force truncation. */
  requestMaxChars?: number;
}

export interface CodeRunStartResult {
  runId: string;
  state: CodeRunStateRecord;
}

/**
 * The recovery boundary: everything a resuming process (or the reconciler) needs in order to continue
 * without repeating a mutating call.
 */
export interface CodeRunBoundary {
  runId: string;
  companyId: string;
  /** The highest turn that finished; 0 when the run died inside its first turn. */
  lastFinishedTurn: number;
  /** The turn that was in flight when the lease was lost, if any. */
  incompleteTurn: CodeRunTurnRecord | null;
  /** Read-only calls whose result is unknown: replaying them cannot change the workspace. */
  replayableReadOnlyToolCalls: CodeRunToolCallRecord[];
  /** Mutating, shell or unknown calls whose result is unknown: they must never be replayed. */
  unknownOutcomeToolCalls: CodeRunToolCallRecord[];
  /** Checkpoint of the last finished turn — the comparison base for the workspace diff. */
  checkpointId: string | null;
}

/** Why a resume was refused before any lease was taken. `not_found` means the run row itself is gone. */
export type CodeRunResumeRefusal = "waiting_for_user" | "terminal" | "not_found";

export interface CodeRunResumeResult {
  /** True when this process now holds the lease and the run is `running` again. */
  held: boolean;
  /** The stored state; `null` only when the run row does not exist (or belongs to another company). */
  state: CodeRunStateRecord | null;
  refused: CodeRunResumeRefusal | null;
}

/**
 * The one rule that decides whether a run may be resumed, exported so the log, the resume service and the tests
 * cannot disagree about it:
 *
 *   - `running` (with an expired lease) and `interrupted` are exactly the states a crash leaves behind, so both
 *     resume — and resuming an expired-lease `running` run is why the reconciler does not have to run first;
 *   - `waiting_for_user` is a **pause on a question**, not an interruption. Resuming it would run the turn the
 *     question stopped and orphan the answer on its way;
 *   - `completed`/`failed`/`cancelled` are terminal. Continuing one would need a new run id, and a second replay
 *     bundle for the same run cannot exist (`(run_id, bundle_version)` is unique), so the honest answer is a
 *     refusal rather than a run that silently loses its recording.
 */
export function refuseResume(status: CodeRunStateStatus): CodeRunResumeRefusal | null {
  if (status === "waiting_for_user") return "waiting_for_user";
  if (status === "completed" || status === "failed" || status === "cancelled") return "terminal";
  return null;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
/** How much longer than `maxRunMinutes` a run may keep working before it counts as overdue. */
const DEFAULT_OVERDUE_GRACE_MS = 5 * 60_000;
/** Upper bound on the pages one scan call walks, so a single call cannot read the whole table. */
const MAX_SCAN_PAGES = 20;

/**
 * One tool call that has stopped making progress. `longRunning` is the field the reaper must respect: when it
 * is true the call is expected to take longer than the threshold, so "no progress" is not evidence of a hang.
 */
export interface CodeRunStuckToolCall {
  runId: string;
  sessionId: string;
  companyId: string;
  toolCallId: string;
  toolName: string;
  startedAt: Date;
  lastProgressAt: Date;
  /** True when the tool's own declared timeout exceeds the threshold: do not treat it as hung. */
  longRunning: boolean;
  /** The declared timeout the judgement was made from, so a log line can explain the decision. */
  declaredTimeoutMs: number;
}

export interface CodeRunStuckToolCallScanInput {
  /** `null` is the system scope (reaper/reconciler only); a company id keeps the scan tenant-scoped. */
  companyId: string | null;
  /** Defaults to `limits.toolCallNoProgressMs` (300 s in the plan defaults). */
  olderThanMs?: number;
  now?: Date;
  limit?: number;
  cursor?: string | null;
  /** Explicit operator declaration for tools the limits table does not describe. */
  longRunningTools?: readonly string[];
}

export interface CodeRunStuckToolCallPage {
  items: CodeRunStuckToolCall[];
  nextCursor: string | null;
}

/** One run that has run longer than `maxRunMinutes` plus the grace period. */
export interface CodeRunOverdueRun {
  runId: string;
  sessionId: string;
  companyId: string;
  status: CodeRunStateStatus;
  startedAt: Date;
  heartbeatAt: Date | null;
  leaseExpiresAt: Date | null;
  elapsedMs: number;
}

export interface CodeRunOverdueRunScanInput {
  companyId: string | null;
  /** Defaults to `limits.maxRunMinutes` (30 in the plan defaults). */
  maxRunMinutes?: number;
  /** Defaults to five minutes; a run is never overdue at exactly `maxRunMinutes`. */
  graceMs?: number;
  now?: Date;
  limit?: number;
  cursor?: string | null;
}

export interface CodeRunOverdueRunScanPage {
  items: CodeRunOverdueRun[];
  nextCursor: string | null;
}

/** Keys that would turn a metadata record into a content leak. */
const FORBIDDEN_STATE_KEYS = [
  "content", "prompt", "command", "diff", "patch", "body", "stdout", "stderr", "token", "secret",
  "password", "credentials", "apikey", "api_key", "filecontent",
] as const;

/** Where a persisted run estimate came from. Versioned vocabulary so a future real meter can be told apart. */
export const RUN_ESTIMATE_SOURCE = "runner_summary_estimate";

/** What the runner reports about a finished run, before it is stamped as an estimate. */
export interface CodeRunEstimateInput {
  /**
   * Named `tokenCount`, not `tokens`: the run-state guard forbids a `token` key because that is a credential, and a
   * count must never be confused with a value. The API surfaces it as `tokens` because there it is unambiguous.
   */
  tokenCount: number;
  costUsd: number | null;
  turns: number;
  toolCalls: number;
  filesChanged: number;
  diffStats: { files: number; linesAdded: number; linesRemoved: number };
}

/**
 * A persisted run estimate. `estimated` is part of the stored shape, not a UI hint: any reader that shows these
 * numbers must show them as an estimate, and a future provider-metered value would arrive as `estimated: false`
 * with a different `source` — so the contract already has room for the honest distinction (rule 13).
 */
export interface CodeRunEstimate extends CodeRunEstimateInput {
  estimated: true;
  source: typeof RUN_ESTIMATE_SOURCE;
}

/** Reads a persisted estimate out of a run-state `details` bag, validating rather than trusting its shape. */
export function readRunEstimate(details: Record<string, unknown> | null | undefined): CodeRunEstimate | null {
  const candidate = details?.estimate;
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  const numberOf = (key: string): number | null => (typeof value[key] === "number" && Number.isFinite(value[key]) ? (value[key] as number) : null);
  const tokens = numberOf("tokenCount");
  if (tokens === null) return null;
  const cost = typeof value.costUsd === "number" && Number.isFinite(value.costUsd) ? value.costUsd : null;
  const diffStats = value.diffStats && typeof value.diffStats === "object" ? (value.diffStats as Record<string, unknown>) : {};
  return {
    tokenCount: tokens,
    costUsd: cost,
    turns: numberOf("turns") ?? 0,
    toolCalls: numberOf("toolCalls") ?? 0,
    filesChanged: numberOf("filesChanged") ?? 0,
    diffStats: {
      files: typeof diffStats.files === "number" ? diffStats.files : 0,
      linesAdded: typeof diffStats.linesAdded === "number" ? diffStats.linesAdded : 0,
      linesRemoved: typeof diffStats.linesRemoved === "number" ? diffStats.linesRemoved : 0,
    },
    estimated: true,
    source: RUN_ESTIMATE_SOURCE,
  };
}

/**
 * A run-state record may carry names, ids, counts and reasons — never content. This is asserted on every
 * write rather than only in tests: a caller that passes a command string in `details` fails loudly instead of
 * silently persisting it.
 */
export function assertNoSensitiveRunState(value: unknown, label = "run state"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSensitiveRunState(entry, label);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((FORBIDDEN_STATE_KEYS as readonly string[]).includes(key.toLowerCase())) {
      throw new Error(`${label} must not carry "${key}": run state is metadata only`);
    }
    assertNoSensitiveRunState(entry, label);
  }
}

/**
 * C10 (request durability): how much of the original request is recorded.
 *
 * A ceiling exists because the request is content that becomes durable evidence, and an unbounded prompt would
 * make one run's row as large as the user's whole paste. 20 000 characters is far beyond a real task
 * description and far below anything that would threaten the row; when it is exceeded the stored text says so
 * in place (`truncated` plus the marker appended to the text), so a reader can never mistake a bounded prefix
 * for the whole request.
 */
export const CODE_RUN_REQUEST_MAX_CHARS = 20_000;

/** The visible marker placed where a stored request was cut, so the record explains itself. */
export function requestTruncationMarker(droppedChars: number): string {
  return `\n…[request truncated: ${droppedChars} character(s) were not recorded]`;
}

function sha256HexOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Decides what is stored for a run's original request. Pure, so the decision is testable without a store and the
 * runner, the log and the tests cannot disagree about what "recorded" means.
 *
 * Three outcomes, and the third is the one that matters:
 *
 *   - **not recorded** — the caller passed no prompt (a caller that drives the runner programmatically), or one
 *     that is only whitespace. `status` says so instead of the row simply being empty, because a resume has to
 *     tell "there was no request" from "we lost it".
 *   - **recorded** — the verbatim text, bounded, with its own sha256 so a reader can prove it is quoting the
 *     recorded bytes and not a paraphrase.
 *   - **refused_credential** — the text looked like it carried a credential. It is **not** stored and **not**
 *     redacted into a placeholder: the C4a rule is that a secret refuses the write rather than being silently
 *     stripped, because a `REDACTED:` placeholder is a reference that must never reach disk. Only the fact that
 *     a record was refused is kept, which is what lets a resume answer honestly instead of pretending the run
 *     had no request.
 */
export function decideRunRequest(input: {
  request: string | null | undefined;
  now: Date;
  maxChars?: number;
}): CodeRunRequestInput {
  const raw = typeof input.request === "string" ? input.request : "";
  if (!raw.trim()) {
    return { status: "not_recorded", text: null, sha256: null, truncated: false, recordedAt: null };
  }
  if (scanTextForSecrets(raw).findings.length > 0) {
    return { status: "refused_credential", text: null, sha256: null, truncated: false, recordedAt: null };
  }
  const limit = Math.max(1, input.maxChars ?? CODE_RUN_REQUEST_MAX_CHARS);
  const truncated = raw.length > limit;
  const text = truncated ? `${raw.slice(0, limit)}${requestTruncationMarker(raw.length - limit)}` : raw;
  return {
    status: "recorded",
    text,
    sha256: sha256HexOf(text),
    truncated,
    recordedAt: input.now,
  };
}

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
  async loadRunRequest(companyId: string, runId: string): Promise<CodeRunRequestRecord | null> {
    return this.store.getCodeRunRequest(companyId, runId);
  }

  /** Takes the lease when it is free, expired or already ours. Returns the stored state either way. */
  async acquireLease(input: { companyId: string; runId: string; owner: string }): Promise<{ held: boolean; state: CodeRunStateRecord }> {
    const state = await this.apply(input.runId, {
      companyId: input.companyId,
      runId: input.runId,
      lease: { mode: "acquire", owner: input.owner, now: new Date(this.now()), leaseMs: this.leaseMs },
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
    if (stored.lastEventSeq === first) {
      this.observe(runId, stored.lastEventSeq);
      return stored;
    }
    if (stored.lastEventSeq > first) {
      const retried = await this.store.applyCodeRunStateEvent({
        ...patch,
        seq: stored.lastEventSeq + 1,
      } as ApplyCodeRunStateEventInput);
      this.observe(runId, retried.lastEventSeq);
      this.logger?.warn({ runId, attempted: first, observed: stored.lastEventSeq }, "code_run_state_seq_race");
      return retried;
    }
    this.observe(runId, stored.lastEventSeq);
    return stored;
  }

  private nextSeq(runId: string): number {
    return (this.seqs.get(runId) ?? 0) + 1;
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
