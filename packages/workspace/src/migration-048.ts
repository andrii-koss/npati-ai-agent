import type { PoolClient } from "pg";

export async function runMigration048(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE messaging_connections ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{
      "groups":{"enabled":true,"allowedChatIds":[],"mentionRequired":true,"replyMode":"reply"},
      "notifications":{"automationResults":true,"backgroundResults":true,"errors":true,"status":true},
      "media":{"images":true,"documents":true,"audio":true,"outbound":true},
      "delivery":{"typing":true,"progressive":true}
    }'::jsonb;
    UPDATE messaging_connections SET settings='{
      "groups":{"enabled":true,"allowedChatIds":[],"mentionRequired":true,"replyMode":"reply"},
      "notifications":{"automationResults":true,"backgroundResults":true,"errors":true,"status":true},
      "media":{"images":true,"documents":true,"audio":true,"outbound":true},
      "delivery":{"typing":true,"progressive":true}
    }'::jsonb WHERE settings IS NULL;
    ALTER TABLE messaging_connections ALTER COLUMN settings SET DEFAULT '{
      "groups":{"enabled":true,"allowedChatIds":[],"mentionRequired":true,"replyMode":"reply"},
      "notifications":{"automationResults":true,"backgroundResults":true,"errors":true,"status":true},
      "media":{"images":true,"documents":true,"audio":true,"outbound":true},
      "delivery":{"typing":true,"progressive":true}
    }'::jsonb;
    ALTER TABLE messaging_connections ALTER COLUMN settings SET NOT NULL;
    ALTER TABLE messaging_connections DROP CONSTRAINT IF EXISTS messaging_connections_settings_object_check;
    ALTER TABLE messaging_connections ADD CONSTRAINT messaging_connections_settings_object_check
      CHECK (jsonb_typeof(settings)='object') NOT VALID;
  `);
}

export default runMigration048;
