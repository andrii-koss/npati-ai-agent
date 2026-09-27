import type { PoolClient } from "pg";

export async function runMigration046(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE messaging_connections ADD COLUMN IF NOT EXISTS connection_scope TEXT;
    UPDATE messaging_connections SET connection_scope=CASE WHEN agent_id IS NOT NULL THEN 'agent' ELSE 'company' END
      WHERE connection_scope IS NULL;
    ALTER TABLE messaging_connections ALTER COLUMN connection_scope SET DEFAULT 'account';
    ALTER TABLE messaging_connections ALTER COLUMN connection_scope SET NOT NULL;
    ALTER TABLE messaging_connections DROP CONSTRAINT IF EXISTS messaging_connections_connection_scope_check;
    ALTER TABLE messaging_connections ADD CONSTRAINT messaging_connections_connection_scope_check
      CHECK(connection_scope IN ('account','company','agent'));
    ALTER TABLE messaging_connections ALTER COLUMN company_id DROP NOT NULL;
    ALTER TABLE messaging_connections ADD COLUMN IF NOT EXISTS active_company_id TEXT REFERENCES companies(id) ON DELETE SET NULL;
    ALTER TABLE messaging_connections ADD COLUMN IF NOT EXISTS active_agent_id TEXT REFERENCES company_agents(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_messaging_connections_account_scope
      ON messaging_connections(workspace_id,user_id,status,channel) WHERE connection_scope='account';
  `);
}

export default runMigration046;
