import type { PoolClient } from "pg";

export async function runMigration040(client: PoolClient): Promise<void> {
  await client.query(`
    -- Email can be owned by either a Company or a private, user-scoped mailbox.
    -- Personal scopes use an opaque "personal:<hash>" value and therefore cannot
    -- use the companies composite foreign key.
    ALTER TABLE company_email_accounts DROP CONSTRAINT IF EXISTS company_email_accounts_company_fk;
    ALTER TABLE company_email_contacts DROP CONSTRAINT IF EXISTS company_email_contacts_company_fk;
    ALTER TABLE company_email_threads DROP CONSTRAINT IF EXISTS company_email_threads_company_fk;
    ALTER TABLE company_email_rules DROP CONSTRAINT IF EXISTS company_email_rules_company_fk;
    ALTER TABLE company_email_send_events DROP CONSTRAINT IF EXISTS company_email_send_events_company_fk;
    ALTER TABLE company_email_jobs DROP CONSTRAINT IF EXISTS company_email_jobs_company_fk;
    ALTER TABLE company_email_oauth_states DROP CONSTRAINT IF EXISTS company_email_oauth_states_company_fk;
    ALTER TABLE company_email_notifications DROP CONSTRAINT IF EXISTS company_email_notifications_company_fk;

    -- Keep the best active record if an earlier build allowed the same mailbox
    -- to be connected more than once by the same user.
    WITH ranked AS (
      SELECT id, row_number() OVER (
        PARTITION BY workspace_id, user_id, lower(email_address)
        ORDER BY (status = 'connected') DESC, updated_at DESC, created_at DESC, id
      ) AS duplicate_rank
      FROM company_email_accounts
      WHERE deleted_at IS NULL
    )
    UPDATE company_email_accounts account
       SET deleted_at = now(), status = 'disabled', updated_at = now()
      FROM ranked
     WHERE account.id = ranked.id AND ranked.duplicate_rank > 1;

    CREATE UNIQUE INDEX IF NOT EXISTS company_email_accounts_user_address_unique
      ON company_email_accounts(workspace_id, user_id, lower(email_address))
      WHERE deleted_at IS NULL;

    -- Preserve the previous ON DELETE CASCADE behaviour for real Company scopes.
    CREATE OR REPLACE FUNCTION cleanup_company_email_scope() RETURNS trigger AS $$
    BEGIN
      DELETE FROM company_email_notifications WHERE workspace_id = OLD.workspace_id AND company_id = OLD.id;
      DELETE FROM company_email_oauth_states WHERE workspace_id = OLD.workspace_id AND company_id = OLD.id;
      DELETE FROM company_email_jobs WHERE workspace_id = OLD.workspace_id AND company_id = OLD.id;
      DELETE FROM company_email_send_events WHERE workspace_id = OLD.workspace_id AND company_id = OLD.id;
      DELETE FROM company_email_rules WHERE workspace_id = OLD.workspace_id AND company_id = OLD.id;
      DELETE FROM company_email_templates WHERE workspace_id = OLD.workspace_id AND company_id = OLD.id;
      DELETE FROM company_email_contacts WHERE workspace_id = OLD.workspace_id AND company_id = OLD.id;
      DELETE FROM company_email_threads WHERE workspace_id = OLD.workspace_id AND company_id = OLD.id;
      DELETE FROM company_email_accounts WHERE workspace_id = OLD.workspace_id AND company_id = OLD.id;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS companies_email_scope_cleanup ON companies;
    CREATE TRIGGER companies_email_scope_cleanup
      BEFORE DELETE ON companies
      FOR EACH ROW EXECUTE FUNCTION cleanup_company_email_scope();
  `);
}

export default runMigration040;
