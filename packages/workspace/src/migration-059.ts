import type { PoolClient } from "pg";
export async function runMigration059(client: PoolClient) {
  await client.query(`ALTER TABLE company_agent_runs DROP CONSTRAINT IF EXISTS company_agent_runs_status_check;
    ALTER TABLE company_agent_runs ADD CONSTRAINT company_agent_runs_status_check
      CHECK (status IN ('queued','planning','running','awaiting_approval','completed','failed','cancelling','cancelled'));
    ALTER TABLE company_agent_runs ADD COLUMN IF NOT EXISTS pending_plan jsonb;
    ALTER TABLE company_agent_run_events DROP CONSTRAINT IF EXISTS company_agent_run_events_run_status_check;
    ALTER TABLE company_agent_run_events ADD CONSTRAINT company_agent_run_events_run_status_check
      CHECK (run_status IN ('queued','planning','running','awaiting_approval','completed','failed','cancelling','cancelled'));`);
}
