import type { PoolClient } from "pg";

/** Repair creator memberships omitted by company creation after migration 072. */
export async function runMigration090(client: PoolClient) {
  await client.query(`INSERT INTO company_members (id, company_id, user_id, role, status, accepted_at)
    SELECT 'cm_' || md5(c.id || ':' || c.user_id), c.id, c.user_id, 'owner', 'active', now()
    FROM companies c
    WHERE NOT EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = c.id)
    ON CONFLICT (company_id, user_id) DO NOTHING`);
}
