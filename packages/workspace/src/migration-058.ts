import type { PoolClient } from "pg";

export async function runMigration058(client: PoolClient) {
  await client.query(`CREATE TABLE IF NOT EXISTS project_qa_reports (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    company_id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('passed', 'warning', 'failed', 'error')),
    target_url text NOT NULL,
    summary text NOT NULL,
    issues jsonb NOT NULL DEFAULT '[]',
    metrics jsonb NOT NULL DEFAULT '{}',
    screenshots jsonb NOT NULL DEFAULT '[]',
    run_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_qa_reports_project_fk FOREIGN KEY (workspace_id, company_id, project_id)
      REFERENCES projects(workspace_id, company_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS project_qa_reports_lookup_idx
    ON project_qa_reports(workspace_id, company_id, project_id, created_at DESC, id DESC);`);
}

export async function rollbackMigration058(client: PoolClient) {
  await client.query("DROP TABLE IF EXISTS project_qa_reports");
}
