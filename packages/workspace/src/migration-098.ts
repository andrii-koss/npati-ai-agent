import type { PoolClient } from "pg";
export async function runMigration098(client: PoolClient) {
  await client.query(`CREATE INDEX IF NOT EXISTS messages_chat_page_idx ON messages(conversation_id,created_at,id);
    CREATE INDEX IF NOT EXISTS conversations_chat_sidebar_idx ON conversations(workspace_id,user_id,updated_at DESC,id ASC);`);
}
