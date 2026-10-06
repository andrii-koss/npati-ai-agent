import type { PoolClient } from "pg";

/**
 * Migration 072 — company-level membership and invites (C5a, additive).
 *
 * `workspace_members` (001_business_workspace.sql) stays exactly as it is: it is scoped to a workspace and
 * its `assertMember` only proves that a user is *a* member, not what they may do. Company membership is the
 * authorisation anchor the coding agent needs (user -> company -> project -> workspace -> session ->
 * sandbox), so it lives in its own tables and existing rows/queries are untouched by this migration.
 *
 * Backfill is deliberately conservative: an existing workspace `owner` becomes a company `owner`, but only
 * when that mapping is unambiguous. If no owner can be determined from existing data the migration inserts
 * nothing and leaves the note below in place — inventing an owner would hand out `admin:all`.
 */
export async function runMigration072(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_members (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'reviewer')),
      status text NOT NULL CHECK (status IN ('active', 'invited', 'suspended')),
      invited_by text,
      invited_at timestamptz,
      accepted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      revision integer NOT NULL DEFAULT 1
    )
  `);

  // One membership row per (company, user): upserts and role changes stay idempotent.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS company_members_company_user_key
      ON company_members (company_id, user_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS company_members_company_role_idx
      ON company_members (company_id, role)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS company_members_user_idx
      ON company_members (user_id)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS company_invites (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      email text NOT NULL,
      role text NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'reviewer')),
      token_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_by text NOT NULL,
      accepted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS company_invites_token_hash_key
      ON company_invites (token_hash)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS company_invites_company_email_idx
      ON company_invites (company_id, email)
  `);

  // Backfill: the only workspace owner of a company's workspace becomes that company's owner.
  // Idempotent, and a no-op when the mapping is ambiguous (several owners) or impossible (no owner row
  // at all).
  //
  // SQL fix (C5a, part 2A): the first version read `company_id` from `workspace_members`, a column that
  // does not exist (001_business_workspace.sql defines workspace_members(workspace_id, user_id, role,
  // current_business_id)); the statement failed at run time with `column "company_id" does not exist`,
  // which broke `initialize()` on any database that had not applied 072 yet. Company identity therefore
  // comes from `companies` (006_company_model), joined on the workspace, and the ambiguity guard is now
  // counted per workspace — the same intent, expressed against the real schema.
  await client.query(`
    INSERT INTO company_members (id, company_id, user_id, role, status, accepted_at)
    SELECT
      'cm_' || md5(c.id || ':' || wm.user_id),
      c.id,
      wm.user_id,
      'owner',
      'active',
      now()
    FROM companies c
    JOIN workspace_members wm
      ON wm.workspace_id = c.workspace_id AND wm.role = 'owner'
    WHERE (
      SELECT COUNT(*) FROM workspace_members owner_members
      WHERE owner_members.workspace_id = c.workspace_id AND owner_members.role = 'owner'
    ) = 1
    ON CONFLICT (company_id, user_id) DO NOTHING
  `);

  // TODO(C5a follow-up): for companies whose workspace has more than one owner the backfill intentionally
  // inserts nothing. Those instances keep working through the owner's existing session, and a real owner
  // must be recorded explicitly (administrative action, audited) before company-scoped authorisation is
  // enforced for them.
}
