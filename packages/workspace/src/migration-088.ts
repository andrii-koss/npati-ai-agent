import type { PoolClient } from "pg";

/** Additive session inbox. C6a remains the sole run/lease authority. */
export async function runMigration088(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS code_session_inboxes (
    company_id text NOT NULL, project_id text NOT NULL, session_id text NOT NULL,
    state jsonb NOT NULL CHECK(jsonb_typeof(state)='object' AND jsonb_typeof(state->'messages')='array'),
    data_classification text NOT NULL DEFAULT 'confidential' CHECK(data_classification IN ('public','internal','confidential','restricted')),
    retention_class text NOT NULL DEFAULT 'standard' CHECK(retention_class IN ('ephemeral','short','standard','extended','until_deleted')),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(company_id,session_id)
  )`);
  await client.query("CREATE INDEX IF NOT EXISTS code_session_inboxes_retention_idx ON code_session_inboxes(retention_class,updated_at)");
}
