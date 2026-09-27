import type { PoolClient } from "pg";

export async function runMigration050(client: PoolClient): Promise<void> {
  await client.query(`
    UPDATE messaging_connections
    SET settings=jsonb_set(
      settings,
      '{access}',
      COALESCE(settings->'access', '{"allowedUserIds":[]}'::jsonb) ||
        jsonb_build_object('selfChat', COALESCE((settings->'access'->>'selfChat')::boolean, false)),
      true
    );
    ALTER TABLE messaging_connections ALTER COLUMN settings SET DEFAULT '{
      "access":{"allowedUserIds":[],"selfChat":false},"groups":{"enabled":true,"allowedChatIds":[],"mentionRequired":true,"replyMode":"reply"},
      "notifications":{"automationResults":true,"backgroundResults":true,"errors":true,"status":true},
      "media":{"images":true,"documents":true,"audio":true,"outbound":true},"delivery":{"typing":true,"progressive":true}
    }'::jsonb;
  `);
}

export default runMigration050;
