import type { PoolClient } from "pg";

export async function runMigration038(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_email_send_events (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL,
      email_account_id UUID NOT NULL REFERENCES company_email_accounts(id) ON DELETE CASCADE,
      recipient_email TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT company_email_send_events_company_fk
        FOREIGN KEY (company_id, workspace_id) REFERENCES companies(id, workspace_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_email_send_events_account_time
      ON company_email_send_events(workspace_id, company_id, email_account_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_send_events_recipient_time
      ON company_email_send_events(workspace_id, company_id, email_account_id, recipient_email, sent_at DESC);

    CREATE TABLE IF NOT EXISTS company_email_jobs (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL,
      email_account_id UUID REFERENCES company_email_accounts(id) ON DELETE CASCADE,
      thread_id UUID REFERENCES company_email_threads(id) ON DELETE CASCADE,
      message_id UUID REFERENCES company_email_messages(id) ON DELETE CASCADE,
      job_type TEXT NOT NULL CHECK(job_type IN ('send', 'followup', 'sync', 'delivery_check', 'attachment_analysis')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      attempt_count INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 5,
      run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_at TIMESTAMPTZ,
      locked_by TEXT,
      last_error TEXT,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT company_email_jobs_company_fk
        FOREIGN KEY (company_id, workspace_id) REFERENCES companies(id, workspace_id) ON DELETE CASCADE,
      CONSTRAINT company_email_jobs_idempotency UNIQUE (workspace_id, company_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_email_jobs_claim
      ON company_email_jobs(status, run_after, created_at)
      WHERE status IN ('queued', 'processing');
  `);
}

export default runMigration038;
