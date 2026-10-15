import { WorkspaceAccessError } from "./errors";
import type { DataClassification, RetentionClass } from "./retention";

export type CodeRunStateStatus = "running" | "waiting_for_user" | "interrupted" | "completed" | "failed" | "cancelled";

/**
 * Turn status. A turn that was mid-flight when its process died stays `running` in storage — the reconciler
 * is what turns it into `failed` with an `unknown_outcome`, because only it knows the lease is gone.
 */
export type CodeRunTurnStatus = "running" | "finished" | "failed";

/** `unknown_outcome` is a first-class result: "this call may or may not have landed". */
export type CodeRunToolCallOutcome = "ok" | "failed" | "unknown_outcome";

export interface CodeRunStateRecord {
  runId: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  status: CodeRunStateStatus;
  /** The turn the run reached; 0 until the first turn is recorded. */
  turnIndex: number;
  /** Monotonic per run. Every state write carries the next value, which is what makes a write idempotent. */
  lastEventSeq: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  details: Record<string, unknown>;
  revision: number;
}

/**
 * One tool call inside a turn. `readOnly` is recorded **by the caller** (the runner's explicit list) rather
 * than inferred later: it is the single fact that decides whether a recovery may replay the call, so it has to
 * be the same judgement the live run made.
 */
export interface CodeRunToolCallRecord {
  toolCallId: string;
  tool: string;
  readOnly: boolean;
  outcome: CodeRunToolCallOutcome;
  startedAt: Date;
  finishedAt: Date | null;
  errorCode?: string;
}

