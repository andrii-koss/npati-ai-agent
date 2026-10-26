import type { PoolClient } from "pg";

/** Projects page groups projects by what they are for; existing rows get the kind their type and framework imply. */
export async function runMigration096(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'website'
    CHECK (kind IN ('website','web_app','game','mobile_app','api'))`);
  await client.query(`UPDATE projects SET kind = CASE
      WHEN type = 'mobile_app' OR framework = 'Expo' THEN 'mobile_app'
      WHEN type = 'web_app' THEN 'web_app'
      WHEN framework IN ('Express','Fastify','NestJS','FastAPI','Django','Flask','Laravel') THEN 'api'
      ELSE 'website' END
    WHERE kind = 'website'`);
}
export async function rollbackMigration096(client: PoolClient): Promise<void> {
  await client.query("ALTER TABLE projects DROP COLUMN IF EXISTS kind");
}
