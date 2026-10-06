import type { PoolClient } from "pg";

/**
 * Migration 076 — immutable execution snapshots and configuration versions (C6b, additive).
 *
 * Rule 19 requires every run to have an ExecutionSnapshot, and C6 left the provider as a `NullSnapshotProvider`
 * on purpose. Explaining "why did the agent do that?" needs two things that do not exist yet:
 *
 *   - `execution_snapshots` — what the system looked like at the moment the run started (tool manifest, policy
 *     version, model profile, system prompt hash, flags, provider data policy, image digest, base commit, ...).
 *   - `code_snapshot_config_versions` — the versioned *content* of the two things a snapshot only points at by
 *     hash: the system prompt and the model profiles.
 *
 * Both are **append-only**, with the same reasoning and the same mechanism as `audit_log` in 066: a snapshot
 * that can be edited is not evidence, and a config version that can be rewritten makes every historical
 * snapshot a lie. UPDATE and DELETE are refused by a trigger, and INSERT is checked against the previous entry
 * of the session, so the chain cannot be spliced.
 *
 * Additive: two new tables, their indexes and their triggers. No existing table, row or query is touched.
 */
export async function runMigration076(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS execution_snapshots (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      company_id text NOT NULL,
      project_id text NOT NULL,
      session_id text NOT NULL,
      run_id text,
      snapshot_version integer NOT NULL DEFAULT 1 CHECK (snapshot_version >= 1),
      payload jsonb NOT NULL,
      payload_hash text NOT NULL,
      prev_snapshot_id text,
      prev_payload_hash text,
      trigger text NOT NULL CHECK (trigger IN ('session_start', 'run_start', 'config_change', 'resume', 'recovery')),
      legacy boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL
    );

    CREATE INDEX IF NOT EXISTS execution_snapshots_session_idx
      ON execution_snapshots(company_id, session_id, snapshot_version DESC);
    CREATE INDEX IF NOT EXISTS execution_snapshots_run_idx
      ON execution_snapshots(company_id, run_id);
    CREATE INDEX IF NOT EXISTS execution_snapshots_project_idx
      ON execution_snapshots(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS code_snapshot_config_versions (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      company_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('system_prompt', 'model_profiles')),
      version integer NOT NULL CHECK (version >= 1),
      content_hash text NOT NULL,
      content jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      CONSTRAINT code_snapshot_config_versions_kind_version_key UNIQUE (kind, version),
      CONSTRAINT code_snapshot_config_versions_kind_hash_key UNIQUE (company_id, kind, content_hash)
    );

    CREATE OR REPLACE FUNCTION npati_execution_snapshot_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'execution_snapshots is append-only (attempted %)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS execution_snapshots_append_only ON execution_snapshots;
    CREATE TRIGGER execution_snapshots_append_only BEFORE UPDATE OR DELETE ON execution_snapshots
      FOR EACH ROW EXECUTE FUNCTION npati_execution_snapshot_append_only();

    CREATE OR REPLACE FUNCTION npati_execution_snapshot_chain_guard() RETURNS trigger AS $$
    DECLARE
      head_id text;
      head_hash text;
    BEGIN
      SELECT id, payload_hash INTO head_id, head_hash FROM execution_snapshots
        WHERE company_id = NEW.company_id AND session_id = NEW.session_id
        ORDER BY snapshot_version DESC LIMIT 1;

      IF head_id IS NULL THEN
        IF NEW.prev_snapshot_id IS NOT NULL THEN
          RAISE EXCEPTION 'execution_snapshots chain violation: first snapshot of a session must have no predecessor';
        END IF;
      ELSE
        IF NEW.prev_snapshot_id IS DISTINCT FROM head_id THEN
          RAISE EXCEPTION 'execution_snapshots chain violation: prev_snapshot_id does not match the session head';
        END IF;
        IF NEW.prev_payload_hash IS DISTINCT FROM head_hash THEN
          RAISE EXCEPTION 'execution_snapshots chain violation: prev_payload_hash does not match the session head';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS execution_snapshots_chain_guard ON execution_snapshots;
    CREATE TRIGGER execution_snapshots_chain_guard BEFORE INSERT ON execution_snapshots
      FOR EACH ROW EXECUTE FUNCTION npati_execution_snapshot_chain_guard();

    CREATE OR REPLACE FUNCTION npati_snapshot_config_version_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'code_snapshot_config_versions is append-only (attempted %)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS code_snapshot_config_versions_append_only ON code_snapshot_config_versions;
    CREATE TRIGGER code_snapshot_config_versions_append_only BEFORE UPDATE OR DELETE ON code_snapshot_config_versions
      FOR EACH ROW EXECUTE FUNCTION npati_snapshot_config_version_append_only();

    REVOKE UPDATE, DELETE, TRUNCATE ON execution_snapshots FROM PUBLIC;
    REVOKE UPDATE, DELETE, TRUNCATE ON code_snapshot_config_versions FROM PUBLIC;
  `);
}
