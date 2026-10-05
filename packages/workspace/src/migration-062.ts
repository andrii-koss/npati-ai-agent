import type { PoolClient } from "pg";

export async function runMigration062(client: PoolClient) {
  await client.query([
    "CREATE TABLE IF NOT EXISTS project_api_request_logs (",
    "  id text PRIMARY KEY,",
    "  workspace_id text NOT NULL,",
    "  company_id text NOT NULL,",
    "  project_id text NOT NULL,",
    "  backend_id text NOT NULL,",
    "  environment text NOT NULL CHECK(environment IN ('dev','prod')),",
    "  key_type text NOT NULL CHECK(key_type IN ('publishable','secret','anonymous')),",
    "  method text NOT NULL,",
    "  path text NOT NULL,",
    "  status_code integer NOT NULL,",
    "  duration_ms integer NOT NULL,",
    "  ip text,",
    "  created_at timestamptz NOT NULL DEFAULT now()",
    ");",
    "CREATE INDEX IF NOT EXISTS project_api_request_logs_idx ON project_api_request_logs(project_id, environment, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS project_api_request_logs_company_idx ON project_api_request_logs(workspace_id, company_id, created_at DESC);",
  ].join("\n"));
}
