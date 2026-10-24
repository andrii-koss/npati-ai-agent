import type { PoolClient } from "pg";

export async function runMigration093(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE goals ADD COLUMN IF NOT EXISTS assigned_agent_id text REFERENCES company_agents(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS goals_assigned_agent_idx ON goals (assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;
  `);
}

export async function rollbackMigration093(client: PoolClient): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS goals_assigned_agent_idx;
    ALTER TABLE goals DROP COLUMN IF EXISTS assigned_agent_id;
  `);
}
