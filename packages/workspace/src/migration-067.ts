import type { PoolClient } from "pg";

/**
 * C1a: feature flags, staged rollout and versioning.
 *
 * Additive only (expand): a previous application version keeps working with the new schema, so a
 * rollback is a flag change rather than a schema change.
 *
 * - `feature_flags` stores one row per (scope, scope_id, flag_key). Resolution order is
 *   user -> company -> global, so a company can be enabled without touching anyone else.
 * - `feature_flag_history` records every change (append-only in practice; the API never updates or
 *   deletes history rows) so "who turned it on, when, from which value" is answerable without the
 *   audit journal (which additionally records the privileged action itself).
 * - `code_sessions` gains the `suspended_by_flag` status used by the kill switch.
 * - `company_agent_tool_audit` gains `tool_version` and `schema_version` so C2+ tools can persist
 *   the exact schema version a call was made with (rule 13).
 * - `code_tool_manifest` records published tool-schema manifests so an old session can be read with
 *   the manifest it was created with (rule 12).
 */
export async function runMigration067(client: PoolClient) {
  await client.query([
    "CREATE TABLE IF NOT EXISTS feature_flags (",
    "  id text PRIMARY KEY,",
    "  workspace_id text NOT NULL,",
    "  scope text NOT NULL CHECK (scope IN ('global','company','user')),",
    "  scope_id text NOT NULL DEFAULT '',",
    "  flag_key text NOT NULL,",
    "  stage text NOT NULL DEFAULT 'off' CHECK (stage IN ('off','internal','allowlist','percent','ga')),",
    "  enabled boolean NOT NULL DEFAULT false,",
    "  rollout_percent integer NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),",
    "  allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,",
    "  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),",
    "  updated_by text NOT NULL,",
    "  updated_at timestamptz NOT NULL DEFAULT now(),",
    "  CONSTRAINT feature_flags_scope_key UNIQUE (workspace_id, scope, scope_id, flag_key)",
    ");",
    "CREATE INDEX IF NOT EXISTS feature_flags_lookup_idx ON feature_flags(workspace_id, flag_key, scope);",

    "CREATE TABLE IF NOT EXISTS feature_flag_history (",
    "  id text PRIMARY KEY,",
    "  workspace_id text NOT NULL,",
    "  flag_key text NOT NULL,",
    "  scope text NOT NULL,",
    "  scope_id text NOT NULL DEFAULT '',",
    "  previous_value jsonb,",
    "  next_value jsonb,",
    "  actor text NOT NULL,",
    "  created_at timestamptz NOT NULL DEFAULT now()",
    ");",
    "CREATE INDEX IF NOT EXISTS feature_flag_history_idx ON feature_flag_history(workspace_id, flag_key, created_at DESC);",

    "ALTER TABLE code_sessions DROP CONSTRAINT IF EXISTS code_sessions_status_check;",
    "ALTER TABLE code_sessions ADD CONSTRAINT code_sessions_status_check CHECK (status IN ('active','paused','awaiting_approval','completed','failed','cancelled','archived','suspended_by_flag'));",

    "ALTER TABLE company_agent_tool_audit ADD COLUMN IF NOT EXISTS tool_version integer;",
    "ALTER TABLE company_agent_tool_audit ADD COLUMN IF NOT EXISTS schema_version integer;",

    "CREATE TABLE IF NOT EXISTS code_tool_manifest (",
    "  version integer PRIMARY KEY,",
    "  tools jsonb NOT NULL DEFAULT '[]'::jsonb,",
    "  checksum text NOT NULL,",
    "  created_at timestamptz NOT NULL DEFAULT now()",
    ");",
  ].join("\n"));
}
