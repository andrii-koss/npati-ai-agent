import type { Pool } from "pg";
import type {
  CodeRunTurnRecord,
  CodeRunTurnStatus,
  CreateExecutionSnapshotInput,
  ExecutionSnapshotDiff,
  ExecutionSnapshotRecord,
  ListExecutionSnapshotsInput,
  UpsertCodeRunTurnInput,
} from "./types.js";
import { codeRunTurnColumns } from "./postgres-store-schema.js";
import { mergeCodeRunToolCalls, mergeCodeRunTurnOutcome } from "./types.js";
import { diffSnapshotPayloads } from "./execution-snapshot-hash.js";
import * as support from "./postgres-store-support.js";
import * as project from "./postgres-workspace-repositories.js";

export async function upsertCodeRunTurn(
  pool: Pool,
  input: UpsertCodeRunTurnInput,
): Promise<CodeRunTurnRecord> {
  const existing = await project.getCodeRunTurn(pool, input.companyId, input.runId, input.turnIndex);
  const merged = mergeCodeRunToolCalls(existing?.toolCalls ?? [], input.toolCalls ?? []);
  const outcome = mergeCodeRunTurnOutcome(existing?.outcome ?? null, input.outcome ?? null);
  const status: CodeRunTurnStatus = input.status === "running" && existing && existing.status !== "running"
    ? existing.status
    : input.status;
  const result = await pool.query<CodeRunTurnRecord>(
    `INSERT INTO code_run_turns(
       run_id, company_id, turn_index, status, outcome, tool_calls, messages, results, checkpoint_id,
       started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)
     ON CONFLICT (run_id, turn_index) DO UPDATE SET
       status = EXCLUDED.status,
       outcome = EXCLUDED.outcome,
       tool_calls = EXCLUDED.tool_calls,
       messages = EXCLUDED.messages,
       results = EXCLUDED.results,
       checkpoint_id = COALESCE(EXCLUDED.checkpoint_id, code_run_turns.checkpoint_id),
       finished_at = COALESCE(EXCLUDED.finished_at, code_run_turns.finished_at)
     RETURNING ${codeRunTurnColumns}`,
    [
      input.runId,
      input.companyId,
      input.turnIndex,
      status,
      outcome,
      JSON.stringify(merged),
      JSON.stringify(input.messages ?? existing?.messages ?? []),
      JSON.stringify(input.results ?? existing?.results ?? []),
      input.checkpointId ?? existing?.checkpointId ?? null,
      input.startedAt ?? existing?.startedAt ?? new Date(),
      input.finishedAt ?? existing?.finishedAt ?? null,
    ],
  );
  return result.rows[0]!;
}

export async function insertExecutionSnapshot(pool: Pool, record: ExecutionSnapshotRecord): Promise<void> {
  return support.insertExecutionSnapshot(pool, record);
}

export async function createExecutionSnapshot(
  pool: Pool,
  input: CreateExecutionSnapshotInput,
): Promise<ExecutionSnapshotRecord> {
  return support.createExecutionSnapshot(pool, input);
}

export async function getExecutionSnapshot(
  pool: Pool,
  companyId: string,
  snapshotId: string,
): Promise<ExecutionSnapshotRecord | null> {
  return support.getExecutionSnapshot(pool, companyId, snapshotId);
}

export async function getLatestSnapshotForSession(
  pool: Pool,
  companyId: string,
  sessionId: string,
): Promise<ExecutionSnapshotRecord | null> {
  return support.getLatestSnapshotForSession(pool, companyId, sessionId);
}

export async function getSnapshotForRun(
  pool: Pool,
  companyId: string,
  runId: string,
): Promise<ExecutionSnapshotRecord | null> {
  return support.getSnapshotForRun(pool, companyId, runId);
}

export async function listExecutionSnapshots(
  pool: Pool,
  input: ListExecutionSnapshotsInput,
): Promise<ExecutionSnapshotRecord[]> {
  return support.listExecutionSnapshots(pool, input);
}

export function diffExecutionSnapshots(
  a: ExecutionSnapshotRecord,
  b: ExecutionSnapshotRecord,
): ExecutionSnapshotDiff {
  const { changes, unchanged } = diffSnapshotPayloads(a.payload, b.payload);
  return {
    fromSnapshotId: a.id,
    toSnapshotId: b.id,
    fromVersion: a.snapshotVersion,
    toVersion: b.snapshotVersion,
    changes,
    unchanged,
  };
}
