import { randomUUID } from "node:crypto";
import type { DataClassification, RetentionClass } from "./types";

/**
 * C10: the durable state of a session's *conversation position* and of the two operations that move it
 * (rewind, fork), plus the reconciler's recovery notice.
 *
 * The rules live here, in one place shared by the Postgres and in-memory backends, for the same reason the
 * question and goal rules do: a rule that exists only in SQL silently stops applying on the fast path, and then
 * "the database guarantees it" means nothing.
 *
 * Four decisions are load-bearing:
 *
 * 1. **A rewind is a pointer, not a deletion.** `code_replay_bundles` and `code_context_summaries` are
 *    append-only in the database (078, 079), so the transcript cannot be truncated by removing rows — and it
 *    must not be: what the model was shown is evidence. The head row is the cursor every reader applies.
 * 2. **An operation is claimed before it is performed.** Both ledgers key on `(companyId, operationId)` and are
 *    inserted first with `status: "pending"`. A rewind creates a pre-rewind checkpoint; claiming first is what
 *    stops a retried request from creating a second safety checkpoint and a second audit entry. A repeated call
 *    with the same id returns the stored outcome; a call that arrives while the first is still pending is
 *    refused rather than duplicated.
 * 3. **Revision-checked.** The head is versioned and written with `expectedRevision`, so two concurrent rewinds
 *    cannot silently overwrite each other; a stale revision is a 409 the caller can retry.
 * 4. **Tenant-scoped everywhere.** `companyId` is the first argument of every read, so another company's
 *    session, run or operation is indistinguishable from one that never existed.
 */

export const CODE_SESSION_HEAD_REASONS = ["created", "resume", "rewind", "fork"] as const;
export type CodeSessionHeadReason = (typeof CODE_SESSION_HEAD_REASONS)[number];

export const CODE_REWIND_TARGETS = ["code", "conversation", "both"] as const;
export type CodeRewindTarget = (typeof CODE_REWIND_TARGETS)[number];

export const CODE_REWIND_STATUSES = ["pending", "completed", "partial", "failed"] as const;
export type CodeRewindStatus = (typeof CODE_REWIND_STATUSES)[number];

export const CODE_FORK_STATUSES = ["pending", "completed", "failed"] as const;
export type CodeForkStatus = (typeof CODE_FORK_STATUSES)[number];

const DEFAULT_DATA_CLASSIFICATION: DataClassification = "confidential";
/** Derived operational evidence, like the compaction summaries of 079: it need not outlive its transcript. */
const DEFAULT_NOTICE_RETENTION_CLASS: RetentionClass = "short";
const DEFAULT_LEDGER_RETENTION_CLASS: RetentionClass = "standard";

/**
 * The conversation cursor of a session. `turnIndex` is the highest turn of `runId` that is part of the
 * conversation: a reader shows turns up to and including it. `revision` is the optimistic-lock version.
 */
export interface CodeSessionHeadRecord {
  id: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string | null;
  turnIndex: number;
  reason: CodeSessionHeadReason;
  operationId: string | null;
  revision: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
}

export interface SetCodeSessionHeadInput {
  companyId: string;
  projectId: string;
  sessionId: string;
  runId?: string | null;
  turnIndex: number;
  reason: CodeSessionHeadReason;
  operationId?: string | null;
  /** The revision the caller read; `0` means "no head exists yet". */
  expectedRevision: number;
  createdBy?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
}

/** The persisted reconciler notice: what a recovery told the model, and what it was in doubt about. */
export interface CodeRunRecoveryNoticeRecord {
  id: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  reason: string;
  lastFinishedTurn: number;
  replayedReadOnly: Array<{ toolCallId: string; tool: string; replayed: boolean }>;
  unknownOutcome: Array<{ toolCallId: string; tool: string }>;
  workspaceDiff: Record<string, unknown> | null;
  messageForModel: string;
  createdAt: Date;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
}

export interface CreateCodeRunRecoveryNoticeInput {
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  reason: string;
  lastFinishedTurn?: number;
  replayedReadOnly?: Array<{ toolCallId: string; tool: string; replayed: boolean }>;
  unknownOutcome?: Array<{ toolCallId: string; tool: string }>;
  workspaceDiff?: Record<string, unknown> | null;
  messageForModel: string;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
}

export interface CodeSessionRewindRecord {
  id: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  operationId: string;
  target: CodeRewindTarget;
  runId: string | null;
  turnIndex: number | null;
  checkpointId: string | null;
  restoredCheckpointId: string | null;
  safetyCheckpointId: string | null;
  previousHeadTurn: number | null;
  headTurn: number | null;
  status: CodeRewindStatus;
  failureReason: string | null;
  requestedBy: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
}

export interface CreateCodeSessionRewindInput {
  companyId: string;
  projectId: string;
  sessionId: string;
  operationId: string;
  target: CodeRewindTarget;
  runId?: string | null;
  turnIndex?: number | null;
  checkpointId?: string | null;
  previousHeadTurn?: number | null;
  requestedBy?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
}

