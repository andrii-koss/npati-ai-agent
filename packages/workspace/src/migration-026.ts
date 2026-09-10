import type { PoolClient } from "pg";

export async function runMigration026(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE company_scoped_memories
      ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS company_scoped_memories_fts_idx
      ON company_scoped_memories
      USING GIN (to_tsvector('simple', title || ' ' || content))
      WHERE deleted_at IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS company_scoped_memories_idempotency_idx
      ON company_scoped_memories (
        tenant_id,
        company_id,
        scope_type,
        COALESCE(api_key_id, ''),
        COALESCE(session_id, ''),
        idempotency_key
      )
      WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS company_scoped_memories_active_scope_idx
      ON company_scoped_memories (tenant_id, company_id, api_key_id, session_id, updated_at DESC)
      WHERE deleted_at IS NULL;
  `);
}
