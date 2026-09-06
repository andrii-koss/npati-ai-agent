import type { PoolClient } from "pg";

export async function runMigration022(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_channel_pairings (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      sender_id TEXT,
      pairing_code TEXT NOT NULL,
      paired_agent_id TEXT,
      is_approved BOOLEAN NOT NULL DEFAULT false,
      allowlist_rules JSONB NOT NULL DEFAULT '{"allowedSenders":[],"blockedSenders":[]}'::jsonb,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_channel_pairings_lookup
    ON company_channel_pairings (company_id, tenant_id, channel_type, sender_id);

    CREATE INDEX IF NOT EXISTS idx_channel_pairing_code
    ON company_channel_pairings (pairing_code);
  `);
}
