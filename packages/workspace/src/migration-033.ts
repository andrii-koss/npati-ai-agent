import type { PoolClient } from "pg";

export async function runMigration033(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE company_memories ADD COLUMN IF NOT EXISTS request_key text;
    CREATE UNIQUE INDEX IF NOT EXISTS company_memories_request_key_idx
      ON company_memories(workspace_id, company_id, user_id, source, request_key)
      WHERE request_key IS NOT NULL AND deleted_at IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS memory_items_automatic_flush_dedup_idx
      ON memory_items(workspace_id, business_id, user_id, md5(content))
      WHERE source = 'automatic_flush';

    CREATE TABLE IF NOT EXISTS company_daily_memory_notes (
      id uuid PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id text NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      note_date date NOT NULL,
      topic text NOT NULL,
      content text NOT NULL,
      agent_id uuid,
      idempotency_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT company_daily_memory_notes_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE,
      CONSTRAINT company_daily_memory_notes_idempotency_unique UNIQUE(workspace_id,company_id,user_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS company_daily_memory_notes_scope_idx
      ON company_daily_memory_notes(workspace_id,company_id,user_id,note_date DESC,created_at);

    CREATE TABLE IF NOT EXISTS company_standing_intents (
      id uuid PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id text NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title text NOT NULL,
      description text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','in_progress','fulfilled','cancelled')),
      trigger_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
      revision integer NOT NULL DEFAULT 1,
      idempotency_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      CONSTRAINT company_standing_intents_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE,
      CONSTRAINT company_standing_intents_idempotency_unique UNIQUE(workspace_id,company_id,user_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS company_standing_intents_scope_idx
      ON company_standing_intents(workspace_id,company_id,user_id,status,updated_at DESC);
  `);
}

export default runMigration033;
