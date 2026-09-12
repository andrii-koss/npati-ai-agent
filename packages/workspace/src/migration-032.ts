import type { PoolClient } from "pg";

export async function runMigration032(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE company_api_keys
      ALTER COLUMN scopes SET DEFAULT '{workspace:read}';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_company_api_keys_hash_unique
      ON company_api_keys (key_hash);
  `);
}

export default runMigration032;