import type { PoolClient } from "pg";

export async function runMigration037(client: PoolClient): Promise<void> {
  await client.query(`
    -- 1. Company Email Accounts (Settings -> Email)
    CREATE TABLE IF NOT EXISTS company_email_accounts (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email_address TEXT NOT NULL,
      display_name TEXT,
      agent_id TEXT,
      mode TEXT NOT NULL DEFAULT 'approval' CHECK(mode IN ('manual', 'approval', 'autopilot')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('connected', 'pending', 'auth_error', 'imap_error', 'smtp_error', 'dns_error', 'disabled')),
      test_mode BOOLEAN NOT NULL DEFAULT false,
      confidence_threshold NUMERIC(4, 2) NOT NULL DEFAULT 0.80,
      language_mode TEXT NOT NULL DEFAULT 'auto',
      fallback_language TEXT NOT NULL DEFAULT 'en',
      imap_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      smtp_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      rate_limits JSONB NOT NULL DEFAULT '{"max_per_hour": 50, "max_per_day": 500, "max_per_recipient_daily": 5, "max_followups": 3}'::jsonb,
      signature_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      followup_config JSONB NOT NULL DEFAULT '{"enabled": false, "delay_days": 2, "max_followups": 2, "action": "draft"}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ,
      CONSTRAINT company_email_accounts_company_fk FOREIGN KEY (company_id, workspace_id) REFERENCES companies(id, workspace_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_email_accounts_company ON company_email_accounts(workspace_id, company_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_email_accounts_address ON company_email_accounts(workspace_id, email_address) WHERE deleted_at IS NULL;

    -- 2. Company Email Contacts (Customer Card / VIP / Blacklist)
    CREATE TABLE IF NOT EXISTS company_email_contacts (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      company_name TEXT,
      phone TEXT,
      is_vip BOOLEAN NOT NULL DEFAULT false,
      is_blacklisted BOOLEAN NOT NULL DEFAULT false,
      notes TEXT,
      last_activity_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT company_email_contacts_company_fk FOREIGN KEY (company_id, workspace_id) REFERENCES companies(id, workspace_id) ON DELETE CASCADE,
      CONSTRAINT company_email_contacts_unique_email UNIQUE (workspace_id, company_id, email)
    );

    CREATE INDEX IF NOT EXISTS idx_email_contacts_lookup ON company_email_contacts(workspace_id, company_id, email);

    -- 3. Company Email Threads
    CREATE TABLE IF NOT EXISTS company_email_threads (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL,
      email_account_id UUID REFERENCES company_email_accounts(id) ON DELETE CASCADE,
      thread_key TEXT NOT NULL,
      subject TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_name TEXT,
      customer_company TEXT,
      customer_phone TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'ai_processing', 'draft_ready', 'waiting_approval', 'waiting_customer', 'waiting_human', 'answered', 'closed', 'failed')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
      folder TEXT NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox', 'sent', 'drafts', 'archived', 'spam')),
      assigned_agent_id TEXT,
      assigned_user_id TEXT,
      is_vip BOOLEAN NOT NULL DEFAULT false,
      is_blacklisted BOOLEAN NOT NULL DEFAULT false,
      is_human_takeover BOOLEAN NOT NULL DEFAULT false,
      locked_by_user_id TEXT,
      locked_at TIMESTAMPTZ,
      last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      unread_count INT NOT NULL DEFAULT 0,
      ai_confidence_score NUMERIC(4, 2),
      ai_classification_summary TEXT,
      detected_language TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT company_email_threads_company_fk FOREIGN KEY (company_id, workspace_id) REFERENCES companies(id, workspace_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_email_threads_lookup ON company_email_threads(workspace_id, company_id, folder, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_threads_account ON company_email_threads(email_account_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_threads_status ON company_email_threads(workspace_id, company_id, status);
    CREATE INDEX IF NOT EXISTS idx_email_threads_customer ON company_email_threads(workspace_id, company_id, customer_email);

    -- 4. Company Email Messages
    CREATE TABLE IF NOT EXISTS company_email_messages (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL,
      thread_id UUID NOT NULL REFERENCES company_email_threads(id) ON DELETE CASCADE,
      email_account_id UUID REFERENCES company_email_accounts(id) ON DELETE SET NULL,
      message_id TEXT,
      in_reply_to TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      from_address TEXT NOT NULL,
      from_name TEXT,
      to_addresses TEXT[] NOT NULL DEFAULT '{}',
      cc_addresses TEXT[] NOT NULL DEFAULT '{}',
      bcc_addresses TEXT[] NOT NULL DEFAULT '{}',
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      body_html TEXT,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      delivery_status TEXT NOT NULL DEFAULT 'sent' CHECK(delivery_status IN ('sending', 'sent', 'delivered', 'bounced', 'rejected', 'failed')),
      delivery_error TEXT,
      is_draft BOOLEAN NOT NULL DEFAULT false,
      is_ai_generated BOOLEAN NOT NULL DEFAULT false,
      ai_draft_approved_by TEXT,
      sent_by_user_id TEXT,
      sent_by_agent_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON company_email_messages(thread_id, created_at ASC);

    -- 5. Company Email Templates (Signatures / Canned Responses)
    CREATE TABLE IF NOT EXISTS company_email_templates (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL,
      email_account_id UUID REFERENCES company_email_accounts(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general' CHECK(category IN ('support', 'sales', 'billing', 'information', 'general')),
      subject_template TEXT,
      body_template TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_email_templates_lookup ON company_email_templates(workspace_id, company_id, category);

    -- 6. Company Email Rules
    CREATE TABLE IF NOT EXISTS company_email_rules (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL,
      email_account_id UUID REFERENCES company_email_accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      priority_order INT NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
      actions JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT company_email_rules_company_fk FOREIGN KEY (company_id, workspace_id) REFERENCES companies(id, workspace_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_email_rules_lookup ON company_email_rules(workspace_id, company_id, priority_order ASC) WHERE is_active = true;
  `);
}

export default runMigration037;
