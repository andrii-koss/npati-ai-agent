import type { PoolClient } from "pg";

export async function runMigration052(client:PoolClient):Promise<void>{
  await client.query(`
    UPDATE messaging_connections
    SET settings=jsonb_set(
      settings,'{slack}',COALESCE(settings->'slack','{"dmPolicy":"pairing","allowedUserIds":[],"allowedWorkspaceIds":[],"allowedChannelIds":[],"requireMention":true,"channelBindings":[]}'::jsonb),true
    );
    ALTER TABLE messaging_connections ALTER COLUMN settings SET DEFAULT '{
      "access":{"allowedUserIds":[],"selfChat":false},
      "discord":{"dmPolicy":"pairing","allowedUserIds":[],"allowedGuildIds":[],"allowedChannelIds":[],"allowedRoleIds":[],"requireMention":true,"channelBindings":[]},
      "slack":{"dmPolicy":"pairing","allowedUserIds":[],"allowedWorkspaceIds":[],"allowedChannelIds":[],"requireMention":true,"channelBindings":[]},
      "groups":{"enabled":true,"allowedChatIds":[],"mentionRequired":true,"replyMode":"reply"},
      "notifications":{"automationResults":true,"backgroundResults":true,"errors":true,"status":true},
      "media":{"images":true,"documents":true,"audio":true,"outbound":true},
      "delivery":{"typing":true,"progressive":true}
    }'::jsonb;
  `);
}
export default runMigration052;