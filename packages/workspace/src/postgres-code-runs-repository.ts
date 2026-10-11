/* The code-runs domain of the Postgres workspace store, split out in an architectural step of
 * docs/refactoring/PLAN.md.
 *
 * The method bodies are the previous ones with mechanical rewrites only: `this.pool` became the `pool`
 * argument, calls to sibling methods in the same domain pass that pool on, and the shared ownership checks
 * come from postgres-lookups.ts. The facade keeps every public method as a thin delegation.
 */
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { DataClassification, RetentionClass, CodeRunStateRecord, CodeRunTurnRecord, CreateCodeRunStateInput, ApplyCodeRunStateEventInput, CodeRunStateScanInput, CodeRunTurnScanInput, CodeRunScanPage, ListCodeRunStatesInput, CodeRunRequestRecord, CodeActivityEventRecord, CreateCodeActivityEventInput, ListCodeActivityEventsInput, CodeContextSummaryRecord, CreateCodeContextSummaryInput, ListCodeContextSummariesInput } from "./types";
import { DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS, clampScanLimit, decodeCodeRunScanCursor, encodeCodeRunScanCursor, decodeCodeActivityCursor, codeRunRequestStatus } from "./types";
import { CodeRunStateStoreError } from "./types";
import { codeActivityEventColumns, codeContextSummaryColumns, codeRunStateColumns, codeRunTurnColumns } from "./postgres-store-schema";
import { mapCodeActivityEventRow, mapCodeContextSummaryRow } from "./postgres-row-mappers";

