import type { PoolClient } from "pg";

/**
 * C1: Code Project and Code Session foundation.
 *
 * Everything in this migration is additive (expand only): a previous application version keeps
 * working against the new schema, so a rollback is a flag change and not a schema change.
 *
 * - The project type enum gains `code_project` (extending the enum still requires a migration).
 * - Projects gain classification/retention plus code metadata (toolchain, default branch).
 * - `code_sessions` records the unit the CodingAgentRunner will drive in C6. It links to the
 *   existing company run instead of duplicating run state, and carries the classification and
 *   retention fields required by the shared rules (rule 18).
 */
export async function runMigration065(client: PoolClient) {
  await client.query([
    "ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_type_check;",
    "ALTER TABLE projects ADD CONSTRAINT projects_type_check CHECK (type IN ('website','web_app','landing_page','mobile_app','code_project'));",

    "ALTER TABLE projects ADD COLUMN IF NOT EXISTS data_classification text NOT NULL DEFAULT 'confidential';",
    "ALTER TABLE projects ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'standard';",
    "ALTER TABLE projects ADD COLUMN IF NOT EXISTS toolchain jsonb;",
    "ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_branch text;",

    "ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_data_classification_check;",
    "ALTER TABLE projects ADD CONSTRAINT projects_data_classification_check CHECK (data_classification IN ('public','internal','confidential','restricted'));",
    "ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_retention_class_check;",
    "ALTER TABLE projects ADD CONSTRAINT projects_retention_class_check CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted'));",

    "CREATE TABLE IF NOT EXISTS code_sessions (",
    "  id text PRIMARY KEY,",
    "  workspace_id text NOT NULL,",
    "  company_id text NOT NULL,",
    "  project_id text NOT NULL,",
    "  user_id text NOT NULL,",
    "  agent_id text,",
    "  mode text NOT NULL DEFAULT 'edit' CHECK (mode IN ('plan','edit','auto','full_auto')),",
    "  model_profile text,",
    "  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','awaiting_approval','completed','failed','cancelled','archived')),",
    "  parent_session_id text,",
    "  run_id text,",
    "  summary text,",
    "  data_classification text NOT NULL DEFAULT 'confidential' CHECK (data_classification IN ('public','internal','confidential','restricted')),",
    "  retention_class text NOT NULL DEFAULT 'standard' CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted')),",
    "  tool_manifest_version integer,",
    "  created_at timestamptz NOT NULL DEFAULT now(),",
    "  updated_at timestamptz NOT NULL DEFAULT now(),",
    "  CONSTRAINT code_sessions_project_fk FOREIGN KEY (workspace_id, company_id, project_id)",
    "    REFERENCES projects(workspace_id, company_id, id) ON DELETE CASCADE",
    ");",
    "CREATE INDEX IF NOT EXISTS code_sessions_project_idx ON code_sessions(workspace_id, company_id, project_id, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS code_sessions_owner_idx ON code_sessions(workspace_id, company_id, user_id, status, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS code_sessions_run_idx ON code_sessions(run_id);",
  ].join("\n"));
}
