import type { PoolClient } from "pg";

/**
 * C5: project trust and session revision.
 *
 * Trust is stored in its own table rather than as columns on `projects`, so the change is purely
 * additive and no existing project query or type has to change: a trust record exists only after an
 * owner/admin explicitly trusts a project, and its `revision` gives the mode/trust routes their
 * optimistic-concurrency token.
 *
 * Repository content (README, NPATI.md, AGENTS.md, any workspace file) is DATA, never instructions. A
 * trust record only allows a project's own instructions to guide *the content of the work*; it can never
 * change the session mode, policy, allowlist, tool list or approvals.
 */
export async function runMigration071(client: PoolClient) {
  await client.query([
    "CREATE TABLE IF NOT EXISTS project_code_trust (",
    "  id text PRIMARY KEY,",
    "  workspace_id text NOT NULL,",
    "  company_id text NOT NULL,",
    "  project_id text NOT NULL,",
    "  trusted boolean NOT NULL DEFAULT false,",
    "  trusted_by text,",
    "  trusted_at timestamptz,",
    "  revoked_by text,",
    "  revoked_at timestamptz,",
    "  reason text,",
    "  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),",
    "  updated_at timestamptz NOT NULL DEFAULT now(),",
    "  CONSTRAINT project_code_trust_project_key UNIQUE (company_id, project_id)",
    ");",
    "CREATE INDEX IF NOT EXISTS project_code_trust_company_idx ON project_code_trust(workspace_id, company_id);",

    "ALTER TABLE code_sessions ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;",
  ].join("\n"));
}
