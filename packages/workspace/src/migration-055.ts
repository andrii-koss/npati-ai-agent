import type { PoolClient } from "pg";

export async function runMigration055(client: PoolClient) {
  await client.query(`CREATE TABLE IF NOT EXISTS project_terminal_events (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    company_id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    run_id text,
    agent_id text,
    sandbox_id text NOT NULL,
    process_id text,
    command_summary text NOT NULL,
    risk_level text NOT NULL CHECK (risk_level IN ('safe','controlled','approval')),
    status text NOT NULL CHECK (status IN ('completed','failed','timed_out','running','stopped')),
    exit_code integer,
    output text NOT NULL DEFAULT '',
    error_code text,
    duration_ms integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_terminal_events_project_fk FOREIGN KEY (workspace_id,company_id,project_id)
      REFERENCES projects(workspace_id,company_id,id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS project_terminal_events_lookup_idx
    ON project_terminal_events(workspace_id,company_id,project_id,created_at DESC,id DESC);`);
}

export async function rollbackMigration055(client: PoolClient) {
  await client.query("DROP TABLE IF EXISTS project_terminal_events");
}
