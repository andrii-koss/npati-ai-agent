import type { PoolClient } from "pg";

export async function runMigration054(client: PoolClient) {
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS companies_project_owner_key ON companies(workspace_id, id, user_id);
    CREATE TABLE IF NOT EXISTS projects (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      company_id text NOT NULL,
      created_by text NOT NULL,
      name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
      description text,
      type text NOT NULL CHECK (type IN ('website','web_app','landing_page')),
      status text NOT NULL DEFAULT 'ready' CHECK (status IN ('creating','ready','working','building','previewing','failed','archived')),
      framework text,
      runtime text,
      repository_provider text,
      repository_url text,
      repository_branch text,
      sandbox_id text,
      preview_url text,
      preview_port integer CHECK (preview_port BETWEEN 1 AND 65535),
      last_run_id text,
      last_build_status text,
      revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      create_request_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT projects_company_owner_fk FOREIGN KEY (workspace_id,company_id,created_by)
        REFERENCES companies(workspace_id,id,user_id) ON DELETE CASCADE,
      CONSTRAINT projects_tenant_key UNIQUE (workspace_id,company_id,id),
      CONSTRAINT projects_create_key UNIQUE (workspace_id,company_id,created_by,create_request_key)
    );
    CREATE INDEX IF NOT EXISTS projects_company_list_idx ON projects(workspace_id,company_id,created_by,updated_at DESC,id);
    ALTER TABLE company_agent_runs ADD COLUMN IF NOT EXISTS project_id text;
    ALTER TABLE company_agent_runs ADD CONSTRAINT company_agent_runs_project_fk
      FOREIGN KEY (workspace_id,company_id,project_id)
      REFERENCES projects(workspace_id,company_id,id) ON DELETE SET NULL (project_id);`);
}

export async function rollbackMigration054(client: PoolClient) {
  await client.query(`ALTER TABLE company_agent_runs DROP CONSTRAINT IF EXISTS company_agent_runs_project_fk;
    ALTER TABLE company_agent_runs DROP COLUMN IF EXISTS project_id;
    DROP TABLE IF EXISTS projects;
    DROP INDEX IF EXISTS companies_project_owner_key;`);
}
