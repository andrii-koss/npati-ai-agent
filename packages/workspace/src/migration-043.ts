import type { PoolClient } from "pg";

export async function runMigration043(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_browser_credentials (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      field_names JSONB NOT NULL DEFAULT '[]'::jsonb,
      encrypted_fields TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(workspace_id,company_id,user_id,label)
    );
    CREATE INDEX IF NOT EXISTS idx_company_browser_credentials_tenant
      ON company_browser_credentials(workspace_id,company_id,user_id);
    CREATE TABLE IF NOT EXISTS company_browser_email_waits (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      browser_job_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      sender_hint TEXT,
      status TEXT NOT NULL DEFAULT 'waiting_email',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      consumed_at TIMESTAMPTZ,
      UNIQUE(workspace_id,company_id,browser_job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_company_browser_email_waits_pending
      ON company_browser_email_waits(workspace_id,company_id,status,created_at DESC);
  `);
}

export default runMigration043;
