import type { PoolClient } from "pg";
export async function runMigration089(client: PoolClient) {
  await client.query(`CREATE TABLE IF NOT EXISTS code_process_projects (
    company_id text NOT NULL,project_id text NOT NULL,state jsonb NOT NULL CHECK(jsonb_typeof(state->'operations')='array'),
    data_classification text NOT NULL CHECK(data_classification IN ('public','internal','confidential','restricted')),
    retention_class text NOT NULL CHECK(retention_class IN ('ephemeral','short','standard','extended','until_deleted')),
    updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(company_id,project_id))`);
}
