import { randomUUID } from "node:crypto";
import type { DataClassification, RetentionClass } from "./types";

export const CODE_SESSION_HEAD_REASONS = ["created", "resume", "rewind", "fork"] as const;
export type CodeSessionHeadReason = (typeof CODE_SESSION_HEAD_REASONS)[number];

export const CODE_REWIND_TARGETS = ["code", "conversation", "both"] as const;
export type CodeRewindTarget = (typeof CODE_REWIND_TARGETS)[number];

export const CODE_REWIND_STATUSES = ["pending", "completed", "partial", "failed"] as const;
export type CodeRewindStatus = (typeof CODE_REWIND_STATUSES)[number];

export const CODE_FORK_STATUSES = ["pending", "completed", "failed"] as const;
export type CodeForkStatus = (typeof CODE_FORK_STATUSES)[number];

export const DEFAULT_DATA_CLASSIFICATION: DataClassification = "confidential";
/** Derived operational evidence, like the compaction summaries of 079: it need not outlive its transcript. */
export const DEFAULT_NOTICE_RETENTION_CLASS: RetentionClass = "short";
export const DEFAULT_LEDGER_RETENTION_CLASS: RetentionClass = "standard";

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
export interface LedgerBackend<TRecord, TComplete> {
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
export async function claimOperation<TRecord extends { status: string; companyId: string; operationId: string }, TComplete>(
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

export const HEAD_COLUMNS = `id, company_id AS "companyId", project_id AS "projectId", session_id AS "sessionId",
  run_id AS "runId", turn_index AS "turnIndex", reason, operation_id AS "operationId", revision,
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt",
  data_classification AS "dataClassification", retention_class AS "retentionClass"`;
export const NOTICE_COLUMNS = `id, company_id AS "companyId", project_id AS "projectId", session_id AS "sessionId",
  run_id AS "runId", reason, last_finished_turn AS "lastFinishedTurn",
  replayed_read_only AS "replayedReadOnly", unknown_outcome AS "unknownOutcome",
  workspace_diff AS "workspaceDiff", message_for_model AS "messageForModel", created_at AS "createdAt",
  data_classification AS "dataClassification", retention_class AS "retentionClass"`;
export const REWIND_COLUMNS = `id, company_id AS "companyId", project_id AS "projectId", session_id AS "sessionId",
  operation_id AS "operationId", target, run_id AS "runId", turn_index AS "turnIndex",
  checkpoint_id AS "checkpointId", restored_checkpoint_id AS "restoredCheckpointId",
  safety_checkpoint_id AS "safetyCheckpointId", previous_head_turn AS "previousHeadTurn",
  head_turn AS "headTurn", status, failure_reason AS "failureReason", requested_by AS "requestedBy",
  created_at AS "createdAt", finished_at AS "finishedAt",
  data_classification AS "dataClassification", retention_class AS "retentionClass"`;
export const FORK_COLUMNS = `id, company_id AS "companyId", project_id AS "projectId",
  parent_session_id AS "parentSessionId", session_id AS "sessionId", operation_id AS "operationId",
  run_id AS "runId", turn_index AS "turnIndex", checkpoint_id AS "checkpointId",
  copied_plan AS "copiedPlan", copied_todos AS "copiedTodos", copied_head AS "copiedHead",
  copied_goal AS "copiedGoal", plan_revision AS "planRevision", todo_count AS "todoCount",
  status, failure_reason AS "failureReason", requested_by AS "requestedBy", created_at AS "createdAt",
  finished_at AS "finishedAt", data_classification AS "dataClassification", retention_class AS "retentionClass"`;

export interface CodeSessionDurabilityQueryable {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}
