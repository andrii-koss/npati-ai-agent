import type { PoolClient } from "pg";

export async function runMigration094(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS conversation_research_evidence (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      company_id text,
      tool text NOT NULL,
      kind text NOT NULL,
      query text NOT NULL,
      sources jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_count integer NOT NULL DEFAULT 0,
      evidence_excerpt text NOT NULL DEFAULT '',
      degraded text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS conversation_research_evidence_scope_idx
      ON conversation_research_evidence (workspace_id, user_id, conversation_id, created_at DESC);
  `);
}

export async function rollbackMigration094(client: PoolClient): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS conversation_research_evidence_scope_idx;
    DROP TABLE IF EXISTS conversation_research_evidence;
  `);
}