export interface CompleteCodeSessionRewindInput {
  companyId: string;
  operationId: string;
  status: Exclude<CodeRewindStatus, "pending">;
  restoredCheckpointId?: string | null;
  safetyCheckpointId?: string | null;
  headTurn?: number | null;
  failureReason?: string | null;
  now?: Date;
}

export interface CodeSessionForkRecord {
  id: string;
  companyId: string;
  projectId: string;
  parentSessionId: string;
  sessionId: string | null;
  operationId: string;
  runId: string | null;
  turnIndex: number | null;
  checkpointId: string | null;
  copiedPlan: boolean;
  copiedTodos: boolean;
  copiedHead: boolean;
  copiedGoal: boolean;
  planRevision: number | null;
  todoCount: number;
  status: CodeForkStatus;
  failureReason: string | null;
  requestedBy: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
}

export interface CreateCodeSessionForkInput {
  companyId: string;
  projectId: string;
  parentSessionId: string;
  operationId: string;
  runId?: string | null;
  turnIndex?: number | null;
  checkpointId?: string | null;
  requestedBy?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
}

export interface CompleteCodeSessionForkInput {
  companyId: string;
  operationId: string;
  status: Exclude<CodeForkStatus, "pending">;
  sessionId?: string | null;
  copiedPlan?: boolean;
  copiedTodos?: boolean;
  copiedHead?: boolean;
  copiedGoal?: boolean;
  planRevision?: number | null;
  todoCount?: number;
  failureReason?: string | null;
  now?: Date;
}

/** Raised when the caller's revision is stale: the cursor moved since it was read. */
export class CodeSessionHeadRevisionConflictError extends Error {
  readonly code = "session_head_revision_conflict";
  readonly httpStatus = 409;
  readonly retryable = true;
  readonly details: Record<string, unknown>;
  constructor(details: Record<string, unknown> = {}) {
    super("Session head revision conflict");
    this.name = "CodeSessionHeadRevisionConflictError";
    this.details = details;
  }
}

/** Raised when an operation id is already claimed but not yet finished. */
export class CodeSessionOperationInProgressError extends Error {
  readonly code = "session_operation_in_progress";
  readonly httpStatus = 409;
  readonly retryable = true;
  readonly details: Record<string, unknown>;
  constructor(operationId: string) {
    super("This operation is already in progress");
    this.name = "CodeSessionOperationInProgressError";
    this.details = { operationId };
  }
}

/** Raised by a ledger insert that names an operation the caller did not claim. */
export class CodeSessionOperationNotFoundError extends Error {
  readonly code = "session_operation_not_found";
  readonly httpStatus = 404;
  readonly retryable = false;
  readonly details: Record<string, unknown>;
  constructor(details: Record<string, unknown> = {}) {
    super("Operation not found");
    this.name = "CodeSessionOperationNotFoundError";
    this.details = details;
  }
}

function required(value: string | undefined | null, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`C10 session state requires ${field}`);
  return text;
}

function turnIndexValue(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new Error("C10 session state requires a non-negative turn index");
  return Math.trunc(numeric);
}

/** Shared row validation, so a bad row reaches neither backend. */
export function prepareHeadRow(input: SetCodeSessionHeadInput): CodeSessionHeadRecord {
  const now = input.now ?? new Date();
  return {
    id: input.id ?? randomUUID(),
    companyId: required(input.companyId, "companyId"),
    projectId: required(input.projectId, "projectId"),
    sessionId: required(input.sessionId, "sessionId"),
    runId: input.runId ?? null,
    turnIndex: turnIndexValue(input.turnIndex),
    reason: input.reason,
    operationId: input.operationId ?? null,
    revision: input.expectedRevision + 1,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
    dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
    retentionClass: input.retentionClass ?? DEFAULT_LEDGER_RETENTION_CLASS,
  };
}

export function prepareNoticeRow(input: CreateCodeRunRecoveryNoticeInput): CodeRunRecoveryNoticeRecord {
  const message = String(input.messageForModel ?? "");
  if (!message.trim()) throw new Error("C10 recovery notice requires a message");
  return {
    id: input.id ?? randomUUID(),
    companyId: required(input.companyId, "companyId"),
    projectId: required(input.projectId, "projectId"),
    sessionId: required(input.sessionId, "sessionId"),
    runId: required(input.runId, "runId"),
    reason: required(input.reason, "reason"),
    lastFinishedTurn: turnIndexValue(input.lastFinishedTurn),
    replayedReadOnly: [...(input.replayedReadOnly ?? [])],
    unknownOutcome: [...(input.unknownOutcome ?? [])],
    workspaceDiff: input.workspaceDiff ?? null,
    messageForModel: message,
    createdAt: input.now ?? new Date(),
    dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
    retentionClass: input.retentionClass ?? DEFAULT_NOTICE_RETENTION_CLASS,
  };
}

