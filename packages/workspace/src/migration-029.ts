import type { PoolClient } from "pg";

export async function runMigration029(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE company_agent_runs
      ADD COLUMN IF NOT EXISTS total_cost NUMERIC(14,8) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_tokens BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_duration_ms INT NOT NULL DEFAULT 0;

    ALTER TABLE company_agent_tool_audit
      ADD COLUMN IF NOT EXISTS latency_ms INT,
      ADD COLUMN IF NOT EXISTS cost NUMERIC(14,8),
      ADD COLUMN IF NOT EXISTS tokens BIGINT,
      ADD COLUMN IF NOT EXISTS reason_code TEXT,
      ADD COLUMN IF NOT EXISTS sequence_number INT;

    ALTER TABLE company_usage_metrics
      ADD COLUMN IF NOT EXISTS request_id TEXT,
      ADD COLUMN IF NOT EXISTS provider_id TEXT,
      ADD COLUMN IF NOT EXISTS routing_strategy TEXT,
      ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS cached_tokens BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cache_savings_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS failover_count INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cost_source TEXT NOT NULL DEFAULT 'estimated';

    CREATE INDEX IF NOT EXISTS company_usage_request_idx
      ON company_usage_metrics(workspace_id, company_id, request_id)
      WHERE request_id IS NOT NULL;
  `);
}
