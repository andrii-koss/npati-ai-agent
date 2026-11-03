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
import { createHash } from "node:crypto";
import type { CodeAgentLimits } from "./code-agent-config";
import { scanTextForSecrets } from "./code-secret-scanner";

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

export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 15_000;
/** How much longer than `maxRunMinutes` a run may keep working before it counts as overdue. */
export const DEFAULT_OVERDUE_GRACE_MS = 5 * 60_000;
/** Upper bound on the pages one scan call walks, so a single call cannot read the whole table. */
export const MAX_SCAN_PAGES = 20;

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
  /** Defaults to `limits.maxRunMinutes` (0, no limit, by default). */
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
export const FORBIDDEN_STATE_KEYS = [
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
