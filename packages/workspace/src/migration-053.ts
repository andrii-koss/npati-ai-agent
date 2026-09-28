import type { PoolClient } from "pg";

export async function runMigration053(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE company_email_accounts ADD COLUMN IF NOT EXISTS provider TEXT;
    ALTER TABLE company_email_accounts ADD COLUMN IF NOT EXISTS connection_scope TEXT;
    ALTER TABLE company_email_accounts ADD COLUMN IF NOT EXISTS sender_policy TEXT;
    ALTER TABLE company_email_accounts ADD COLUMN IF NOT EXISTS allowed_senders TEXT[];
    ALTER TABLE company_email_accounts ADD COLUMN IF NOT EXISTS allowed_domains TEXT[];
    ALTER TABLE company_email_accounts ADD COLUMN IF NOT EXISTS require_authenticated_sender BOOLEAN;
    ALTER TABLE company_email_accounts ADD COLUMN IF NOT EXISTS outbound_policy TEXT;

    UPDATE company_email_accounts SET
      provider = COALESCE(provider, 'imap_smtp'),
      connection_scope = COALESCE(connection_scope, CASE WHEN agent_id IS NOT NULL THEN 'agent' WHEN company_id LIKE 'personal:%' THEN 'account' ELSE 'company' END),
      sender_policy = COALESCE(sender_policy, 'open'),
      allowed_senders = COALESCE(allowed_senders, ARRAY[]::TEXT[]),
      allowed_domains = COALESCE(allowed_domains, ARRAY[]::TEXT[]),
      require_authenticated_sender = COALESCE(require_authenticated_sender, false),
      outbound_policy = COALESCE(outbound_policy, CASE mode WHEN 'autopilot' THEN 'auto_send' WHEN 'manual' THEN 'draft_only' ELSE 'approval_required' END);

    ALTER TABLE company_email_accounts ALTER COLUMN provider SET DEFAULT 'imap_smtp';
    ALTER TABLE company_email_accounts ALTER COLUMN provider SET NOT NULL;
    ALTER TABLE company_email_accounts ALTER COLUMN connection_scope SET DEFAULT 'company';
    ALTER TABLE company_email_accounts ALTER COLUMN connection_scope SET NOT NULL;
    ALTER TABLE company_email_accounts ALTER COLUMN sender_policy SET DEFAULT 'allowlist';
    ALTER TABLE company_email_accounts ALTER COLUMN sender_policy SET NOT NULL;
    ALTER TABLE company_email_accounts ALTER COLUMN allowed_senders SET DEFAULT ARRAY[]::TEXT[];
    ALTER TABLE company_email_accounts ALTER COLUMN allowed_senders SET NOT NULL;
    ALTER TABLE company_email_accounts ALTER COLUMN allowed_domains SET DEFAULT ARRAY[]::TEXT[];
    ALTER TABLE company_email_accounts ALTER COLUMN allowed_domains SET NOT NULL;
    ALTER TABLE company_email_accounts ALTER COLUMN require_authenticated_sender SET DEFAULT true;
    ALTER TABLE company_email_accounts ALTER COLUMN require_authenticated_sender SET NOT NULL;
    ALTER TABLE company_email_accounts ALTER COLUMN outbound_policy SET DEFAULT 'approval_required';
    ALTER TABLE company_email_accounts ALTER COLUMN outbound_policy SET NOT NULL;
    ALTER TABLE company_email_accounts DROP CONSTRAINT IF EXISTS company_email_provider_check;
    ALTER TABLE company_email_accounts DROP CONSTRAINT IF EXISTS company_email_scope_check;
    ALTER TABLE company_email_accounts DROP CONSTRAINT IF EXISTS company_email_sender_policy_check;
    ALTER TABLE company_email_accounts DROP CONSTRAINT IF EXISTS company_email_outbound_policy_check;
    ALTER TABLE company_email_accounts ADD CONSTRAINT company_email_provider_check CHECK(provider IN ('gmail','microsoft','imap_smtp'));
    ALTER TABLE company_email_accounts ADD CONSTRAINT company_email_scope_check CHECK(connection_scope IN ('account','company','agent'));
    ALTER TABLE company_email_accounts ADD CONSTRAINT company_email_sender_policy_check CHECK(sender_policy IN ('pairing','allowlist','open','disabled'));
    ALTER TABLE company_email_accounts ADD CONSTRAINT company_email_outbound_policy_check CHECK(outbound_policy IN ('draft_only','approval_required','auto_send'));
  `);
}

export default runMigration053;
