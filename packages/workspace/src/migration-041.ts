import type { PoolClient } from "pg";

export async function runMigration041(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_email_deleted_messages (
      workspace_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      email_account_id UUID,
      external_message_id TEXT NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, company_id, external_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_email_deleted_messages_account
      ON company_email_deleted_messages(workspace_id, company_id, email_account_id, deleted_at DESC);
  `);
}

export default runMigration041;