export async function createCodeRunState(pool: Pool, input: CreateCodeRunStateInput): Promise<CodeRunStateRecord> {
    const expiresAt = new Date(input.now.getTime() + input.leaseMs);
    const request = input.request ?? { status: "not_recorded" as const, text: null, sha256: null, truncated: false, recordedAt: null };
    await pool.query(
      `INSERT INTO code_run_states(
         run_id, workspace_id, company_id, project_id, session_id, status, turn_index, last_event_seq,
         lease_owner, lease_expires_at, heartbeat_at, started_at, updated_at, details,
         request_status, request_text, request_sha256, request_truncated, request_recorded_at,
         data_classification, retention_class)
       VALUES ($1,$2,$3,$4,$5,'running',0,1,$6,$7,$8,$8,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        input.runId, input.workspaceId, input.companyId, input.projectId, input.sessionId,
        input.owner, expiresAt, input.now, JSON.stringify(input.details ?? {}),
        request.status, request.text, request.sha256, request.truncated, request.recordedAt,
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
        input.retentionClass ?? DEFAULT_RETENTION_CLASS,
      ],
    );
    const stored = await getCodeRunState(pool, input.companyId, input.runId);
    if (!stored) {
      throw new CodeRunStateStoreError("code_run_state_not_found", "The run state could not be created", {
        httpStatus: 404, details: { runId: input.runId },
      });
    }
    return stored;
  }

export async function getCodeRunRequest(pool: Pool, companyId: string, runId: string): Promise<CodeRunRequestRecord | null> {
    const result = await pool.query<{
      request_status: string; request_text: string | null; request_sha256: string | null;
      request_truncated: boolean; request_recorded_at: Date | null;
      data_classification: string; retention_class: string;
    }>(
      `SELECT request_status, request_text, request_sha256, request_truncated, request_recorded_at,
              data_classification, retention_class
         FROM code_run_states WHERE company_id=$1 AND run_id=$2`,
      [companyId, runId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      runId,
      companyId,
      status: codeRunRequestStatus(row.request_status),
      text: row.request_text,
      sha256: row.request_sha256,
      truncated: row.request_truncated === true,
      recordedAt: row.request_recorded_at ? new Date(row.request_recorded_at) : null,
      dataClassification: row.data_classification as DataClassification,
      retentionClass: row.retention_class as RetentionClass,
    };
  }

export async function applyCodeRunStateEvent(pool: Pool, input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord> {
    const leasePredicate = (() => {
      if (!input.lease) return "TRUE";
      if (input.lease.mode === "acquire") {
        return "(lease_owner IS NULL OR lease_owner=$7 OR lease_expires_at IS NULL OR lease_expires_at < $6)";
      }
      if (input.lease.mode === "renew") return "lease_owner=$7";
      return "lease_owner=$7";
    })();
    const leaseExpiresAt = input.lease
      ? (input.lease.mode === "release" ? null : new Date(input.lease.now.getTime() + (input.lease.leaseMs ?? 0)))
      : undefined;
    const result = await pool.query<CodeRunStateRecord>(
      `UPDATE code_run_states SET
         status = COALESCE($4, status),
         turn_index = COALESCE($5, turn_index),
         heartbeat_at = COALESCE($8, heartbeat_at),
         finished_at = CASE WHEN $9::boolean THEN $10 ELSE finished_at END,
         details = COALESCE($11::jsonb, details),
         last_event_seq = $3,
         lease_owner = CASE WHEN $12::boolean AND ${leasePredicate} THEN $7 ELSE lease_owner END,
         lease_expires_at = CASE WHEN $12::boolean AND ${leasePredicate} THEN $13 ELSE lease_expires_at END,
         revision = revision + 1,
         updated_at = $6
       WHERE company_id=$1 AND run_id=$2 AND last_event_seq < $3
       RETURNING ${codeRunStateColumns}`,
      [
        input.companyId, input.runId, input.seq,
        input.status ?? null, input.turnIndex ?? null, input.lease?.now ?? new Date(),
        input.lease?.owner ?? null, input.heartbeatAt ?? null,
        input.finishedAt !== undefined, input.finishedAt ?? null,
        input.details === undefined ? null : JSON.stringify(input.details),
        Boolean(input.lease), leaseExpiresAt ?? null,
      ],
    );
    if (result.rows[0]) return result.rows[0];
    // Either the sequence was already applied (idempotent no-op) or the row is gone/foreign.
    const current = await getCodeRunState(pool, input.companyId, input.runId);
    if (!current) {
      throw new CodeRunStateStoreError("code_run_state_not_found", "No such run state", {
        httpStatus: 404, details: { runId: input.runId },
      });
    }
    return current;
  }

export async function getCodeRunState(pool: Pool, companyId: string, runId: string): Promise<CodeRunStateRecord | null> {
    const result = await pool.query<CodeRunStateRecord>(
      `SELECT ${codeRunStateColumns} FROM code_run_states WHERE company_id=$1 AND run_id=$2`,
      [companyId, runId],
    );
    return result.rows[0] ?? null;
  }

export async function listStaleCodeRunStates(pool: Pool, input: { now: Date; limit: number }): Promise<CodeRunStateRecord[]> {
    const result = await pool.query<CodeRunStateRecord>(
      `SELECT ${codeRunStateColumns} FROM code_run_states
       WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at < $1)
       ORDER BY started_at ASC
       LIMIT $2`,
      [input.now, Math.max(1, input.limit)],
    );
    return result.rows;
  }

export async function listCodeRunStates(pool: Pool, input: ListCodeRunStatesInput): Promise<CodeRunStateRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
    const statuses = input.statuses && input.statuses.length > 0 ? [...input.statuses] : null;
    const result = await pool.query<CodeRunStateRecord>(
      `SELECT ${codeRunStateColumns} FROM code_run_states
        WHERE company_id=$1
          AND ($2::text[] IS NULL OR status = ANY($2::text[]))
          AND ($3::timestamptz IS NULL OR started_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR started_at < $4::timestamptz)
        ORDER BY started_at DESC, run_id ASC
        LIMIT $5`,
      [input.companyId, statuses, input.startedAfter ?? null, input.startedBefore ?? null, limit],
    );
    return result.rows;
  }

export async function getCodeRunTurn(pool: Pool, companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null> {
    const result = await pool.query<CodeRunTurnRecord>(
      `SELECT ${codeRunTurnColumns} FROM code_run_turns
       WHERE company_id=$1 AND run_id=$2 AND turn_index=$3`,
      [companyId, runId, turnIndex],
    );
    return result.rows[0] ?? null;
  }

export async function listCodeRunTurns(pool: Pool, companyId: string, runId: string): Promise<CodeRunTurnRecord[]> {
    const result = await pool.query<CodeRunTurnRecord>(
      `SELECT ${codeRunTurnColumns} FROM code_run_turns
       WHERE company_id=$1 AND run_id=$2 ORDER BY turn_index ASC`,
      [companyId, runId],
    );
    return result.rows;
  }

export async function listCodeRunStatesForScan(pool: Pool, input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const result = await pool.query<CodeRunStateRecord>(
      `SELECT ${codeRunStateColumns} FROM code_run_states
       WHERE ($1::text IS NULL OR company_id=$1)
         AND started_at < $2
         AND status='running'
         AND ($3::timestamptz IS NULL OR (started_at, run_id, 0::integer) > ($3::timestamptz, $4, 0))
       ORDER BY started_at ASC, run_id ASC
       LIMIT $5`,
      [input.companyId, input.startedBefore, cursor?.startedAt ?? null, cursor?.runId ?? "", limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows,
      nextCursor: result.rows.length > limit && last
        ? encodeCodeRunScanCursor({ startedAt: last.startedAt.toISOString(), runId: last.runId, turnIndex: 0 })
        : null,
    };
  }

export async function listCodeRunTurnsForScan(pool: Pool, input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const statuses = [...(input.statuses ?? ["running"])];
    const result = await pool.query<CodeRunTurnRecord>(
      `SELECT ${codeRunTurnColumns} FROM code_run_turns
       WHERE ($1::text IS NULL OR company_id=$1)
         AND started_at < $2
         AND status = ANY($3::text[])
         AND ($4::timestamptz IS NULL OR (started_at, run_id, turn_index) > ($4::timestamptz, $5, $6))
       ORDER BY started_at ASC, run_id ASC, turn_index ASC
       LIMIT $7`,
      [
        input.companyId, input.startedBefore, statuses,
        cursor?.startedAt ?? null, cursor?.runId ?? "", cursor?.turnIndex ?? 0, limit + 1,
      ],
    );
    const rows = result.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows,
      nextCursor: result.rows.length > limit && last
        ? encodeCodeRunScanCursor({
          startedAt: last.startedAt.toISOString(), runId: last.runId, turnIndex: last.turnIndex,
        })
        : null,
    };
  }

export async function createCodeActivityEvent(pool: Pool, input: CreateCodeActivityEventInput): Promise<CodeActivityEventRecord> {
    const result = await pool.query(
      `INSERT INTO code_activity_events
        (id, workspace_id, company_id, project_id, session_id, run_id, snapshot_id,
         parent_run_id, parent_tool_call_id, parent_event_id, kind, payload,
         data_classification, retention_class, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING ${codeActivityEventColumns}`,
      [input.id ?? randomUUID(), input.workspaceId, input.companyId, input.projectId ?? null,
        input.sessionId ?? null, input.runId ?? null, input.snapshotId ?? null,
        input.parentRunId ?? null, input.parentToolCallId ?? null, input.parentEventId ?? null,
        input.kind,
        JSON.stringify(input.payload),
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
        input.retentionClass ?? DEFAULT_RETENTION_CLASS,
        input.now ?? new Date()],
    );
    return mapCodeActivityEventRow(result.rows[0]!);
  }

export async function listCodeActivityEvents(pool: Pool, input: ListCodeActivityEventsInput): Promise<CodeActivityEventRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
    const result = await pool.query(
      `SELECT ${codeActivityEventColumns} FROM code_activity_events
        WHERE company_id=$1
          AND ($2::text IS NULL OR session_id=$2)
          AND ($3::text IS NULL OR run_id=$3)
          AND ($4::text IS NULL OR snapshot_id=$4)
          AND ($5::text IS NULL OR parent_run_id=$5)
          AND ($6::timestamptz IS NULL OR (created_at, id) < ($6::timestamptz, $7::text))
        ORDER BY created_at DESC, id DESC LIMIT $8`,
      [input.companyId, input.sessionId ?? null, input.runId ?? null, input.snapshotId ?? null,
        input.parentRunId ?? null,
        input.cursor ? new Date(decodeCodeActivityCursor(input.cursor).createdAt) : null,
        input.cursor ? decodeCodeActivityCursor(input.cursor).id : null, limit],
    );
    return result.rows.map((row) => mapCodeActivityEventRow(row));
  }

export async function createCodeContextSummary(pool: Pool, input: CreateCodeContextSummaryInput): Promise<CodeContextSummaryRecord> {
    const result = await pool.query(
      `INSERT INTO code_context_summaries
        (id, company_id, project_id, session_id, run_id, snapshot_id, turn_index, schema_version, summary,
         summary_text, content_hash, data_classification, retention_class, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${codeContextSummaryColumns}`,
      [input.id ?? randomUUID(), input.companyId, input.projectId, input.sessionId ?? null,
        input.runId ?? null, input.snapshotId ?? null, input.turnIndex ?? 0, input.schemaVersion,
        JSON.stringify(input.summary), input.summaryText, input.contentHash,
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
        input.retentionClass ?? "short",
        input.now ?? new Date()],
    );
    return mapCodeContextSummaryRow(result.rows[0]!);
  }

export async function listCodeContextSummaries(pool: Pool, input: ListCodeContextSummariesInput): Promise<CodeContextSummaryRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const result = await pool.query(
      `SELECT ${codeContextSummaryColumns} FROM code_context_summaries
        WHERE company_id=$1
          AND ($2::text IS NULL OR session_id=$2)
          AND ($3::text IS NULL OR run_id=$3)
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [input.companyId, input.sessionId ?? null, input.runId ?? null, limit],
    );
    return result.rows.map((row) => mapCodeContextSummaryRow(row));
  }
