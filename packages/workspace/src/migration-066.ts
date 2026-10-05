import type { PoolClient } from "pg";

/**
 * C1c: tamper-evident AuditLog.
 *
 * Separate from Activity (which traces runs) and from `company_audit_logs` (an ordinary table with
 * no immutability guarantees): this is the append-only journal for privileged decisions.
 *
 * Guarantees created here:
 * - `audit_log` accepts INSERT and SELECT only. A trigger raises on UPDATE/DELETE, which also covers
 *   the table owner (REVOKE alone would not), and UPDATE/DELETE are revoked from PUBLIC.
 * - A second trigger enforces the hash chain on INSERT: the first entry of a company must have a
 *   NULL `prev_hash` and sequence 1, every later entry must continue the previous `entry_hash` with
 *   the next sequence. A rogue INSERT that would fork or reorder the chain is rejected by the DB.
 * - `audit_anchors` stores the daily head hash; the signed copy lives outside the database
 *   (see `AuditLogService`), so a whole-table rewrite is still detectable.
 *
 * All statements are additive (new tables only), so a previous application version keeps working.
 */
export async function runMigration066(client: PoolClient) {
  await client.query([
    "CREATE TABLE IF NOT EXISTS audit_log (",
    "  id text PRIMARY KEY,",
    "  workspace_id text NOT NULL,",
    "  company_id text NOT NULL,",
    "  sequence bigint NOT NULL CHECK (sequence > 0),",
    "  created_at timestamptz NOT NULL DEFAULT now(),",
    "  actor text NOT NULL,",
    "  actor_role text NOT NULL,",
    "  request_id text,",
    "  correlation_id text,",
    "  snapshot_id text,",
    "  action text NOT NULL,",
    "  resource_type text NOT NULL,",
    "  resource_id text,",
    "  project_id text,",
    "  decision text NOT NULL CHECK (decision IN ('allowed','denied','approved','rejected')),",
    "  payload_hash text NOT NULL,",
    "  prev_hash text,",
    "  entry_hash text NOT NULL,",
    "  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,",
    "  CONSTRAINT audit_log_company_sequence_key UNIQUE (company_id, sequence)",
    ");",
    "CREATE INDEX IF NOT EXISTS audit_log_company_time_idx ON audit_log(company_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(company_id, actor, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS audit_log_correlation_idx ON audit_log(correlation_id);",
    "CREATE INDEX IF NOT EXISTS audit_log_request_idx ON audit_log(request_id);",
    "CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(company_id, action, created_at DESC);",

    "CREATE OR REPLACE FUNCTION npati_audit_log_append_only() RETURNS trigger AS $$",
    "BEGIN",
    "  RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP USING ERRCODE = 'insufficient_privilege';",
    "END; $$ LANGUAGE plpgsql;",
    "DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;",
    "CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log",
    "  FOR EACH ROW EXECUTE FUNCTION npati_audit_log_append_only();",

    "CREATE OR REPLACE FUNCTION npati_audit_log_chain_guard() RETURNS trigger AS $$",
    "DECLARE",
    "  head_hash text;",
    "  head_sequence bigint;",
    "BEGIN",
    "  SELECT entry_hash, sequence INTO head_hash, head_sequence FROM audit_log",
    "    WHERE company_id = NEW.company_id ORDER BY sequence DESC LIMIT 1;",
    "  IF head_sequence IS NULL THEN",
    "    IF NEW.sequence <> 1 OR NEW.prev_hash IS NOT NULL THEN",
    "      RAISE EXCEPTION 'audit_log chain violation: first entry of a company must be sequence 1 with no prev_hash';",
    "    END IF;",
    "  ELSE",
    "    IF NEW.sequence <> head_sequence + 1 THEN",
    "      RAISE EXCEPTION 'audit_log chain violation: expected sequence %, got %', head_sequence + 1, NEW.sequence;",
    "    END IF;",
    "    IF NEW.prev_hash IS DISTINCT FROM head_hash THEN",
    "      RAISE EXCEPTION 'audit_log chain violation: prev_hash does not match the current head';",
    "    END IF;",
    "  END IF;",
    "  RETURN NEW;",
    "END; $$ LANGUAGE plpgsql;",
    "DROP TRIGGER IF EXISTS audit_log_chain_guard ON audit_log;",
    "CREATE TRIGGER audit_log_chain_guard BEFORE INSERT ON audit_log",
    "  FOR EACH ROW EXECUTE FUNCTION npati_audit_log_chain_guard();",

    "REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;",

    "CREATE TABLE IF NOT EXISTS audit_anchors (",
    "  id text PRIMARY KEY,",
    "  workspace_id text NOT NULL,",
    "  company_id text NOT NULL,",
    "  day date NOT NULL,",
    "  sequence bigint NOT NULL,",
    "  entry_count bigint NOT NULL,",
    "  head_hash text NOT NULL,",
    "  anchor_path text,",
    "  signature text,",
    "  created_at timestamptz NOT NULL DEFAULT now(),",
    "  CONSTRAINT audit_anchors_company_day_key UNIQUE (company_id, day)",
    ");",
    "CREATE INDEX IF NOT EXISTS audit_anchors_company_idx ON audit_anchors(company_id, day DESC);",
  ].join("\n"));
}