export interface CodeRunTurnRecord {
  runId: string;
  companyId: string;
  turnIndex: number;
  status: CodeRunTurnStatus;
  outcome: CodeRunToolCallOutcome | null;
  toolCalls: CodeRunToolCallRecord[];
  /** Bounded, metadata-only snapshot of the turn (paths, ids and counts — never file contents). */
  messages: unknown[];
  results: unknown[];
  checkpointId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * C10 (request durability): the state of the run's **original request** record.
 *
 * `not_recorded` is a first-class answer, not a missing row: a run created before this field existed, and a run
 * whose caller supplied no prompt at all, are both honestly "we do not have the request" — which is exactly what
 * a resume must say instead of implying the request was something else. `refused_credential` is the third
 * answer: the request looked like it carried a credential, so its **text was never stored** and only the fact
 * that a record was refused is kept.
 */
export type CodeRunRequestStatus = "not_recorded" | "recorded" | "refused_credential";

/**
 * The request record as the writer decided it. The decision (bounding and the credential scan) belongs to the
 * run-state log, so the store persists a decided value rather than re-deriving one — and the two backends
 * cannot disagree about what was stored.
 */
export interface CodeRunRequestInput {
  status: CodeRunRequestStatus;
  /** The verbatim request. `null` unless `status` is `recorded`. */
  text: string | null;
  /** sha256 of the exact stored text, so a reader can prove it is quoting the recorded bytes. */
  sha256: string | null;
  /** True when the stored text is a bounded prefix of what the user sent; the marker is in the text itself. */
  truncated: boolean;
  recordedAt: Date | null;
}

/** The request record as a reader gets it back, with the tenant and the class it was created under. */
export interface CodeRunRequestRecord extends CodeRunRequestInput {
  runId: string;
  companyId: string;
  /** The classification in force when the run was created; copied so the evidence is self-describing. */
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
}

/**
 * Narrows a stored `request_status`. A value the vocabulary does not know is read as `not_recorded` rather than
 * trusted: an unknown status means this reader cannot say the request is available, and "we cannot say" must
 * never become "here it is".
 */
export function codeRunRequestStatus(value: unknown): CodeRunRequestStatus {
  return value === "recorded" || value === "refused_credential" ? value : "not_recorded";
}

export interface CreateCodeRunStateInput {
  runId: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  /** This process's lease identity. */
  owner: string;
  /** Lease TTL in milliseconds; the row is created already leased by `owner`. */
  leaseMs: number;
  now: Date;
  details?: Record<string, unknown>;
  /**
   * C10: the run's original request, written **in the same row** that creates the run. A separate write would
   * leave a window in which the run exists and its request does not, which is exactly the window a crash
   * immediately after start would land in. Idempotent by run id, so a resume can never overwrite it.
   */
  request?: CodeRunRequestInput;
  /** C10: the class in force at creation, copied from the session so the row states its own class. */
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
}

export interface ApplyCodeRunStateEventInput {
  companyId: string;
  runId: string;
  /**
   * Monotonic per-run sequence. A write whose sequence is not greater than the stored one is **ignored**
   * (returned state unchanged), which is what makes a retried write harmless.
   */
  seq: number;
  status?: CodeRunStateStatus;
  turnIndex?: number;
  heartbeatAt?: Date;
  finishedAt?: Date | null;
  details?: Record<string, unknown>;
  /**
   * Lease transition applied atomically with the rest of the patch:
   * - `acquire` succeeds only when the lease is free, expired or already ours;
   * - `renew` succeeds only for the current owner;
   * - `release` clears the lease only for the current owner.
   * A refused transition leaves the row untouched (it is not an error: the caller learns from `leaseOwner`).
   */
  lease?: { mode: "acquire" | "renew" | "release"; owner: string; now: Date; leaseMs?: number };
}

export interface UpsertCodeRunTurnInput {
  runId: string;
  companyId: string;
  turnIndex: number;
  status: CodeRunTurnStatus;
  outcome?: CodeRunToolCallOutcome | null;
  toolCalls?: readonly CodeRunToolCallRecord[];
  messages?: readonly unknown[];
  results?: readonly unknown[];
  checkpointId?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
}

/**
 * A bounded, keyset-paginated scan. `nextCursor === null` means the scan reached the end of the matching set;
 * a non-null cursor means "there may be more", which is why the caller must page rather than assume it saw
 * everything.
 */
export interface CodeRunScanPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CodeRunStateScanInput {
  /** `null` is the system scope and is only for the reaper/reconciler; every other caller passes a company. */
  companyId: string | null;
  /** Only rows started strictly before this instant are considered. */
  startedBefore: Date;
  limit: number;
  cursor?: string | null;
}

/**
 * C14 (owner decision 3): the read the metrics aggregation needs, over the rows `code_run_states` **already**
 * holds.
 *
 * It exists because the two reads that were available answer different questions and neither can be reused:
 * `listCodeRunStatesForScan` only ever returns `status='running'` rows (it is the reaper's scan, and a finished
 * run is deliberately invisible to it), and `getCodeRunState` addresses one run by id. A success rate needs the
 * **finished** runs of a tenant, which is exactly the set the scan excludes.
 *
 * `companyId` is a plain `string` — not a nullable system scope — so this read cannot be used to page through
 * another tenant's runs; the system scope stays where it belongs, on the reaper's own scan. Every filter is
 * optional and additive, and it reads the existing columns only: no new column, no derived table, no second
 * record of what happened.
 */
export interface ListCodeRunStatesInput {
  /** Required tenant predicate; there is no system scope on this read. */
  companyId: string;
  /** Restrict to these run statuses. Omitted means every status. */
  statuses?: readonly CodeRunStateStatus[];
  /** Only rows started at or after this instant. */
  startedAfter?: Date;
  /** Only rows started strictly before this instant. */
  startedBefore?: Date;
  /** Bounded page size; the store clamps it and never returns more than it. */
  limit?: number;
}

/**
 * C10 (ТЗ item 7): one project that owns a code session, as the sandbox-retention sweep needs to see it.
 *
 * Why a scan is required rather than a per-project walk: a sandbox is referenced only by `projects.sandbox_id`, and
 * the only other durable pointer to it is the project itself. The retention policy has to find every project that
 * can own a sandbox without holding any user's `AuthContext`, and the projects that can are exactly the ones with a
 * code session. The result carries no names, paths or content — two ids and a timestamp.
 */
export interface CodeProjectRef {
  companyId: string;
  projectId: string;
  /** When the project's most recent code session was created; used only to order the scan. */
  lastSessionAt: string;
}

export interface CodeProjectRefScanInput {
  /** `null` is the system scope and is only for the reaper; every other caller passes a company. */
  companyId: string | null;
  limit: number;
  cursor?: string | null;
}

export interface CodeProjectRefScanPage {
  items: CodeProjectRef[];
  nextCursor: string | null;
}

export interface CodeRunTurnScanInput extends CodeRunStateScanInput {
  /** Turn statuses to include; a stuck tool call only ever lives in a turn that has not closed. */
  statuses?: readonly CodeRunTurnStatus[];
}

/**
 * Merges tool calls by `toolCallId`: a call that is recorded again (for example "started, then finished")
 * replaces its previous entry instead of adding a second one. The order is the order of first appearance,
 * which is the order the model asked for them in.
 */
export function mergeCodeRunToolCalls(
  existing: readonly CodeRunToolCallRecord[],
  incoming: readonly CodeRunToolCallRecord[],
): CodeRunToolCallRecord[] {
  const merged = new Map<string, CodeRunToolCallRecord>();
  for (const call of existing) merged.set(call.toolCallId, call);
  for (const call of incoming) {
    const previous = merged.get(call.toolCallId);
    if (!previous) {
      merged.set(call.toolCallId, call);
      continue;
    }
    // `readOnly` is a fact about the tool, never something a later write may flip — it is what decides whether
    // a recovery is allowed to replay the call, so the live run's judgement wins.
    // A terminal outcome is likewise never downgraded to `unknown_outcome`: the write-ahead record exists to
    // say "we do not know yet", not to erase a result that was already observed.
    const outcome = previous.outcome !== "unknown_outcome" && call.outcome === "unknown_outcome"
      ? previous.outcome
      : call.outcome;
    merged.set(call.toolCallId, { ...call, readOnly: previous.readOnly, outcome });
  }
  return [...merged.values()];
}

/**
 * A terminal outcome wins over a later `unknown_outcome`: recording "we no longer know" must never erase a
 * result that was already observed, and `unknown_outcome` may only be set when nothing better exists.
 */
export function mergeCodeRunTurnOutcome(
  existing: CodeRunToolCallOutcome | null,
  incoming: CodeRunToolCallOutcome | null,
): CodeRunToolCallOutcome | null {
  if (incoming === null) return existing;
  if (existing === null) return incoming;
  if (existing === "unknown_outcome") return incoming;
  return existing;
}

/** True when the outcome means "this call may or may not have landed". */
export function isUnknownOutcome(outcome: CodeRunToolCallOutcome | null): boolean {
  return outcome === "unknown_outcome";
}

/**
 * Keyset cursor for the run scans: the position of the last row of a page. It is deliberately opaque to
 * callers so the ordering can change without breaking a reaper that kept a cursor across a restart. It is
 * URI-encoded JSON rather than base64 on purpose: `types.ts` is shared with the web app, and reaching for a
 * Node-only global here would make the module unusable in a browser bundle.
 */
export interface CodeRunScanCursor {
  startedAt: string;
  runId: string;
  turnIndex: number;
}

export function encodeCodeRunScanCursor(cursor: CodeRunScanCursor): string {
  return encodeURIComponent(JSON.stringify(cursor));
}

export function decodeCodeRunScanCursor(value: string | null | undefined): CodeRunScanCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<CodeRunScanCursor>;
    if (typeof parsed.startedAt !== "string" || typeof parsed.runId !== "string" || typeof parsed.turnIndex !== "number") {
      return null;
    }
    return { startedAt: parsed.startedAt, runId: parsed.runId, turnIndex: parsed.turnIndex };
  } catch {
    // An unreadable cursor is treated as "start from the beginning" rather than as an error: a reaper that
    // kept a cursor across a deployment must still make progress.
    return null;
  }
}

/** Hard upper bound on one scan page. A caller asking for more is clamped, never obeyed. */
export const MAX_CODE_RUN_SCAN_LIMIT = 500;

export function clampScanLimit(limit: number | undefined, fallback = 100): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(MAX_CODE_RUN_SCAN_LIMIT, Math.floor(limit)));
}

/**
 * Storage refusal for the run-state tables. It extends `WorkspaceAccessError` so the existing route mappers
 * report a precise code instead of a 500.
 */
export class CodeRunStateStoreError extends WorkspaceAccessError {
  override readonly code: string;
  override readonly status: number;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "CodeRunStateStoreError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 403;
    this.status = this.httpStatus;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