export function prepareRewindRow(input: CreateCodeSessionRewindInput): CodeSessionRewindRecord {
  const target = input.target;
  if (!CODE_REWIND_TARGETS.includes(target)) throw new Error(`Unknown rewind target ${String(target)}`);
  const checkpointId = input.checkpointId ?? null;
  // Enforced in migration 082 as well: a code-touching rewind that names no checkpoint has nothing to roll
  // back to, and letting it through would mark a rewind "completed" that changed nothing.
  if (target !== "conversation" && !checkpointId) {
    throw new Error("A code-touching rewind requires the checkpoint it rolls back to");
  }
  return {
    id: input.id ?? randomUUID(),
    companyId: required(input.companyId, "companyId"),
    projectId: required(input.projectId, "projectId"),
    sessionId: required(input.sessionId, "sessionId"),
    operationId: required(input.operationId, "operationId"),
    target,
    runId: input.runId ?? null,
    turnIndex: input.turnIndex === undefined || input.turnIndex === null ? null : turnIndexValue(input.turnIndex),
    checkpointId,
    restoredCheckpointId: null,
    safetyCheckpointId: null,
    previousHeadTurn: input.previousHeadTurn ?? null,
    headTurn: null,
    status: "pending",
    failureReason: null,
    requestedBy: input.requestedBy ?? null,
    createdAt: input.now ?? new Date(),
    finishedAt: null,
    dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
    retentionClass: input.retentionClass ?? DEFAULT_LEDGER_RETENTION_CLASS,
  };
}

export function prepareForkRow(input: CreateCodeSessionForkInput): CodeSessionForkRecord {
  return {
    id: input.id ?? randomUUID(),
    companyId: required(input.companyId, "companyId"),
    projectId: required(input.projectId, "projectId"),
    parentSessionId: required(input.parentSessionId, "parentSessionId"),
    sessionId: null,
    operationId: required(input.operationId, "operationId"),
    runId: input.runId ?? null,
    turnIndex: input.turnIndex === undefined || input.turnIndex === null ? null : turnIndexValue(input.turnIndex),
    checkpointId: input.checkpointId ?? null,
    copiedPlan: false,
    copiedTodos: false,
    copiedHead: false,
    copiedGoal: false,
    planRevision: null,
    todoCount: 0,
    status: "pending",
    failureReason: null,
    requestedBy: input.requestedBy ?? null,
    createdAt: input.now ?? new Date(),
    finishedAt: null,
    dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
    retentionClass: input.retentionClass ?? DEFAULT_LEDGER_RETENTION_CLASS,
  };
}

/** The two ledgers share one shape, so the Postgres and in-memory backends share one claim protocol. */
interface LedgerBackend<TRecord, TComplete> {
  insert(row: TRecord): Promise<TRecord | null>;
  get(companyId: string, operationId: string): Promise<TRecord | null>;
  complete(input: TComplete): Promise<TRecord>;
}

/**
 * Shared claim/complete logic. Both ledgers follow the same protocol, so it is written once:
 *
 *   - insert the claim; a conflict means another attempt already claimed this operation id;
 *   - read it back: a finished row is the stored answer (idempotent replay), a pending row is an operation
 *     that is still running (refused, never duplicated).
 */
async function claimOperation<TRecord extends { status: string; companyId: string; operationId: string }, TComplete>(
  backend: LedgerBackend<TRecord, TComplete>,
  row: TRecord,
): Promise<{ record: TRecord; replayed: boolean }> {
  const inserted = await backend.insert(row);
  if (inserted) return { record: inserted, replayed: false };
  const existing = await backend.get(row.companyId, row.operationId);
  if (!existing) throw new CodeSessionOperationNotFoundError({ operationId: row.operationId });
  if (existing.status === "pending") throw new CodeSessionOperationInProgressError(row.operationId);
  return { record: existing, replayed: true };
}

const HEAD_COLUMNS = `id, company_id AS "companyId", project_id AS "projectId", session_id AS "sessionId",
  run_id AS "runId", turn_index AS "turnIndex", reason, operation_id AS "operationId", revision,
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt",
  data_classification AS "dataClassification", retention_class AS "retentionClass"`;
const NOTICE_COLUMNS = `id, company_id AS "companyId", project_id AS "projectId", session_id AS "sessionId",
  run_id AS "runId", reason, last_finished_turn AS "lastFinishedTurn",
  replayed_read_only AS "replayedReadOnly", unknown_outcome AS "unknownOutcome",
  workspace_diff AS "workspaceDiff", message_for_model AS "messageForModel", created_at AS "createdAt",
  data_classification AS "dataClassification", retention_class AS "retentionClass"`;
