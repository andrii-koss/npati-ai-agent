import type { PoolClient } from "pg";

/** Expand the durable run status set for resumable feature-flag suspension; existing rows stay valid. */
export async function runMigration091(client: PoolClient): Promise<void> {
  await client.query("ALTER TABLE code_run_states DROP CONSTRAINT IF EXISTS code_run_states_status_check");
  await client.query(`
    ALTER TABLE code_run_states ADD CONSTRAINT code_run_states_status_check
      CHECK (status IN ('running','waiting_for_user','interrupted','suspended_by_flag','completed','failed','cancelled'))
  `);
}
