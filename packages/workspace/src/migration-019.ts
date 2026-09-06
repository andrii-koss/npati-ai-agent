import type { PoolClient } from "pg";

export async function runMigration019(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_api_keys (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{all}',
      encrypted_secret TEXT,
      last_used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_company_api_keys_hash
    ON company_api_keys (key_hash);

    CREATE INDEX IF NOT EXISTS idx_company_api_keys_company
    ON company_api_keys (company_id, tenant_id);
  `);
}
