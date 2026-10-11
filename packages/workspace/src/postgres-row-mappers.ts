/* The row mappers of the Postgres workspace store, split out in architectural step 1a of
 * docs/refactoring/PLAN.md.
 *
 * These were private methods that never touched `this`: each takes one database row and builds the domain
 * record. They are the only place that knows the column shape of these tables, so the store imports them and
 * the domain modules that follow reuse them instead of re-deriving the mapping.
 *
 * The bodies are the previous method bodies, de-indented by two spaces because they are no longer class
 * members; the only other change is the signature keyword (`private shortName` became `export function`).
 */
import type {
  CodeActivityEventKind,
  CodeActivityEventRecord,
  CodeContextSummaryRecord,
  DataClassification,
  ExecutionSnapshotRecord,
  ExecutionSnapshotTrigger,
  ReplayBundleRecord,
  ReplayBundleStepRecord,
  ReplayMode,
  ReplayStepKind,
  RetentionClass,
  SnapshotConfigKind,
  SnapshotConfigVersionRecord,
} from "./types";

export function mapExecutionSnapshotRow(row: Record<string, unknown>): ExecutionSnapshotRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    sessionId: String(row.session_id),
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    snapshotVersion: Number(row.snapshot_version),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    payloadHash: String(row.payload_hash),
    prevSnapshotId: row.prev_snapshot_id ? String(row.prev_snapshot_id) : null,
    prevPayloadHash: row.prev_payload_hash ? String(row.prev_payload_hash) : null,
    trigger: String(row["trigger"]) as ExecutionSnapshotTrigger,
    legacy: row.legacy === true,
    createdAt: row.created_at as Date,
    createdBy: String(row.created_by),
  };
}

export function mapSnapshotConfigVersionRow(row: Record<string, unknown>): SnapshotConfigVersionRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    companyId: String(row.company_id),
    kind: String(row.kind) as SnapshotConfigKind,
    version: Number(row.version),
    contentHash: String(row.content_hash),
    content: (row.content ?? {}) as Record<string, unknown>,
    createdAt: row.created_at as Date,
    createdBy: String(row.created_by),
  };
}

export function mapCodeActivityEventRow(row: Record<string, unknown>): CodeActivityEventRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    companyId: String(row.companyId),
    projectId: row.projectId === null || row.projectId === undefined ? null : String(row.projectId),
    sessionId: row.sessionId === null || row.sessionId === undefined ? null : String(row.sessionId),
    runId: row.runId === null || row.runId === undefined ? null : String(row.runId),
    snapshotId: row.snapshotId === null || row.snapshotId === undefined ? null : String(row.snapshotId),
    parentRunId: row.parentRunId === null || row.parentRunId === undefined ? null : String(row.parentRunId),
    parentToolCallId: row.parentToolCallId === null || row.parentToolCallId === undefined ? null : String(row.parentToolCallId),
    parentEventId: row.parentEventId === null || row.parentEventId === undefined ? null : String(row.parentEventId),
    kind: String(row.kind) as CodeActivityEventKind,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    dataClassification: String(row.dataClassification) as DataClassification,
    retentionClass: String(row.retentionClass) as RetentionClass,
    createdAt: new Date(row.createdAt as string | Date),
  };
}

export function mapCodeContextSummaryRow(row: Record<string, unknown>): CodeContextSummaryRecord {
  return {
    id: String(row.id),
    companyId: String(row.companyId),
    projectId: String(row.projectId),
    sessionId: row.sessionId === null || row.sessionId === undefined ? null : String(row.sessionId),
    runId: row.runId === null || row.runId === undefined ? null : String(row.runId),
    snapshotId: row.snapshotId === null || row.snapshotId === undefined ? null : String(row.snapshotId),
    turnIndex: Number(row.turnIndex ?? 0),
    schemaVersion: Number(row.schemaVersion ?? 0),
    summary: (row.summary ?? {}) as Record<string, unknown>,
    summaryText: String(row.summaryText ?? ""),
    contentHash: String(row.contentHash ?? ""),
    dataClassification: String(row.dataClassification) as DataClassification,
    retentionClass: String(row.retentionClass) as RetentionClass,
    createdAt: new Date(row.createdAt as string | Date),
  };
}

export function mapReplayBundleRow(row: Record<string, unknown>): ReplayBundleRecord {
  const nullable = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  const nullableNumber = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    companyId: String(row.companyId),
    projectId: String(row.projectId),
    sessionId: String(row.sessionId),
    runId: String(row.runId),
    executionSnapshotId: nullable(row.executionSnapshotId),
    bundleVersion: Number(row.bundleVersion),
    runnerVersion: nullable(row.runnerVersion),
    systemPromptVersion: nullableNumber(row.systemPromptVersion),
    systemPromptContentHash: nullable(row.systemPromptContentHash),
    modelProfileVersion: nullableNumber(row.modelProfileVersion),
    provider: nullable(row.provider),
    model: nullable(row.model),
    replayMode: String(row.replayMode) as ReplayMode,
    sourceRunId: nullable(row.sourceRunId),
    sourceSnapshotId: nullable(row.sourceSnapshotId),
    terminalStatus: nullable(row.terminalStatus),
    terminalReason: nullable(row.terminalReason),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    payloadHash: String(row.payloadHash),
    replayInputHash: String(row.replayInputHash),
    dataClassification: String(row.dataClassification) as DataClassification,
    retentionClass: String(row.retentionClass) as RetentionClass,
    createdAt: new Date(row.createdAt as string | Date),
  };
}

export function mapReplayBundleStepRow(row: Record<string, unknown>): ReplayBundleStepRecord {
  return {
    id: String(row.id),
    bundleId: String(row.bundleId),
    companyId: String(row.companyId),
    seq: Number(row.seq),
    kind: String(row.kind) as ReplayStepKind,
    turnIndex: Number(row.turnIndex),
    toolCallId: row.toolCallId === null || row.toolCallId === undefined ? null : String(row.toolCallId),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    payloadHash: String(row.payloadHash),
    createdAt: new Date(row.createdAt as string | Date),
  };
}
