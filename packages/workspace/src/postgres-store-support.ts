import type { CodeActivityEventKind, CodeActivityEventRecord, CodeContextSummaryRecord, DataClassification, ExecutionSnapshotRecord, ExecutionSnapshotTrigger, ReplayBundleRecord, ReplayBundleStepRecord, ReplayMode, ReplayStepKind, RetentionClass, SnapshotConfigKind, SnapshotConfigVersionRecord } from "./types";
import { Pool } from "pg";
import { businessColumns, companyColumns, projectColumns } from "./postgres-store-schema";
import { AuthContext, Business, Company, Project, WorkspaceAccessError, WorkspaceNotFoundError } from "./types";
import { randomUUID } from "node:crypto";
import type { CreateExecutionSnapshotInput, ListExecutionSnapshotsInput } from "./types";
import { ExecutionSnapshotImmutableError } from "./types";
import { snapshotPayloadHash } from "./execution-snapshot-hash";

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
export async function ensureIdentity(pool: Pool, context: AuthContext) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO users(id, external_subject, display_name) VALUES ($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET external_subject=COALESCE(EXCLUDED.external_subject,users.external_subject), updated_at=now()`, [context.userId, context.externalSubject ?? null, "Dev User"]);
    await client.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES ($1,$2,$3) ON CONFLICT(id) DO NOTHING`, [context.workspaceId, "My Workspace", context.userId]);
    await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'owner') ON CONFLICT(workspace_id,user_id) DO NOTHING`, [context.workspaceId, context.userId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function assertMember(pool: Pool, context: AuthContext) {
  const result = await pool.query("SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId]);
  if (!result.rowCount) throw new WorkspaceAccessError("Workspace access denied");
  return String(result.rows[0].role);
}

export async function getBusiness(pool: Pool, context: AuthContext, businessId: string) {
  await assertMember(pool, context);
  const result = await pool.query<Business>(`SELECT ${businessColumns} FROM businesses WHERE id=$1 AND workspace_id=$2`, [businessId, context.workspaceId]);
  if (!result.rowCount) throw new WorkspaceAccessError("Business is not available in this workspace");
  return result.rows[0]!;
}

export async function assertCompany(pool: Pool, context: AuthContext, companyId: string) {
  if (context.companyId && context.companyId !== companyId) throw new WorkspaceAccessError("API key is not valid for this company");
  await assertMember(pool, context);
  const result = await pool.query<Company>(`SELECT ${companyColumns} FROM companies WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, [companyId, context.workspaceId, context.userId]);
  if (!result.rowCount) throw new WorkspaceAccessError("Company is not available to this user");
  return result.rows[0]!;
}

export async function getProject(pool: Pool, context: AuthContext, companyId: string, projectId: string) {
  await assertCompany(pool, context, companyId);
  const result = await pool.query<Project>(`SELECT ${projectColumns} FROM projects
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4`,
    [projectId, context.workspaceId, companyId, context.userId]);
  if (!result.rows[0]) throw new WorkspaceNotFoundError("Project not found");
  return result.rows[0];
}

export async function insertExecutionSnapshot(pool: Pool, record: ExecutionSnapshotRecord): Promise<void> {
    await pool.query(
      `INSERT INTO execution_snapshots(id, workspace_id, company_id, project_id, session_id, run_id,
         snapshot_version, payload, payload_hash, prev_snapshot_id, prev_payload_hash, "trigger", legacy,
         created_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
      [record.id, record.workspaceId, record.companyId, record.projectId, record.sessionId, record.runId,
        record.snapshotVersion, JSON.stringify(record.payload), record.payloadHash, record.prevSnapshotId,
        record.prevPayloadHash, record.trigger, record.legacy, record.createdAt, record.createdBy],
    );
  }
export async function createExecutionSnapshot(pool: Pool, input: CreateExecutionSnapshotInput): Promise<ExecutionSnapshotRecord> {
    const id = input.id ?? randomUUID();
    const attempted = await pool.query("SELECT 1 FROM execution_snapshots WHERE id=$1", [id]);

    if (attempted.rowCount) throw new ExecutionSnapshotImmutableError(`create with existing id ${id}`);

    const head = await pool.query<{ id: string; payload_hash: string; snapshot_version: number }>(
      `SELECT id, payload_hash, snapshot_version FROM execution_snapshots
        WHERE company_id=$1 AND session_id=$2 ORDER BY snapshot_version DESC LIMIT 1`,
      [input.companyId, input.sessionId],
    );
    const previous = head.rows[0] ?? null;
    const record: ExecutionSnapshotRecord = {
      id,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      snapshotVersion: (previous?.snapshot_version ?? 0) + 1,
      payload: input.payload,
      payloadHash: snapshotPayloadHash(input.payload),
      prevSnapshotId: previous?.id ?? null,
      prevPayloadHash: previous?.payload_hash ?? null,
      trigger: input.trigger,
      legacy: input.legacy === true,
      createdAt: input.now ?? new Date(),
      createdBy: input.createdBy,
    };
    await insertExecutionSnapshot(pool, record);
    return record;
  }
export async function getExecutionSnapshot(pool: Pool, companyId: string, snapshotId: string): Promise<ExecutionSnapshotRecord | null> {
    const result = await pool.query(
      "SELECT * FROM execution_snapshots WHERE company_id=$1 AND id=$2", [companyId, snapshotId],
    );
    const row = result.rows[0];
    return row ? mapExecutionSnapshotRow(row) : null;
  }
export async function getLatestSnapshotForSession(pool: Pool, companyId: string, sessionId: string): Promise<ExecutionSnapshotRecord | null> {
    const result = await pool.query(
      `SELECT * FROM execution_snapshots WHERE company_id=$1 AND session_id=$2
        ORDER BY snapshot_version DESC LIMIT 1`, [companyId, sessionId],
    );
    const row = result.rows[0];
    return row ? mapExecutionSnapshotRow(row) : null;
  }
export async function getSnapshotForRun(pool: Pool, companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null> {
    const result = await pool.query(
      `SELECT * FROM execution_snapshots WHERE company_id=$1 AND run_id=$2
        ORDER BY snapshot_version DESC LIMIT 1`, [companyId, runId],
    );
    const row = result.rows[0];
    return row ? mapExecutionSnapshotRow(row) : null;
  }
export async function listExecutionSnapshots(pool: Pool, input: ListExecutionSnapshotsInput): Promise<ExecutionSnapshotRecord[]> {
    const limit = Math.min(Math.max(input.limit, 1), 500);
    const result = await pool.query(
      `SELECT * FROM execution_snapshots
        WHERE company_id=$1 AND ($2::text IS NULL OR session_id=$2) AND ($3::text IS NULL OR project_id=$3)
        ORDER BY created_at DESC LIMIT $4`,
      [input.companyId, input.sessionId ?? null, input.projectId ?? null, limit],
    );
    return result.rows.map((row) => mapExecutionSnapshotRow(row));
  }
