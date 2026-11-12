import type { Pool } from "pg";
import { WorkspaceAccessError, type AuthContext, type Conversation, type ConversationMessage } from "./types";
import { conversationColumns } from "./postgres-store-schema";

export async function readOwnedNeutralConversation(pool: Pick<Pool, "query">, ctx: AuthContext, id: string) {
  const conversation = (await pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations
    WHERE id=$1 AND workspace_id=$2 AND business_id IS NULL AND user_id=$3`, [id, ctx.workspaceId, ctx.userId])).rows[0];
  if (!conversation) throw new WorkspaceAccessError("Conversation is not available to this user");
  return conversation;
}

export async function readNeutralMessagePage(pool: Pick<Pool, "query">, ctx: AuthContext, id: string, before?: string, limit = 10) {
  limit = Math.min(50, Math.max(1, Math.trunc(limit) || 10));
  const conversation = await readOwnedNeutralConversation(pool, ctx, id);
  let predicate = "", bounds: unknown[] = [id], numericPosition: number | undefined;
  if (before) {
    if (/^\d+$/.test(before)) {
      numericPosition = Number(before);
      if (!Number.isSafeInteger(numericPosition)) throw new Error("Message cursor is invalid");
    } else {
      const cursor = (await pool.query<{ id: string; at: string }>("SELECT id,created_at::text AS at FROM messages WHERE conversation_id=$1 AND id=$2", [id, before])).rows[0];
      if (!cursor) throw new Error("Message cursor is invalid");
      bounds = [id, cursor.at, cursor.id];
      predicate = " AND (created_at,id)<($2::timestamptz,$3)";
    }
  }
  const count = (await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM messages WHERE conversation_id=$1${predicate}`, bounds)).rows[0]?.total ?? 0;
  const available = numericPosition === undefined ? count : Math.min(numericPosition, count);
  const offset = numericPosition === undefined ? 0 : count - available;
  const size = Math.min(limit, available);
  const messages = (await pool.query<ConversationMessage>(`SELECT id,conversation_id AS "conversationId",role,content,created_at AS "createdAt"
    FROM messages WHERE conversation_id=$1${predicate} ORDER BY created_at DESC,id DESC
    LIMIT $${bounds.length + 1} OFFSET $${bounds.length + 2}`, [...bounds, size, offset])).rows.reverse();
  const earlier = Math.max(0, available - messages.length);
  return { conversation, messages, earlier, cursor: messages[0]?.id ?? null, hasMore: earlier > 0 };
}

export async function readChatSidebarPage(pool: Pick<Pool, "query">, ctx: AuthContext, offset = 0, limit = 20) {
  limit = Math.min(50, Math.max(1, Math.trunc(limit) || 20));
  offset = Math.max(0, Math.trunc(offset) || 0);
  const rows = (await pool.query<Conversation & { businessName: string }>(`SELECT c.id,c.workspace_id AS "workspaceId",c.user_id AS "userId",
    c.business_id AS "businessId",c.title,c.created_at AS "createdAt",c.updated_at AS "updatedAt",coalesce(b.name,'') AS "businessName"
    FROM conversations c LEFT JOIN businesses b ON b.id=c.business_id AND b.workspace_id=c.workspace_id AND b.owner_user_id=$2
      AND b.activation_status='active' AND ($5::text IS NULL OR b.id=(SELECT business_id FROM companies
        WHERE id=$5 AND workspace_id=$1 AND user_id=$2))
    WHERE c.workspace_id=$1 AND c.user_id=$2 AND (c.business_id IS NULL OR b.id IS NOT NULL)
      AND NOT (c.business_id IS NULL AND c.title='Development projects' AND NOT EXISTS
        (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role='user'))
    ORDER BY c.updated_at DESC,c.id ASC LIMIT $3 OFFSET $4`, [ctx.workspaceId, ctx.userId, limit + 1, offset, ctx.companyId ?? null])).rows;
  return { items: rows.slice(0, limit), more: rows.length > limit };
}
