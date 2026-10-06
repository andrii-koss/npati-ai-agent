import type { PoolClient } from "pg";

/**
 * C5: scoped approval rules (owner decision — `once` | `session` | `project`).
 *
 * A rule is what makes an approval reusable *inside a bounded scope* instead of once per payload:
 * - `once` (the default) creates no rule at all and keeps the existing one-shot behaviour, where the
 *   approval is bound to one `payload_hash`;
 * - `session` allows one action inside one CodeSession;
 * - `project` allows one action inside one project.
 *
 * A rule can only ever *widen an approval*, never a prohibition: hard deny, the network enforcement
 * gate and the `plan` session-mode denial are decided in earlier policy phases and are therefore
 * unreachable by any rule (the service additionally refuses to create a rule for a hard-deny action).
 *
 * Additive only (expand): a new table, no change to existing ones.
 */
export async function runMigration070(client: PoolClient): Promise<void> {
  await client.query([
    "CREATE TABLE IF NOT EXISTS code_approval_rules (",
    "  id text PRIMARY KEY,",
    "  workspace_id text NOT NULL,",
    "  company_id text NOT NULL,",
    "  project_id text,",
    "  session_id text,",
    "  created_by text NOT NULL,",
    "  scope text NOT NULL CHECK (scope IN ('session','project')),",
    "  action text NOT NULL,",
    "  decision text NOT NULL DEFAULT 'allow' CHECK (decision IN ('allow')),",
    "  reason text,",
    "  expires_at timestamptz,",
    "  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),",
    "  created_at timestamptz NOT NULL DEFAULT now(),",
    "  updated_at timestamptz NOT NULL DEFAULT now(),",
    // A session-scoped rule must name its session, a project-scoped rule its project: a rule without
    // its scope anchor would be wider than the scope it claims.
    "  CONSTRAINT code_approval_rules_scope_anchor CHECK (",
    "    (scope = 'session' AND session_id IS NOT NULL AND project_id IS NOT NULL)",
    "    OR (scope = 'project' AND project_id IS NOT NULL)",
    "  )",
    ");",
    // One rule per (company, project, session, scope, action); a second identical grant is an update.
    "CREATE UNIQUE INDEX IF NOT EXISTS code_approval_rules_unique_idx",
    "  ON code_approval_rules (company_id, COALESCE(project_id,''), COALESCE(session_id,''), scope, action);",
    "CREATE INDEX IF NOT EXISTS code_approval_rules_lookup_idx",
    "  ON code_approval_rules (workspace_id, company_id, action, scope);",
    "CREATE INDEX IF NOT EXISTS code_approval_rules_session_idx",
    "  ON code_approval_rules (workspace_id, company_id, session_id);",
  ].join("\n"));
}

export default runMigration070;
