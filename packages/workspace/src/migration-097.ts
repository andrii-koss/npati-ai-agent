import type { PoolClient } from "pg";
export async function runMigration097(client: PoolClient) {
  await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS projects_catalog_owner_order ON projects(workspace_id,created_by,updated_at DESC,id ASC) WHERE status NOT IN ('soft_deleted','purging','deleted');
    CREATE INDEX IF NOT EXISTS projects_catalog_company_order ON projects(workspace_id,created_by,company_id,updated_at DESC,id ASC) WHERE status NOT IN ('soft_deleted','purging','deleted');
    CREATE INDEX IF NOT EXISTS projects_catalog_search ON projects USING gin (lower(name || ' ' || coalesce(description,'')) gin_trgm_ops) WHERE status NOT IN ('soft_deleted','purging','deleted');
    CREATE INDEX IF NOT EXISTS project_qa_reports_lookup_idx ON project_qa_reports(workspace_id,company_id,project_id,created_at DESC,id DESC);`);
}
