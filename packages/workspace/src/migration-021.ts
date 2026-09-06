import type { PoolClient } from "pg";

export async function runMigration021(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      family_id TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{all}',
      is_revoked BOOLEAN NOT NULL DEFAULT false,
      expires_at TIMESTAMPTZ NOT NULL,
      rotated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_hash
    ON oauth_refresh_tokens (token_hash);

    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family
    ON oauth_refresh_tokens (family_id);
  `);
}
