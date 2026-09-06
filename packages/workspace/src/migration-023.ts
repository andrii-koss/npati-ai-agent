import type { PoolClient } from "pg";

export async function runMigration023(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_scoped_memories (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      api_key_id TEXT,
      session_id TEXT,
      scope_type TEXT NOT NULL DEFAULT 'company',
      category TEXT NOT NULL DEFAULT 'fact',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_scoped_memories_lookup
    ON company_scoped_memories (company_id, tenant_id, scope_type);

    CREATE INDEX IF NOT EXISTS idx_scoped_memories_apikey
    ON company_scoped_memories (api_key_id)
    WHERE api_key_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_scoped_memories_session
    ON company_scoped_memories (session_id)
    WHERE session_id IS NOT NULL;
  `);
}
