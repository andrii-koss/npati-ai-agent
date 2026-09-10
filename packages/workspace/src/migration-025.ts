import type { PoolClient } from "pg";

export async function runMigration025(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE INDEX IF NOT EXISTS company_knowledge_chunks_fts_idx
      ON company_knowledge_chunks
      USING GIN (to_tsvector('simple', content));

    CREATE INDEX IF NOT EXISTS company_memories_fts_idx
      ON company_memories
      USING GIN (to_tsvector('simple', content))
      WHERE deleted_at IS NULL;
  `);
}
