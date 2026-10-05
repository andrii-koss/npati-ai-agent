import type { PoolClient } from "pg";

/**
 * D6: mobile_app projects.
 *
 * - Extends the project type enum with `mobile_app` (new types still require a migration).
 * - Adds the per-project deep link scheme used by generated mobile apps.
 * - Adds per-project auth redirect URLs (email verification / password reset) that the
 *   Project API gateway validates before building a link.
 */
export async function runMigration063(client: PoolClient) {
  await client.query([
    "ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_type_check;",
    "ALTER TABLE projects ADD CONSTRAINT projects_type_check CHECK (type IN ('website','web_app','landing_page','mobile_app'));",
    "ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_scheme text;",
    "CREATE TABLE IF NOT EXISTS project_redirect_urls (",
    "  id text PRIMARY KEY,",
    "  workspace_id text NOT NULL,",
    "  company_id text NOT NULL,",
    "  project_id text NOT NULL,",
    "  environment text NOT NULL CHECK(environment IN ('dev','prod')),",
    "  url text NOT NULL,",
    "  created_at timestamptz NOT NULL DEFAULT now()",
    ");",
    "CREATE UNIQUE INDEX IF NOT EXISTS project_redirect_urls_unique ON project_redirect_urls(project_id, environment, url);",
    "CREATE INDEX IF NOT EXISTS project_redirect_urls_project_idx ON project_redirect_urls(project_id, environment);",
  ].join("\n"));
}
