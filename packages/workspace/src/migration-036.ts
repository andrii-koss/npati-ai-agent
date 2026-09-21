import type { PoolClient } from "pg";

/** Neutral conversations have no business, so this foreign key must allow NULL. */
export async function runMigration036(client: PoolClient): Promise<void> {
  await client.query("ALTER TABLE conversations ALTER COLUMN business_id DROP NOT NULL");
}

export default runMigration036;
