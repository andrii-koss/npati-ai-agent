import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  DEFAULT_DATA_CLASSIFICATION,
  DEFAULT_RETENTION_CLASS,
  type CreateReplayBundleInput,
  type CreateSnapshotConfigVersionInput,
  type ListReplayBundlesInput,
  type ReplayBundleRecord,
  type ReplayBundleStepRecord,
  type SnapshotConfigKind,
  type SnapshotConfigVersionRecord,
  WorkspaceAccessError,
} from "./types.js";
import { replayBundleColumns, replayBundleStepColumns } from "./postgres-store-schema.js";
import * as support from "./postgres-store-support.js";

export async function findSnapshotConfigVersionByHash(
  pool: Pool,
  companyId: string,
  kind: SnapshotConfigKind,
  contentHash: string,
): Promise<SnapshotConfigVersionRecord | null> {
  const result = await pool.query(
    "SELECT * FROM code_snapshot_config_versions WHERE company_id=$1 AND kind=$2 AND content_hash=$3",
    [companyId, kind, contentHash],
  );
  const row = result.rows[0];
  return row ? support.mapSnapshotConfigVersionRow(row) : null;
}

export async function getSnapshotConfigVersion(
  pool: Pool,
  companyId: string,
  kind: SnapshotConfigKind,
  version: number,
): Promise<SnapshotConfigVersionRecord | null> {
  const result = await pool.query(
    "SELECT * FROM code_snapshot_config_versions WHERE company_id=$1 AND kind=$2 AND version=$3",
    [companyId, kind, version],
  );
  const row = result.rows[0];
  return row ? support.mapSnapshotConfigVersionRow(row) : null;
}

export async function listSnapshotConfigVersions(
  pool: Pool,
  companyId: string,
  kind: SnapshotConfigKind,
): Promise<SnapshotConfigVersionRecord[]> {
  const result = await pool.query(
    "SELECT * FROM code_snapshot_config_versions WHERE company_id=$1 AND kind=$2 ORDER BY version DESC",
    [companyId, kind],
  );
  return result.rows.map((row) => support.mapSnapshotConfigVersionRow(row));
}

export async function createSnapshotConfigVersion(
  pool: Pool,
  input: CreateSnapshotConfigVersionInput,
): Promise<SnapshotConfigVersionRecord> {
  const existing = await findSnapshotConfigVersionByHash(pool, input.companyId, input.kind, input.contentHash);
  if (existing) return existing;

  const head = await pool.query<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM code_snapshot_config_versions
      WHERE company_id=$1 AND kind=$2`,
    [input.companyId, input.kind],
  );
  const record: SnapshotConfigVersionRecord = {
    id: input.id ?? `scv_${randomUUID()}`,
    workspaceId: input.workspaceId,
    companyId: input.companyId,
    kind: input.kind,
    version: head.rows[0]?.next ?? 1,
    contentHash: input.contentHash,
    content: input.content,
    createdAt: input.now ?? new Date(),
    createdBy: input.createdBy,
  };
  await pool.query(
    `INSERT INTO code_snapshot_config_versions(id, workspace_id, company_id, kind, version, content_hash,
       content, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [
      record.id,
      record.workspaceId,
      record.companyId,
      record.kind,
      record.version,
      record.contentHash,
      JSON.stringify(record.content),
      record.createdAt,
      record.createdBy,
    ],
  );
  return record;
}

export async function getReplayBundle(
  pool: Pool,
  companyId: string,
  runId: string,
  bundleVersion?: number,
): Promise<ReplayBundleRecord | null> {
  const result = await pool.query(
    `SELECT ${replayBundleColumns} FROM code_replay_bundles
      WHERE company_id=$1 AND run_id=$2 AND ($3::integer IS NULL OR bundle_version=$3)
      ORDER BY bundle_version DESC LIMIT 1`,
    [companyId, runId, bundleVersion ?? null],
  );
  const row = result.rows[0];
  return row ? support.mapReplayBundleRow(row) : null;
}

