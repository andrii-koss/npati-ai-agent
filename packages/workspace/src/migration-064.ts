import type { PoolClient } from "pg";

/**
 * D7: dev/prod promotion, backups, quotas and external databases.
 *
 * - Snapshot metadata grows a kind (manual / scheduled / pre_migration / pre_promote /
 *   pre_restore), a reason, a size and the author, so backups can be listed, pruned by
 *   retention and audited.
 * - Environments carry per-environment limits (quotas) and a backup policy.
 * - `data_backend_promotions` records promote previews and applications (diff, flags,
 *   snapshot, approver) so a promote is reviewable and never implicit.
 * - DataBackend removal becomes two-phase: `remove_after` marks the retention deadline
 *   before databases, roles, keys and secrets are purged.
 * - External databases keep their owner credentials in Core secret storage.
 */
export async function runMigration064(client: PoolClient) {
  await client.query([
    "ALTER TABLE data_backend_snapshots ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'manual';",
    "ALTER TABLE data_backend_snapshots DROP CONSTRAINT IF EXISTS data_backend_snapshots_kind_check;",
    "ALTER TABLE data_backend_snapshots ADD CONSTRAINT data_backend_snapshots_kind_check CHECK (kind IN ('manual','scheduled','pre_migration','pre_promote','pre_restore'));",
    "ALTER TABLE data_backend_snapshots ADD COLUMN IF NOT EXISTS reason text;",
    "ALTER TABLE data_backend_snapshots ADD COLUMN IF NOT EXISTS size_bytes bigint;",
    "ALTER TABLE data_backend_snapshots ADD COLUMN IF NOT EXISTS created_by text;",
    "CREATE INDEX IF NOT EXISTS data_backend_snapshots_lookup_idx ON data_backend_snapshots(backend_id, environment, created_at DESC);",
    "ALTER TABLE data_backend_environments ADD COLUMN IF NOT EXISTS limits jsonb NOT NULL DEFAULT '{}'::jsonb;",
    "ALTER TABLE data_backend_environments ADD COLUMN IF NOT EXISTS backup_policy jsonb NOT NULL DEFAULT '{}'::jsonb;",
    "ALTER TABLE data_backends ADD COLUMN IF NOT EXISTS remove_after timestamptz;",
    "ALTER TABLE data_backend_secrets DROP CONSTRAINT IF EXISTS data_backend_secrets_role_check;",
    "ALTER TABLE data_backend_secrets ADD CONSTRAINT data_backend_secrets_role_check CHECK (role IN ('migrator','runtime','signing','external_admin','external_owner'));",
    "CREATE TABLE IF NOT EXISTS data_backend_promotions (",
    "  id text PRIMARY KEY,",
    "  workspace_id text NOT NULL,",
    "  company_id text NOT NULL,",
    "  backend_id text NOT NULL,",
    "  target_environment text NOT NULL CHECK(target_environment IN ('dev','prod')),",
    "  status text NOT NULL CHECK(status IN ('previewed','applied','failed','rejected')),",
    "  diff jsonb NOT NULL DEFAULT '[]'::jsonb,",
    "  flags jsonb NOT NULL DEFAULT '{}'::jsonb,",
    "  snapshot_ref text,",
    "  with_data boolean NOT NULL DEFAULT false,",
    "  approved_by text,",
    "  error text,",
    "  created_at timestamptz NOT NULL DEFAULT now(),",
    "  applied_at timestamptz",
    ");",
    "CREATE INDEX IF NOT EXISTS data_backend_promotions_idx ON data_backend_promotions(backend_id, target_environment, created_at DESC);",
  ].join("\n"));
}
