import type { PoolClient } from "pg";

export async function runMigration042(client: PoolClient): Promise<void> {
  await client.query(`
    -- Migration 041 initially declared workspace_id as UUID, while every email
    -- table and workspaces.id use TEXT. Repair already-created installations.
    ALTER TABLE company_email_deleted_messages
      ALTER COLUMN workspace_id TYPE TEXT USING workspace_id::text;
  `);
}

export default runMigration042;
