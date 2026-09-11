import type {PoolClient} from "pg";

export async function runMigration028(client:PoolClient):Promise<void>{
  await client.query(`
    ALTER TABLE company_approvals
      ADD COLUMN IF NOT EXISTS payload_hash TEXT,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
    UPDATE company_approvals SET expires_at=requested_at+INTERVAL '15 minutes' WHERE expires_at IS NULL;
    CREATE INDEX IF NOT EXISTS company_approvals_runtime_idx
      ON company_approvals(workspace_id,company_id,run_id,status,expires_at)
      WHERE consumed_at IS NULL;
  `);
}
