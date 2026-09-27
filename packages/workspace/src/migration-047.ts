import type { PoolClient } from "pg";

export async function runMigration047(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS messaging_sessions (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES messaging_connections(id) ON DELETE CASCADE,
      external_chat_id TEXT NOT NULL,
      external_thread_id TEXT NOT NULL DEFAULT '',
      runtime_conversation_id TEXT,
      active_company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      active_agent_id TEXT REFERENCES company_agents(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(connection_id, external_chat_id, external_thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messaging_sessions_connection
      ON messaging_sessions(connection_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messaging_inbound_events (
      connection_id TEXT NOT NULL REFERENCES messaging_connections(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      message_id TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(connection_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messaging_inbound_events_received
      ON messaging_inbound_events(received_at);
  `);
}

export default runMigration047;
