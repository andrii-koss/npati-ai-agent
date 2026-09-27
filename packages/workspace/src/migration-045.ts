import type { PoolClient } from "pg";
export async function runMigration045(client: PoolClient): Promise<void> { await client.query(`
  CREATE TABLE IF NOT EXISTS messaging_connections (
    id UUID PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES company_agents(id) ON DELETE SET NULL, channel TEXT NOT NULL CHECK(channel IN ('telegram','discord','slack','whatsapp','email')),
    display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','paused','error')),
    bot_username TEXT, external_user_id TEXT, external_chat_id TEXT, external_thread_id TEXT, runtime_conversation_id TEXT, permissions TEXT[] NOT NULL DEFAULT '{}',
    webhook_secret TEXT NOT NULL UNIQUE, encrypted_credential TEXT NOT NULL, pairing_code_hash TEXT, pairing_expires_at TIMESTAMPTZ,
    last_inbound_at TIMESTAMPTZ, last_outbound_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_messaging_connections_tenant ON messaging_connections(workspace_id,user_id,company_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messaging_connections_delivery ON messaging_connections(company_id,agent_id,status,channel);
  ALTER TABLE messaging_connections ADD COLUMN IF NOT EXISTS runtime_conversation_id TEXT;
`); }
export default runMigration045;