const REWIND_COLUMNS = `id, company_id AS "companyId", project_id AS "projectId", session_id AS "sessionId",
  operation_id AS "operationId", target, run_id AS "runId", turn_index AS "turnIndex",
  checkpoint_id AS "checkpointId", restored_checkpoint_id AS "restoredCheckpointId",
  safety_checkpoint_id AS "safetyCheckpointId", previous_head_turn AS "previousHeadTurn",
  head_turn AS "headTurn", status, failure_reason AS "failureReason", requested_by AS "requestedBy",
  created_at AS "createdAt", finished_at AS "finishedAt",
  data_classification AS "dataClassification", retention_class AS "retentionClass"`;
const FORK_COLUMNS = `id, company_id AS "companyId", project_id AS "projectId",
  parent_session_id AS "parentSessionId", session_id AS "sessionId", operation_id AS "operationId",
  run_id AS "runId", turn_index AS "turnIndex", checkpoint_id AS "checkpointId",
  copied_plan AS "copiedPlan", copied_todos AS "copiedTodos", copied_head AS "copiedHead",
  copied_goal AS "copiedGoal", plan_revision AS "planRevision", todo_count AS "todoCount",
  status, failure_reason AS "failureReason", requested_by AS "requestedBy", created_at AS "createdAt",
  finished_at AS "finishedAt", data_classification AS "dataClassification", retention_class AS "retentionClass"`;

export interface CodeSessionDurabilityQueryable {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export class PostgresCodeSessionDurabilityStore {
  constructor(private readonly pool: CodeSessionDurabilityQueryable) {}

