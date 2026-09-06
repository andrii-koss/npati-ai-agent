import type { PoolClient } from "pg";

export async function runMigration018(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_audit_logs (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      ip_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_company_audit_lookup
      ON company_audit_logs(workspace_id, company_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS company_usage_metrics (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      agent_id TEXT,
      model_id TEXT NOT NULL,
      prompt_tokens INT NOT NULL DEFAULT 0,
      completion_tokens INT NOT NULL DEFAULT 0,
      cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
      latency_ms INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_company_usage_lookup
      ON company_usage_metrics(workspace_id, company_id, created_at DESC);
  `);
}
