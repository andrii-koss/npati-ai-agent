import type { PoolClient } from "pg";

export async function runMigration061(client: PoolClient) {
  await client.query("ALTER TABLE data_backend_environments ADD COLUMN expected_schema jsonb");
  await client.query("ALTER TABLE data_backend_migration_locks ADD COLUMN acquired_at timestamptz NOT NULL DEFAULT now()");
}
