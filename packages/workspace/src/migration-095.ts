import type { PoolClient } from "pg";

export async function runMigration095(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE conversation_research_evidence
    ADD COLUMN IF NOT EXISTS page_count integer CHECK (page_count >= 0)`);
}
export async function rollbackMigration095(client: PoolClient): Promise<void> {
  await client.query("ALTER TABLE conversation_research_evidence DROP COLUMN IF EXISTS page_count");
}
