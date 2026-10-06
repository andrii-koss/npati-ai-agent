import type { PoolClient } from "pg";

/**
 * Migration 073 — the company-level protected-branch policy (C5a, additive).
 *
 * `code-protected-branches.ts` owns the decision and the SQL that reads and writes this table; this
 * migration owns only its shape, and it mirrors the DDL written in that module's TODO verbatim so the
 * two cannot drift apart:
 *
 *   - `company_id` is the primary key: one policy per company, and the store's optimistic write
 *     (`INSERT ... ON CONFLICT (company_id) DO UPDATE ... WHERE revision = $expected`) depends on it;
 *   - `workspace_id` records which workspace the policy was created in and is indexed for the
 *     scope-scoped lookups the administration routes make;
 *   - `branches` is the owner's protected-branch list (never empty — the service refuses an empty
 *     policy, because an empty list would silently unprotect every branch);
 *   - `revision` / `updated_by` / `updated_at` make a change auditable and let two owners race safely.
 *
 * Additive by construction: no existing table, row, index or query is touched. The policy is
 * deliberately **not** stored in `Company.memory`, which the generic company PATCH route can rewrite
 * without an owner check or an audit entry.
 *
 * A read of a company with no row falls back to the built-in `main`/`master`/`release` default in the
 * service — never to an empty set — so the hard deny exists before the first policy is written.
 */
export async function runMigration073(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_protected_branches (
      company_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      branches text[] NOT NULL DEFAULT '{}',
      revision integer NOT NULL DEFAULT 1,
      updated_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS company_protected_branches_scope_idx
      ON company_protected_branches (workspace_id)
  `);
}
