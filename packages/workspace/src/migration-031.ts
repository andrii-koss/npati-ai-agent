import type { PoolClient } from "pg";

export async function runMigration031(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_api_key_devices (
      id TEXT PRIMARY KEY,
      key_id TEXT NOT NULL REFERENCES company_api_keys(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      user_agent TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'unknown',
      requests_count INT NOT NULL DEFAULT 1,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_devices_unique
    ON company_api_key_devices (key_id, device_id);

    CREATE INDEX IF NOT EXISTS idx_api_key_devices_key
    ON company_api_key_devices (key_id);
  `);
}

export default runMigration031;
