import type { PoolClient } from "pg";

/**
 * Migration 078 — versioned replay bundles (C6b, additive).
 *
 * A snapshot explains a run; it does not reproduce it. Deterministic replay needs the exact recorded
 * exchange: the provider answer of every model step and the **canonical, model-visible, settled** tool result
 * that was fed back to the model. This migration stores those recordings.
 *
 * Two tables, because a run records incrementally:
 *
 *   - `code_replay_bundles` is the header, one row per (run, bundle_version): the environment the run
 *     executed in (snapshot id, runner version, system prompt version + content hash, model profile version,
 *     provider/model), the replay mode, the terminal status/reason and a summary payload with the counts and
 *     the replay-input hash. `bundle_version` versions the *format*, not the run: a persisted JSON format
 *     whose shape changes without a version bump is unreadable evidence (rule 13).
 *   - `code_replay_bundle_steps` holds the ordered steps. They are a separate table rather than one growing
 *     `jsonb` blob on purpose: the runner appends per model step and per tool call, and read-modify-writing a
 *     blob on every step would be a lost-update race. `seq` is monotonic per bundle and steps are read in
 *     `(bundle_id, seq)` order, so the recorded order *is* the executed order.
 *
 * Both tables are append-only: `code_replay_bundles` has no update or delete surface at all, and DB triggers
 * reject `UPDATE`/`DELETE` outright (the pattern already used for `execution_snapshots` in 076 and
 * `audit_log` in 066). A replay bundle is evidence about what the model actually saw — a row that can be
 * rewritten afterwards proves nothing. Unlike 076 there is no hash *chain*: integrity is checked per row
 * through `payload_hash`, and the replay-input hash lives on the header.
 *
 * `raw_artifact` is deliberately **not** stored here. The owner's decision: replay reproduces the
 * model-visible settled result, raw untruncated output is not required and must not influence replay input.
 * A bundle step may carry an optional `{ hash, ref? }` for debugging inside its payload, and the application
 * excludes it from the replay-input hash (see `code-replay-bundle.ts`).
 *
 * Additive: no existing table, column, index or query is touched.
 */
export async function runMigration078(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_replay_bundles (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      company_id text NOT NULL,
      project_id text NOT NULL,
      session_id text NOT NULL,
      run_id text NOT NULL,
      execution_snapshot_id text,
      bundle_version integer NOT NULL,
      runner_version text,
      system_prompt_version integer,
      system_prompt_content_hash text,
      model_profile_version integer,
      provider text,
      model text,
      replay_mode text NOT NULL DEFAULT 'recorded'
        CHECK (replay_mode IN ('recorded', 'live_best_effort')),
      source_run_id text,
      source_snapshot_id text,
      terminal_status text,
      terminal_reason text,
      payload jsonb NOT NULL,
      payload_hash text NOT NULL,
      replay_input_hash text NOT NULL,
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public', 'internal', 'confidential', 'restricted')),
      retention_class text NOT NULL DEFAULT 'standard'
        CHECK (retention_class IN ('ephemeral', 'short', 'standard', 'extended', 'until_deleted')),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS code_replay_bundles_run_version_idx
      ON code_replay_bundles (run_id, bundle_version)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_replay_bundles_company_created_idx
      ON code_replay_bundles (company_id, created_at DESC, id DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_replay_bundles_snapshot_idx
      ON code_replay_bundles (execution_snapshot_id)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_replay_bundle_steps (
      id text PRIMARY KEY,
      bundle_id text NOT NULL REFERENCES code_replay_bundles(id) ON DELETE RESTRICT,
      company_id text NOT NULL,
      seq integer NOT NULL,
      kind text NOT NULL CHECK (kind IN ('model_step', 'tool_call')),
      turn_index integer NOT NULL,
      tool_call_id text,
      payload jsonb NOT NULL,
      payload_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // The recorded order is the executed order, so `seq` is unique per bundle and reads are ordered by it.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS code_replay_bundle_steps_bundle_seq_idx
      ON code_replay_bundle_steps (bundle_id, seq)
  `);
  // Idempotency: re-recording the same call of the same turn must not append a second step.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS code_replay_bundle_steps_identity_idx
      ON code_replay_bundle_steps (bundle_id, kind, turn_index, COALESCE(tool_call_id, ''))
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_replay_bundle_steps_company_idx
      ON code_replay_bundle_steps (company_id, bundle_id, seq)
  `);
  // Append-only enforcement, mirroring migration 076 / 066: triggers reject UPDATE and DELETE for every role,
  // and the grants are withdrawn as a second line of defence.
  await client.query(`
    CREATE OR REPLACE FUNCTION npati_replay_bundles_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'code_replay_bundles is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS npati_replay_bundles_append_only_trigger ON code_replay_bundles
  `);
  await client.query(`
    CREATE TRIGGER npati_replay_bundles_append_only_trigger
      BEFORE UPDATE OR DELETE ON code_replay_bundles
      FOR EACH ROW EXECUTE FUNCTION npati_replay_bundles_append_only()
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS npati_replay_bundle_steps_append_only_trigger ON code_replay_bundle_steps
  `);
  await client.query(`
    CREATE TRIGGER npati_replay_bundle_steps_append_only_trigger
      BEFORE UPDATE OR DELETE ON code_replay_bundle_steps
      FOR EACH ROW EXECUTE FUNCTION npati_replay_bundles_append_only()
  `);
  await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON code_replay_bundles FROM PUBLIC`);
  await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON code_replay_bundle_steps FROM PUBLIC`);
}
