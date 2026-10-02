import type { PoolClient } from "pg";

export async function runMigration056(client: PoolClient) {
  await client.query(`CREATE TABLE IF NOT EXISTS project_checkpoints (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    company_id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    description text,
    commit_hash text,
    trigger text NOT NULL CHECK (trigger IN ('manual', 'pre_run', 'post_run', 'pre_restore')),
    run_id text,
    file_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_checkpoints_project_fk FOREIGN KEY (workspace_id, company_id, project_id)
      REFERENCES projects(workspace_id, company_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS project_checkpoints_lookup_idx
    ON project_checkpoints(workspace_id, company_id, project_id, created_at DESC, id DESC);`);
}

export async function rollbackMigration056(client: PoolClient) {
  await client.query("DROP TABLE IF EXISTS project_checkpoints");
}
