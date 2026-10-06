import type { PoolClient } from "pg";

/**
 * Migration 079 — durable C8 context summaries (additive).
 *
 * C8 compacts a long session into a structured summary (goal, decisions, changed files, executed commands and
 * their results, open problems, next steps). Requirement 5 says the summary is stored as a session artifact,
 * so it needs a home that carries its own data classification and retention class from creation — and its
 * retention is deliberately **shorter** than the transcript: a summary is derived, and once the transcript it
 * was derived from has aged out the summary has no independent audit value.
 *
 * One new table, nothing else:
 *
 *   - `code_context_summaries` is append-only by design: the store exposes create and read methods and no
 *     update or delete at all. A rewritten summary would misrepresent what the model was actually given during
 *     the run it describes. Unlike `audit_log` (C1c) it carries no hash chain: it is derived session
 *     telemetry, not the compliance record.
 *   - `content_hash` is the hash of the exact compacted message list produced by `compactConversation`. That
 *     is what ties a stored summary to reproducible replay input (C6b): the same run must produce the same
 *     hash, so a divergence is visible instead of silent.
 *   - `snapshot_id` is nullable for the same reason as in `audit_log` and `code_activity_events`: a summary
 *     produced without an execution snapshot must be storable as "no snapshot" rather than with a fabricated
 *     identifier. `company_id` is NOT NULL so every row is tenant-scoped.
 *   - `data_classification` and `retention_class` are NOT NULL with conservative defaults, mirroring
 *     `DEFAULT_DATA_CLASSIFICATION` ("confidential") and a deliberately shorter retention class than the
 *     transcript; the CHECK vocabulary matches `types.ts`, so a direct SQL write cannot invent a class.
 *   - the summary body is metadata-plus-text only: the application rejects a summary that contains what looks
 *     like a secret before inserting (`assertNoSecretsInSummary`). The database cannot check that, and
 *     pretending otherwise would be worse than saying so.
 */
export async function runMigration079(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_context_summaries (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      project_id text NOT NULL,
      session_id text,
      run_id text,
      snapshot_id text,
      turn_index integer NOT NULL DEFAULT 0,
      schema_version integer NOT NULL,
      summary jsonb NOT NULL,
      summary_text text NOT NULL,
      content_hash text NOT NULL,
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public','internal','confidential','restricted')),
      retention_class text NOT NULL DEFAULT 'short'
        CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted')),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS code_context_summaries_company_created_idx
      ON code_context_summaries (company_id, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_context_summaries_session_idx
      ON code_context_summaries (company_id, session_id, turn_index)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_context_summaries_run_idx
      ON code_context_summaries (company_id, run_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_context_summaries_snapshot_idx
      ON code_context_summaries (company_id, snapshot_id)
  `);

  // Append-only at the database level, repeating the `audit_log` (066) / `execution_snapshots` (076) pattern:
  // a row that can be rewritten after the run cannot prove what the model was shown during it.
  await client.query(`
    CREATE OR REPLACE FUNCTION npati_code_context_summaries_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'code_context_summaries is append-only'
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS npati_code_context_summaries_no_update ON code_context_summaries
  `);
  await client.query(`
    CREATE TRIGGER npati_code_context_summaries_no_update
      BEFORE UPDATE OR DELETE ON code_context_summaries
      FOR EACH ROW EXECUTE FUNCTION npati_code_context_summaries_append_only()
  `);
  await client.query(`
    REVOKE UPDATE, DELETE, TRUNCATE ON code_context_summaries FROM PUBLIC
  `);
}
