import type { PoolClient } from "pg";

export async function runMigration020(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_group_sessions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      title TEXT NOT NULL,
      participants JSONB NOT NULL DEFAULT '[]'::jsonb,
      session_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      active_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_isolated BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_group_sessions_company
    ON company_group_sessions (company_id, tenant_id, created_at DESC);
  `);
}
