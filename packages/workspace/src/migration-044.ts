import type { PoolClient } from "pg";

export async function runMigration044(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_browser_campaign_targets (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      automation_id UUID REFERENCES company_automations(id) ON DELETE SET NULL,
      email_account_id UUID,
      credential_id UUID REFERENCES company_browser_credentials(id) ON DELETE SET NULL,
      site_name TEXT NOT NULL,
      registration_url TEXT NOT NULL,
      publish_url TEXT,
      allowed_domain TEXT NOT NULL,
      article_title TEXT,
      article_body TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','waiting_email','registered','published','failed','paused')),
      result_url TEXT,
      browser_job_id TEXT,
      last_run_id TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 100,
      last_attempt_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_browser_campaign_targets_tenant
      ON company_browser_campaign_targets(workspace_id,company_id,user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_browser_campaign_targets_queue
      ON company_browser_campaign_targets(automation_id,status,priority,created_at);
    ALTER TABLE company_browser_email_waits ADD COLUMN IF NOT EXISTS campaign_target_id UUID
      REFERENCES company_browser_campaign_targets(id) ON DELETE SET NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS legal_name TEXT;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_email TEXT;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_phone TEXT;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS postal_address TEXT;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS registration_details TEXT;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_file_id UUID;
  `);
}

export default runMigration044;