  async getHead(companyId: string, sessionId: string): Promise<CodeSessionHeadRecord | null> {
    const result = await this.pool.query<CodeSessionHeadRecord>(
      `SELECT ${HEAD_COLUMNS} FROM code_session_heads WHERE company_id=$1 AND session_id=$2`,
      [companyId, sessionId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Writes the cursor. `expectedRevision: 0` means "no head yet": the insert wins if nothing is there, and the
   * conditional update is what makes two concurrent rewinds race *visibly* — the loser gets a revision conflict
   * instead of silently overwriting the winner.
   */
  async setHead(input: SetCodeSessionHeadInput): Promise<CodeSessionHeadRecord> {
    const row = prepareHeadRow(input);
    const updated = await this.pool.query<CodeSessionHeadRecord>(
      `UPDATE code_session_heads SET
         run_id=COALESCE($5, run_id), turn_index=$6, reason=$7, operation_id=$8,
         revision=revision+1, updated_at=$9, data_classification=$10, retention_class=$11
       WHERE company_id=$1 AND session_id=$2 AND revision=$3 AND project_id=$4
       RETURNING ${HEAD_COLUMNS}`,
      [row.companyId, row.sessionId, input.expectedRevision, row.projectId, row.runId, row.turnIndex, row.reason,
        row.operationId, row.updatedAt, row.dataClassification, row.retentionClass],
    );
    if (updated.rows[0]) return updated.rows[0];
    const current = await this.getHead(row.companyId, row.sessionId);
    if (current) throw new CodeSessionHeadRevisionConflictError({ sessionId: row.sessionId, expectedRevision: input.expectedRevision, currentRevision: current.revision });
    if (input.expectedRevision !== 0) {
      throw new CodeSessionHeadRevisionConflictError({ sessionId: row.sessionId, expectedRevision: input.expectedRevision, currentRevision: 0 });
    }
    const inserted = await this.pool.query<CodeSessionHeadRecord>(
      `INSERT INTO code_session_heads (id, company_id, project_id, session_id, run_id, turn_index, reason,
         operation_id, revision, created_by, created_at, updated_at, data_classification, retention_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$10,$11,$12)
       ON CONFLICT (company_id, session_id) DO NOTHING
       RETURNING ${HEAD_COLUMNS}`,
      [row.id, row.companyId, row.projectId, row.sessionId, row.runId, row.turnIndex, row.reason, row.operationId,
        row.createdBy, row.createdAt, row.dataClassification, row.retentionClass],
    );
    const created = inserted.rows[0];
    if (!created) throw new CodeSessionHeadRevisionConflictError({ sessionId: row.sessionId, expectedRevision: 0, currentRevision: 1 });
    return created;
  }

  async createNotice(input: CreateCodeRunRecoveryNoticeInput): Promise<CodeRunRecoveryNoticeRecord> {
    const row = prepareNoticeRow(input);
    const result = await this.pool.query<CodeRunRecoveryNoticeRecord>(
      `INSERT INTO code_run_recovery_notices (id, company_id, project_id, session_id, run_id, reason,
         last_finished_turn, replayed_read_only, unknown_outcome, workspace_diff, message_for_model, created_at,
         data_classification, retention_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
       RETURNING ${NOTICE_COLUMNS}`,
      [row.id, row.companyId, row.projectId, row.sessionId, row.runId, row.reason, row.lastFinishedTurn,
        JSON.stringify(row.replayedReadOnly), JSON.stringify(row.unknownOutcome),
        row.workspaceDiff === null ? null : JSON.stringify(row.workspaceDiff), row.messageForModel, row.createdAt,
        row.dataClassification, row.retentionClass],
    );
    return result.rows[0]!;
  }

  async getLatestNotice(companyId: string, runId: string): Promise<CodeRunRecoveryNoticeRecord | null> {
    const result = await this.pool.query<CodeRunRecoveryNoticeRecord>(
      `SELECT ${NOTICE_COLUMNS} FROM code_run_recovery_notices
        WHERE company_id=$1 AND run_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [companyId, runId],
    );
    return result.rows[0] ?? null;
  }

  async listNotices(input: { companyId: string; runId: string; limit?: number }): Promise<CodeRunRecoveryNoticeRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    const result = await this.pool.query<CodeRunRecoveryNoticeRecord>(
      `SELECT ${NOTICE_COLUMNS} FROM code_run_recovery_notices
        WHERE company_id=$1 AND run_id=$2 ORDER BY created_at DESC, id DESC LIMIT $3`,
      [input.companyId, input.runId, Math.min(limit, 200)],
    );
    return result.rows;
  }

  async createRewind(input: CreateCodeSessionRewindInput): Promise<{ record: CodeSessionRewindRecord; replayed: boolean }> {
    const row = prepareRewindRow(input);
    return claimOperation<CodeSessionRewindRecord, CompleteCodeSessionRewindInput>(
      {
        insert: async (candidate) => {
          const result = await this.pool.query<CodeSessionRewindRecord>(
            `INSERT INTO code_session_rewinds (id, company_id, project_id, session_id, operation_id, target,
               run_id, turn_index, checkpoint_id, previous_head_turn, status, requested_by, created_at,
               data_classification, retention_class)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14)
             ON CONFLICT (company_id, operation_id) DO NOTHING
             RETURNING ${REWIND_COLUMNS}`,
            [candidate.id, candidate.companyId, candidate.projectId, candidate.sessionId, candidate.operationId,
              candidate.target, candidate.runId, candidate.turnIndex, candidate.checkpointId,
              candidate.previousHeadTurn, candidate.requestedBy, candidate.createdAt,
              candidate.dataClassification, candidate.retentionClass],
          );
          return result.rows[0] ?? null;
        },
        get: (companyId, operationId) => this.getRewind(companyId, operationId),
        complete: (input) => this.completeRewind(input),
      },
      row,
    );
  }

  async getRewind(companyId: string, operationId: string): Promise<CodeSessionRewindRecord | null> {
    const result = await this.pool.query<CodeSessionRewindRecord>(
      `SELECT ${REWIND_COLUMNS} FROM code_session_rewinds WHERE company_id=$1 AND operation_id=$2`,
      [companyId, operationId],
    );
    return result.rows[0] ?? null;
  }

  async completeRewind(input: CompleteCodeSessionRewindInput): Promise<CodeSessionRewindRecord> {
    const result = await this.pool.query<CodeSessionRewindRecord>(
      `UPDATE code_session_rewinds SET
         status=$3, restored_checkpoint_id=COALESCE($4, restored_checkpoint_id),
         safety_checkpoint_id=COALESCE($5, safety_checkpoint_id), head_turn=COALESCE($6, head_turn),
         failure_reason=$7, finished_at=$8
       WHERE company_id=$1 AND operation_id=$2 AND status='pending'
       RETURNING ${REWIND_COLUMNS}`,
      [input.companyId, input.operationId, input.status, input.restoredCheckpointId ?? null,
        input.safetyCheckpointId ?? null, input.headTurn ?? null, input.failureReason ?? null,
        input.now ?? new Date()],
    );
    const row = result.rows[0];
    if (row) return row;
    const current = await this.getRewind(input.companyId, input.operationId);
    if (!current) throw new CodeSessionOperationNotFoundError({ operationId: input.operationId });
    return current;
  }

  /**
   * Reopens a claim that provably changed nothing, so a retry can perform the operation.
   *
   * Two cases, and both are the residue of a process that died: a `failed` operation with no recorded effect, and
   * a `pending` claim older than the staleness window. The `safety_checkpoint_id IS NULL AND
   * restored_checkpoint_id IS NULL AND head_turn IS NULL` guard is what keeps this safe — an operation that
   * created a checkpoint or moved the cursor is never reopened, because reopening it is exactly how a retry would
   * create a second safety checkpoint.
   */
  async reopenRewind(input: {
    companyId: string;
    operationId: string;
    staleMs?: number;
    now?: Date;
  }): Promise<{ record: CodeSessionRewindRecord | null; reopened: boolean }> {
    const now = input.now ?? new Date();
    const staleBefore = new Date(now.getTime() - (input.staleMs ?? 0));
    const result = await this.pool.query<CodeSessionRewindRecord>(
      `UPDATE code_session_rewinds SET status='pending', failure_reason=NULL, finished_at=NULL
        WHERE company_id=$1 AND operation_id=$2
          AND safety_checkpoint_id IS NULL AND restored_checkpoint_id IS NULL AND head_turn IS NULL
          AND (status='failed' OR (status='pending' AND created_at < $3))
        RETURNING ${REWIND_COLUMNS}`,
      [input.companyId, input.operationId, staleBefore],
    );
    if (result.rows[0]) return { record: result.rows[0], reopened: true };
    return { record: await this.getRewind(input.companyId, input.operationId), reopened: false };
  }

  async listRewinds(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionRewindRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    const result = await this.pool.query<CodeSessionRewindRecord>(
      `SELECT ${REWIND_COLUMNS} FROM code_session_rewinds
        WHERE company_id=$1 AND session_id=$2 ORDER BY created_at DESC, id DESC LIMIT $3`,
      [input.companyId, input.sessionId, Math.min(limit, 200)],
    );
    return result.rows;
  }

  async createFork(input: CreateCodeSessionForkInput): Promise<{ record: CodeSessionForkRecord; replayed: boolean }> {
    const row = prepareForkRow(input);
    return claimOperation<CodeSessionForkRecord, CompleteCodeSessionForkInput>(
      {
        insert: async (candidate) => {
          const result = await this.pool.query<CodeSessionForkRecord>(
            `INSERT INTO code_session_forks (id, company_id, project_id, parent_session_id, operation_id,
               run_id, turn_index, checkpoint_id, status, requested_by, created_at,
               data_classification, retention_class)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12)
             ON CONFLICT (company_id, operation_id) DO NOTHING
             RETURNING ${FORK_COLUMNS}`,
            [candidate.id, candidate.companyId, candidate.projectId, candidate.parentSessionId,
              candidate.operationId, candidate.runId, candidate.turnIndex, candidate.checkpointId,
              candidate.requestedBy, candidate.createdAt, candidate.dataClassification,
              candidate.retentionClass],
          );
          return result.rows[0] ?? null;
        },
        get: (companyId, operationId) => this.getFork(companyId, operationId),
        complete: (input) => this.completeFork(input),
      },
      row,
    );
  }

  async getFork(companyId: string, operationId: string): Promise<CodeSessionForkRecord | null> {
    const result = await this.pool.query<CodeSessionForkRecord>(
      `SELECT ${FORK_COLUMNS} FROM code_session_forks WHERE company_id=$1 AND operation_id=$2`,
      [companyId, operationId],
    );
    return result.rows[0] ?? null;
  }

  async completeFork(input: CompleteCodeSessionForkInput): Promise<CodeSessionForkRecord> {
    const result = await this.pool.query<CodeSessionForkRecord>(
      `UPDATE code_session_forks SET
         status=$3, session_id=COALESCE($4, session_id), copied_plan=$5, copied_todos=$6, copied_head=$7,
         copied_goal=$8, plan_revision=$9, todo_count=$10, failure_reason=$11, finished_at=$12
       WHERE company_id=$1 AND operation_id=$2 AND status='pending'
       RETURNING ${FORK_COLUMNS}`,
      [input.companyId, input.operationId, input.status, input.sessionId ?? null,
        input.copiedPlan === true, input.copiedTodos === true, input.copiedHead === true,
        input.copiedGoal === true, input.planRevision ?? null, input.todoCount ?? 0,
        input.failureReason ?? null, input.now ?? new Date()],
    );
    const row = result.rows[0];
    if (row) return row;
    const current = await this.getFork(input.companyId, input.operationId);
    if (!current) throw new CodeSessionOperationNotFoundError({ operationId: input.operationId });
    return current;
  }

  async listForks(input: { companyId: string; parentSessionId: string; limit?: number }): Promise<CodeSessionForkRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    const result = await this.pool.query<CodeSessionForkRecord>(
      `SELECT ${FORK_COLUMNS} FROM code_session_forks
        WHERE company_id=$1 AND parent_session_id=$2 ORDER BY created_at DESC, id DESC LIMIT $3`,
      [input.companyId, input.parentSessionId, Math.min(limit, 200)],
    );
    return result.rows;
  }

  /**
   * Reopens a fork claim that provably created no session, so a retry can perform the fork. `session_id IS NULL` is
   * the guard that matters: a claim which already minted a session is never reopened, because reopening it is
   * exactly how a retry would create a second session.
   */
  async reopenFork(input: {
    companyId: string;
    operationId: string;
    staleMs?: number;
    now?: Date;
  }): Promise<{ record: CodeSessionForkRecord | null; reopened: boolean }> {
    const now = input.now ?? new Date();
    const staleBefore = new Date(now.getTime() - (input.staleMs ?? 0));
    const result = await this.pool.query<CodeSessionForkRecord>(
      `UPDATE code_session_forks SET status='pending', failure_reason=NULL, finished_at=NULL
        WHERE company_id=$1 AND operation_id=$2 AND session_id IS NULL
          AND (status='failed' OR (status='pending' AND created_at < $3))
        RETURNING ${FORK_COLUMNS}`,
      [input.companyId, input.operationId, staleBefore],
    );
    if (result.rows[0]) return { record: result.rows[0], reopened: true };
    return { record: await this.getFork(input.companyId, input.operationId), reopened: false };
  }
}

/**
 * The in-memory backend. It enforces the same three rules the SQL enforces — one head per session, one row per
 * operation id, and a revision-checked update — so a rule cannot be true only in production.
 */
export class InMemoryCodeSessionDurabilityStore {
  private readonly heads = new Map<string, CodeSessionHeadRecord>();
  private readonly notices = new Map<string, CodeRunRecoveryNoticeRecord>();
  private readonly rewinds = new Map<string, CodeSessionRewindRecord>();
  private readonly forks = new Map<string, CodeSessionForkRecord>();

  private headKey(companyId: string, sessionId: string): string { return `${companyId}\u0000${sessionId}`; }
  private operationKey(companyId: string, operationId: string): string { return `${companyId}\u0000${operationId}`; }

  async getHead(companyId: string, sessionId: string): Promise<CodeSessionHeadRecord | null> {
    const row = this.heads.get(this.headKey(companyId, sessionId));
    return row ? { ...row } : null;
  }

  async setHead(input: SetCodeSessionHeadInput): Promise<CodeSessionHeadRecord> {
    const row = prepareHeadRow(input);
    const key = this.headKey(row.companyId, row.sessionId);
    const current = this.heads.get(key);
    if (current) {
      if (current.revision !== input.expectedRevision || current.projectId !== row.projectId) {
        throw new CodeSessionHeadRevisionConflictError({ sessionId: row.sessionId, expectedRevision: input.expectedRevision, currentRevision: current.revision });
      }
      const next: CodeSessionHeadRecord = {
        ...current,
        runId: row.runId ?? current.runId,
        turnIndex: row.turnIndex,
        reason: row.reason,
        operationId: row.operationId,
        revision: current.revision + 1,
        updatedAt: row.updatedAt,
        dataClassification: row.dataClassification,
        retentionClass: row.retentionClass,
      };
      this.heads.set(key, next);
      return { ...next };
    }
    if (input.expectedRevision !== 0) {
      throw new CodeSessionHeadRevisionConflictError({ sessionId: row.sessionId, expectedRevision: input.expectedRevision, currentRevision: 0 });
    }
    this.heads.set(key, row);
    return { ...row };
  }

  async createNotice(input: CreateCodeRunRecoveryNoticeInput): Promise<CodeRunRecoveryNoticeRecord> {
    const row = prepareNoticeRow(input);
    this.notices.set(row.id, row);
    return { ...row };
  }

  async getLatestNotice(companyId: string, runId: string): Promise<CodeRunRecoveryNoticeRecord | null> {
    const found = [...this.notices.values()]
      .filter((row) => row.companyId === companyId && row.runId === runId)
      .sort((a, b) => (b.createdAt.getTime() - a.createdAt.getTime()) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0];
    return found ? { ...found } : null;
  }

  async listNotices(input: { companyId: string; runId: string; limit?: number }): Promise<CodeRunRecoveryNoticeRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    return [...this.notices.values()]
      .filter((row) => row.companyId === input.companyId && row.runId === input.runId)
      .sort((a, b) => (b.createdAt.getTime() - a.createdAt.getTime()) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, Math.min(limit, 200))
      .map((row) => ({ ...row }));
  }

  async createRewind(input: CreateCodeSessionRewindInput): Promise<{ record: CodeSessionRewindRecord; replayed: boolean }> {
    const row = prepareRewindRow(input);
    const key = this.operationKey(row.companyId, row.operationId);
    const existing = this.rewinds.get(key);
    if (existing) {
      if (existing.status === "pending") throw new CodeSessionOperationInProgressError(row.operationId);
      return { record: { ...existing }, replayed: true };
    }
    this.rewinds.set(key, row);
    return { record: { ...row }, replayed: false };
  }

  async getRewind(companyId: string, operationId: string): Promise<CodeSessionRewindRecord | null> {
    const row = this.rewinds.get(this.operationKey(companyId, operationId));
    return row ? { ...row } : null;
  }

  async completeRewind(input: CompleteCodeSessionRewindInput): Promise<CodeSessionRewindRecord> {
    const key = this.operationKey(input.companyId, input.operationId);
    const current = this.rewinds.get(key);
    if (!current) throw new CodeSessionOperationNotFoundError({ operationId: input.operationId });
    if (current.status !== "pending") return { ...current };
    const next: CodeSessionRewindRecord = {
      ...current,
      status: input.status,
      restoredCheckpointId: input.restoredCheckpointId ?? current.restoredCheckpointId,
      safetyCheckpointId: input.safetyCheckpointId ?? current.safetyCheckpointId,
      headTurn: input.headTurn ?? current.headTurn,
      failureReason: input.failureReason ?? null,
      finishedAt: input.now ?? new Date(),
    };
    this.rewinds.set(key, next);
    return { ...next };
  }

  async listRewinds(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionRewindRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    return [...this.rewinds.values()]
      .filter((row) => row.companyId === input.companyId && row.sessionId === input.sessionId)
      .sort((a, b) => (b.createdAt.getTime() - a.createdAt.getTime()) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, Math.min(limit, 200))
      .map((row) => ({ ...row }));
  }

  /** Same rule as the Postgres backend: only a claim that provably changed nothing may be reopened. */
  async reopenRewind(input: {
    companyId: string;
    operationId: string;
    staleMs?: number;
    now?: Date;
  }): Promise<{ record: CodeSessionRewindRecord | null; reopened: boolean }> {
    const key = this.operationKey(input.companyId, input.operationId);
    const current = this.rewinds.get(key);
    if (!current) return { record: null, reopened: false };
    const untouched = current.safetyCheckpointId === null
      && current.restoredCheckpointId === null
      && current.headTurn === null;
    const now = (input.now ?? new Date()).getTime();
    const stale = current.status === "pending" && current.createdAt.getTime() < now - (input.staleMs ?? 0);
    if (!untouched || (current.status !== "failed" && !stale)) {
      return { record: { ...current }, reopened: false };
    }
    const next: CodeSessionRewindRecord = { ...current, status: "pending", failureReason: null, finishedAt: null };
    this.rewinds.set(key, next);
    return { record: { ...next }, reopened: true };
  }

  async createFork(input: CreateCodeSessionForkInput): Promise<{ record: CodeSessionForkRecord; replayed: boolean }> {
    const row = prepareForkRow(input);
    const key = this.operationKey(row.companyId, row.operationId);
    const existing = this.forks.get(key);
    if (existing) {
      if (existing.status === "pending") throw new CodeSessionOperationInProgressError(row.operationId);
      return { record: { ...existing }, replayed: true };
    }
    this.forks.set(key, row);
    return { record: { ...row }, replayed: false };
  }

  async getFork(companyId: string, operationId: string): Promise<CodeSessionForkRecord | null> {
    const row = this.forks.get(this.operationKey(companyId, operationId));
    return row ? { ...row } : null;
  }

  async completeFork(input: CompleteCodeSessionForkInput): Promise<CodeSessionForkRecord> {
    const key = this.operationKey(input.companyId, input.operationId);
    const current = this.forks.get(key);
    if (!current) throw new CodeSessionOperationNotFoundError({ operationId: input.operationId });
    if (current.status !== "pending") return { ...current };
    const next: CodeSessionForkRecord = {
      ...current,
      status: input.status,
      sessionId: input.sessionId ?? current.sessionId,
      copiedPlan: input.copiedPlan === true,
      copiedTodos: input.copiedTodos === true,
      copiedHead: input.copiedHead === true,
      copiedGoal: input.copiedGoal === true,
      planRevision: input.planRevision ?? null,
      todoCount: input.todoCount ?? 0,
      failureReason: input.failureReason ?? null,
      finishedAt: input.now ?? new Date(),
    };
    this.forks.set(key, next);
    return { ...next };
  }

  async listForks(input: { companyId: string; parentSessionId: string; limit?: number }): Promise<CodeSessionForkRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    return [...this.forks.values()]
      .filter((row) => row.companyId === input.companyId && row.parentSessionId === input.parentSessionId)
      .sort((a, b) => (b.createdAt.getTime() - a.createdAt.getTime()) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, Math.min(limit, 200))
      .map((row) => ({ ...row }));
  }

  /** Same rule as the Postgres backend: only a claim that created no session may be reopened. */
  async reopenFork(input: {
    companyId: string;
    operationId: string;
    staleMs?: number;
    now?: Date;
  }): Promise<{ record: CodeSessionForkRecord | null; reopened: boolean }> {
    const key = this.operationKey(input.companyId, input.operationId);
    const current = this.forks.get(key);
    if (!current) return { record: null, reopened: false };
    const noSession = current.sessionId === null;
    const now = (input.now ?? new Date()).getTime();
    const stale = current.status === "pending" && current.createdAt.getTime() < now - (input.staleMs ?? 0);
    if (!noSession || (current.status !== "failed" && !stale)) {
      return { record: { ...current }, reopened: false };
    }
    const next: CodeSessionForkRecord = { ...current, status: "pending", failureReason: null, finishedAt: null };
    this.forks.set(key, next);
    return { record: { ...next }, reopened: true };
  }
}
