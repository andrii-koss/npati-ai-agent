import type { PoolClient } from "pg";

export async function runMigration057(client: PoolClient) {
  await client.query(`CREATE TABLE IF NOT EXISTS project_deployments (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    company_id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    provider text NOT NULL,
    environment text NOT NULL DEFAULT 'production',
    branch text NOT NULL DEFAULT 'project/main',
    commit_hash text,
    status text NOT NULL CHECK (status IN ('queued', 'building', 'deployed', 'failed')),
    target_url text,
    external_deployment_id text,
    preflight_summary jsonb,
    error_message text,
    run_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_deployments_project_fk FOREIGN KEY (workspace_id, company_id, project_id)
      REFERENCES projects(workspace_id, company_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS project_deployments_lookup_idx
    ON project_deployments(workspace_id, company_id, project_id, created_at DESC, id DESC);
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS deployment_url text;
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS deployment_status text;
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_deployed_at timestamptz;`);
}

export async function rollbackMigration057(client: PoolClient) {
  await client.query("DROP TABLE IF EXISTS project_deployments");
}
