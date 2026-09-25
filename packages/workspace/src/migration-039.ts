import type { PoolClient } from "pg";

export async function runMigration039(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_email_oauth_states (
      state_hash TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL,
      account_id UUID NOT NULL REFERENCES company_email_accounts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      encrypted_verifier TEXT NOT NULL,
      token_url TEXT NOT NULL,
      client_id TEXT NOT NULL,
      encrypted_client_secret TEXT,
      redirect_uri TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT company_email_oauth_states_company_fk
        FOREIGN KEY (company_id, workspace_id) REFERENCES companies(id, workspace_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_company_email_oauth_expiry ON company_email_oauth_states(expires_at);

    CREATE TABLE IF NOT EXISTS company_email_notifications (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL,
      user_id TEXT,
      thread_id UUID REFERENCES company_email_threads(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT company_email_notifications_company_fk
        FOREIGN KEY (company_id, workspace_id) REFERENCES companies(id, workspace_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_company_email_notifications_lookup
      ON company_email_notifications(workspace_id, company_id, user_id, is_read, created_at DESC);
  `);
}

export default runMigration039;
