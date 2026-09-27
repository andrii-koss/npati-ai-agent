import type { PoolClient } from "pg";

export async function runMigration049(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE messaging_connections ADD COLUMN IF NOT EXISTS provider TEXT;
    UPDATE messaging_connections SET provider=NULL WHERE channel<>'whatsapp';
    UPDATE messaging_connections SET settings=jsonb_set(
      settings, '{access}', COALESCE(settings->'access', '{"allowedUserIds":[]}'::jsonb), true
    );
    ALTER TABLE messaging_connections ALTER COLUMN settings SET DEFAULT '{
      "access":{"allowedUserIds":[]},"groups":{"enabled":true,"allowedChatIds":[],"mentionRequired":true,"replyMode":"reply"},
      "notifications":{"automationResults":true,"backgroundResults":true,"errors":true,"status":true},
      "media":{"images":true,"documents":true,"audio":true,"outbound":true},"delivery":{"typing":true,"progressive":true}
    }'::jsonb;
    ALTER TABLE messaging_connections DROP CONSTRAINT IF EXISTS messaging_connections_provider_check;
    ALTER TABLE messaging_connections ADD CONSTRAINT messaging_connections_provider_check
      CHECK ((channel='whatsapp' AND provider IN ('qr','cloud')) OR (channel<>'whatsapp' AND provider IS NULL)) NOT VALID;
    CREATE INDEX IF NOT EXISTS idx_messaging_connections_whatsapp_restore
      ON messaging_connections(channel,provider,status) WHERE channel='whatsapp';
  `);
}

export default runMigration049;