export async function getReplayBundleById(
  pool: Pool,
  companyId: string,
  bundleId: string,
): Promise<ReplayBundleRecord | null> {
  const result = await pool.query(
    `SELECT ${replayBundleColumns} FROM code_replay_bundles WHERE company_id=$1 AND id=$2 LIMIT 1`,
    [companyId, bundleId],
  );
  const row = result.rows[0];
  return row ? support.mapReplayBundleRow(row) : null;
}

export async function listReplayBundles(
  pool: Pool,
  input: ListReplayBundlesInput,
): Promise<ReplayBundleRecord[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const result = await pool.query(
    `SELECT ${replayBundleColumns} FROM code_replay_bundles
      WHERE company_id=$1
        AND ($2::text IS NULL OR run_id=$2)
        AND ($3::text IS NULL OR session_id=$3)
        AND ($4::text IS NULL OR execution_snapshot_id=$4)
      ORDER BY created_at DESC, id DESC LIMIT $5`,
    [input.companyId, input.runId ?? null, input.sessionId ?? null, input.executionSnapshotId ?? null, limit],
  );
  return result.rows.map((row) => support.mapReplayBundleRow(row));
}

export async function listReplayBundleSteps(
  pool: Pool,
  companyId: string,
  bundleId: string,
): Promise<ReplayBundleStepRecord[]> {
  const result = await pool.query(
    `SELECT ${replayBundleStepColumns} FROM code_replay_bundle_steps
      WHERE company_id=$1 AND bundle_id=$2 ORDER BY seq ASC`,
    [companyId, bundleId],
  );
  return result.rows.map((row) => support.mapReplayBundleStepRow(row));
}

export async function createReplayBundle(
  pool: Pool,
  input: CreateReplayBundleInput,
): Promise<ReplayBundleRecord> {
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO code_replay_bundles
        (id, workspace_id, company_id, project_id, session_id, run_id, execution_snapshot_id, bundle_version,
         runner_version, system_prompt_version, system_prompt_content_hash, model_profile_version, provider,
         model, replay_mode, source_run_id, source_snapshot_id, terminal_status, terminal_reason, payload,
         payload_hash, replay_input_hash, data_classification, retention_class, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (run_id, bundle_version) DO NOTHING
       RETURNING ${replayBundleColumns}`,
      [
        input.id ?? randomUUID(),
        input.workspaceId,
        input.companyId,
        input.projectId,
        input.sessionId,
        input.runId,
        input.executionSnapshotId ?? null,
        input.bundleVersion,
        input.runnerVersion ?? null,
        input.systemPromptVersion ?? null,
        input.systemPromptContentHash ?? null,
        input.modelProfileVersion ?? null,
        input.provider ?? null,
        input.model ?? null,
        input.replayMode,
        input.sourceRunId ?? null,
        input.sourceSnapshotId ?? null,
        input.terminalStatus ?? null,
        input.terminalReason ?? null,
        JSON.stringify(input.payload),
        input.payloadHash,
        input.replayInputHash,
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
        input.retentionClass ?? DEFAULT_RETENTION_CLASS,
        now,
      ],
    );
    if (!inserted.rowCount) {
      await client.query("COMMIT");
      const existing = await getReplayBundle(pool, input.companyId, input.runId, input.bundleVersion);
      if (existing) return existing;
      throw new WorkspaceAccessError("Replay bundle conflict");
    }
    const bundle = support.mapReplayBundleRow(inserted.rows[0]!);
    let seq = 0;
    for (const step of input.steps) {
      seq += 1;
      await client.query(
        `INSERT INTO code_replay_bundle_steps
          (id, bundle_id, company_id, seq, kind, turn_index, tool_call_id, payload, payload_hash, created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING`,
        [
          step.id ?? randomUUID(),
          bundle.id,
          input.companyId,
          seq,
          step.kind,
          step.turnIndex,
          step.toolCallId ?? null,
          JSON.stringify(step.payload),
          step.payloadHash,
          step.createdAt ?? now,
        ],
      );
    }
    await client.query("COMMIT");
    return bundle;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
