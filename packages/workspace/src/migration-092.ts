import type { PoolClient } from "pg";

export async function runMigration092(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
    ALTER TABLE projects ADD CONSTRAINT projects_status_check
      CHECK (status IN ('creating','ready','working','building','previewing','failed','archived','soft_deleted','purging','deleted'));

    ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS purge_after timestamptz;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS deletion_reason text;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS restored_at timestamptz;

    CREATE INDEX IF NOT EXISTS projects_purge_schedule_idx
      ON projects (status, purge_after) WHERE status = 'soft_deleted';

    CREATE TABLE IF NOT EXISTS project_lifecycle_records (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      company_id text NOT NULL,
      project_id text NOT NULL,
      operation text NOT NULL CHECK (operation IN ('soft_delete', 'restore', 'hard_purge')),
      status text NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      attempt_count integer NOT NULL DEFAULT 1,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS project_lifecycle_records_project_idx
      ON project_lifecycle_records (workspace_id, company_id, project_id, created_at DESC);
  `);
}

export async function rollbackMigration092(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS project_lifecycle_records;
    DROP INDEX IF EXISTS projects_purge_schedule_idx;
    ALTER TABLE projects DROP COLUMN IF EXISTS restored_at;
    ALTER TABLE projects DROP COLUMN IF EXISTS deletion_reason;
    ALTER TABLE projects DROP COLUMN IF EXISTS purge_after;
    ALTER TABLE projects DROP COLUMN IF EXISTS deleted_at;
    ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
    ALTER TABLE projects ADD CONSTRAINT projects_status_check
      CHECK (status IN ('creating','ready','working','building','previewing','failed','archived'));
  `);
}
