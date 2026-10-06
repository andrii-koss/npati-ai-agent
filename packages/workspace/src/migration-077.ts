import type { PoolClient } from "pg";

/**
 * Migration 077 — durable Coding Agent Activity events with their `snapshot_id` (C6b, additive).
 *
 * C4–C6 emitted Activity events (tool calls, policy decisions, network decisions, run life cycle and
 * reconciliation) through structured logs only. A log line is not evidence: it is rotated, sampled and gone
 * after a restart, and requirement 19 says every Activity event must reference the ExecutionSnapshot of the
 * run it belongs to. This migration adds the table those events are written to, together with the snapshot
 * reference and the data classification / retention class every stored entity must carry from creation.
 *
 * One new table, nothing else:
 *
 *   - `code_activity_events` is append-only by design: the store exposes `create` and read methods and no
 *     update or delete at all. Unlike `audit_log` (C1c) it does not need a hash chain, because it is derived
 *     telemetry rather than the compliance record — the audit journal already covers that, and duplicating a
 *     second chain would add cost without adding assurance.
 *   - `snapshot_id` is nullable on purpose. `audit_log.snapshot_id` is nullable for the same reason: events
 *     produced before C6b, or by a path that has no snapshot (for example a privileged action taken outside
 *     any run), must be storable as "no snapshot" instead of forcing a fabricated identifier.
 *   - `run_id` is nullable for the same reason; `company_id` is not, so every row is tenant-scoped and a
 *     query can never accidentally cross tenants.
 *   - `data_classification` and `retention_class` are `NOT NULL` with conservative defaults, so a row cannot
 *     be created without them (requirement 18). The defaults mirror `DEFAULT_DATA_CLASSIFICATION`,
 *     `DEFAULT_RETENTION_CLASS` in `types.ts`; the CHECK vocabulary matches theirs, so a direct SQL write
 *     cannot invent a class.
 *   - `payload` carries metadata only. The application asserts that before inserting (see
 *     `code-run-activity-sink.ts`); the database cannot check that, and pretending otherwise would be worse
 *     than saying so.
 *
 * Additive: no existing table, column, index or query is touched.
 */
export async function runMigration077(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_activity_events (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      company_id text NOT NULL,
      project_id text,
      session_id text,
      run_id text,
      snapshot_id text,
      kind text NOT NULL CHECK (kind IN (
        'code_tool_activity', 'policy_decision', 'network_decision', 'run_activity', 'run_reconcile'
      )),
      payload jsonb NOT NULL,
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public', 'internal', 'confidential', 'restricted')),
      retention_class text NOT NULL DEFAULT 'standard'
        CHECK (retention_class IN ('ephemeral', 'short', 'standard', 'extended', 'until_deleted')),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Read paths: newest events of a session/company, all events of a run, and every event of a snapshot
  // ("why did the agent do this").
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_activity_events_company_created_idx
      ON code_activity_events (company_id, created_at DESC, id DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_activity_events_session_created_idx
      ON code_activity_events (session_id, created_at DESC, id DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_activity_events_run_idx ON code_activity_events (run_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_activity_events_snapshot_idx ON code_activity_events (snapshot_id)
  `);
}
