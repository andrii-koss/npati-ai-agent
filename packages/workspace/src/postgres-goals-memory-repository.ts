/* The goals-memory domain of the Postgres workspace store, split out in an architectural step of
 * docs/refactoring/PLAN.md.
 *
 * The method bodies are the previous ones with mechanical rewrites only: `this.pool` became the `pool`
 * argument, calls to sibling methods in the same domain pass that pool on, and the shared ownership checks
 * come from postgres-lookups.ts. The facade keeps every public method as a thin delegation.
 */
import { Pool } from "pg";
import { getBusiness, ensureIdentity } from "./postgres-lookups";
import { randomUUID } from "node:crypto";
import { assertNoSecrets } from "@npati/memory";
import type { AuthContext, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem } from "./types";
import { WorkspaceAccessError } from "./types";
import { goalColumns, memoryColumns, conversationColumns } from "./postgres-store-schema";

export async function listGoals(pool: Pool, context: AuthContext, businessId: string) {
    await getBusiness(pool, context, businessId);
    return (await pool.query<Goal>(`SELECT ${goalColumns} FROM goals WHERE workspace_id=$1 AND business_id=$2 ORDER BY priority, updated_at DESC`, [context.workspaceId, businessId])).rows;
  }

export async function createGoal(pool: Pool, context: AuthContext, businessId: string, input: GoalInput) {
    await getBusiness(pool, context, businessId);
    const values = [randomUUID(), context.workspaceId, businessId, context.userId, input.title.trim(), input.description ?? null, input.status ?? "active", input.targetValue ?? null, input.targetUnit ?? null, input.currentValue ?? null, input.targetDate ?? null, input.priority ?? 3];
    const result = await pool.query<Goal>(`INSERT INTO goals(id,workspace_id,business_id,created_by_user_id,title,description,status,target_value,target_unit,current_value,target_date,priority)
      VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING ${goalColumns}`, values);
    return result.rows[0]!;
  }

export async function updateGoal(pool: Pool, context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>) {
    await getBusiness(pool, context, businessId);
    const values = [goalId, context.workspaceId, businessId, input.title, input.description, input.status, input.targetValue, input.targetUnit, input.currentValue, input.targetDate, input.priority];
    const result = await pool.query<Goal>(`UPDATE goals SET title=COALESCE($4,title),description=COALESCE($5,description),status=COALESCE($6,status),target_value=COALESCE($7,target_value),target_unit=COALESCE($8,target_unit),current_value=COALESCE($9,current_value),target_date=COALESCE($10,target_date),priority=COALESCE($11,priority),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING ${goalColumns}`, values.map((value) => value === undefined ? null : value));
    if (!result.rowCount) throw new WorkspaceAccessError("Goal is not available for this business");
    return result.rows[0]!;
  }

export async function deleteGoal(pool: Pool, context: AuthContext, businessId: string, goalId: string) {
    await getBusiness(pool, context, businessId);
    return Boolean((await pool.query("DELETE FROM goals WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING id", [goalId, context.workspaceId, businessId])).rowCount);
  }

export async function listMemory(pool: Pool, context: AuthContext, businessId: string, query = "", limit = 100) {
    await getBusiness(pool, context, businessId);
    const needle = `%${query.trim()}%`;
    return (await pool.query<MemoryItem>(`SELECT ${memoryColumns} FROM memory_items WHERE workspace_id=$1 AND business_id=$2 AND ($3='' OR type ILIKE $4 OR title ILIKE $4 OR content ILIKE $4) ORDER BY updated_at DESC LIMIT $5`, [context.workspaceId, businessId, query.trim(), needle, Math.min(limit, 100)])).rows;
  }

export async function createMemory(pool: Pool, context: AuthContext, businessId: string, input: MemoryInput) {
    await getBusiness(pool, context, businessId); assertNoSecrets(input);
    const values = [randomUUID(), context.workspaceId, businessId, context.userId, input.type, input.title.trim(), input.content.trim(), input.source ?? "user", input.confidence ?? null];
    const result = await pool.query<MemoryItem>(`INSERT INTO memory_items(id,workspace_id,business_id,user_id,type,title,content,source,confidence) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING ${memoryColumns}`, values);
    return result.rows[0]!;
  }

export async function updateMemory(pool: Pool, context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>) {
    await getBusiness(pool, context, businessId); assertNoSecrets(input);
    const values = [memoryId, context.workspaceId, businessId, input.type, input.title, input.content, input.source, input.confidence];
    const result = await pool.query<MemoryItem>(`UPDATE memory_items SET type=COALESCE($4,type),title=COALESCE($5,title),content=COALESCE($6,content),source=COALESCE($7,source),confidence=COALESCE($8,confidence),updated_at=now() WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING ${memoryColumns}`, values.map((value) => value === undefined ? null : value));
    if (!result.rowCount) throw new WorkspaceAccessError("Memory is not available for this business");
    return result.rows[0]!;
  }

export async function deleteMemory(pool: Pool, context: AuthContext, businessId: string, memoryId: string) {
    await getBusiness(pool, context, businessId);
    return Boolean((await pool.query("DELETE FROM memory_items WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING id", [memoryId, context.workspaceId, businessId])).rowCount);
  }

export async function listConversations(pool: Pool, context: AuthContext, businessId: string) {
    await getBusiness(pool, context, businessId);
    return (await pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE workspace_id=$1 AND business_id=$2 AND user_id=$3 ORDER BY updated_at DESC`, [context.workspaceId, businessId, context.userId])).rows;
  }

export async function createConversation(pool: Pool, context: AuthContext, businessId: string, title: string) {
    await getBusiness(pool, context, businessId);
    const result = await pool.query<Conversation>(`INSERT INTO conversations(id,workspace_id,business_id,user_id,title) VALUES ($1,$2,$3,$4,$5) RETURNING ${conversationColumns}`, [randomUUID(), context.workspaceId, businessId, context.userId, title.trim().slice(0, 120) || "New conversation"]);
    return result.rows[0]!;
  }

export async function getConversation(pool: Pool, context: AuthContext, businessId: string, conversationId: string) {
    await getBusiness(pool, context, businessId);
    const result = await pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE id=$1 AND workspace_id=$2 AND business_id=$3 AND user_id=$4`, [conversationId, context.workspaceId, businessId, context.userId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Conversation is not available for this business");
    const messages = (await pool.query<ConversationMessage>(`SELECT id, conversation_id AS "conversationId", role, content, created_at AS "createdAt" FROM messages WHERE conversation_id=$1 ORDER BY created_at`, [conversationId])).rows;
    return { conversation: result.rows[0]!, messages };
  }

export async function updateConversation(pool: Pool, context: AuthContext, businessId: string, conversationId: string, title: string) {
    await getConversation(pool, context, businessId, conversationId);
    const result = await pool.query<Conversation>(
      `UPDATE conversations SET title=$1,updated_at=now() WHERE id=$2 RETURNING ${conversationColumns}`,
      [title.trim().slice(0, 120) || "New conversation", conversationId],
    );
    return result.rows[0]!;
  }

export async function deleteConversation(pool: Pool, context: AuthContext, businessId: string, conversationId: string) {
    await getConversation(pool, context, businessId, conversationId);
    return Boolean((await pool.query("DELETE FROM conversations WHERE id=$1", [conversationId])).rowCount);
  }

export async function appendMessage(pool: Pool, context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string) {
    await getConversation(pool, context, businessId, conversationId);
    const result = await pool.query<ConversationMessage>(`INSERT INTO messages(id,conversation_id,role,content) VALUES ($1,$2,$3,$4) RETURNING id,conversation_id AS "conversationId",role,content,created_at AS "createdAt"`, [randomUUID(), conversationId, role, content]);
    await pool.query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conversationId]);
    return result.rows[0]!;
  }

export async function listNeutralConversations(pool: Pool, context: AuthContext) {
    await ensureIdentity(pool, context);
    return (await pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE workspace_id=$1 AND business_id IS NULL AND user_id=$2 ORDER BY updated_at DESC`, [context.workspaceId, context.userId])).rows;
  }

export async function createNeutralConversation(pool: Pool, context: AuthContext, title: string) {
    await ensureIdentity(pool, context);
    const result = await pool.query<Conversation>(`INSERT INTO conversations(id,workspace_id,business_id,user_id,title) VALUES ($1,$2,NULL,$3,$4) RETURNING ${conversationColumns}`, [randomUUID(), context.workspaceId, context.userId, title.trim().slice(0, 120) || "New conversation"]);
    return result.rows[0]!;
  }

export async function getNeutralConversation(pool: Pool, context: AuthContext, conversationId: string) {
    await ensureIdentity(pool, context);
    const result = await pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE id=$1 AND workspace_id=$2 AND business_id IS NULL AND user_id=$3`, [conversationId, context.workspaceId, context.userId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Conversation is not available to this user");
    const messages = (await pool.query<ConversationMessage>(`SELECT id, conversation_id AS "conversationId", role, content, created_at AS "createdAt" FROM messages WHERE conversation_id=$1 ORDER BY created_at`, [conversationId])).rows;
    return { conversation: result.rows[0]!, messages };
  }

export async function updateNeutralConversation(pool: Pool, context: AuthContext, conversationId: string, title: string) {
    await getNeutralConversation(pool, context, conversationId);
    const result = await pool.query<Conversation>(`UPDATE conversations SET title=$1,updated_at=now() WHERE id=$2 RETURNING ${conversationColumns}`, [title.trim().slice(0, 120) || "New conversation", conversationId]);
    return result.rows[0]!;
  }

export async function deleteNeutralConversation(pool: Pool, context: AuthContext, conversationId: string) {
    await getNeutralConversation(pool, context, conversationId);
    return Boolean((await pool.query("DELETE FROM conversations WHERE id=$1", [conversationId])).rowCount);
  }

export async function appendNeutralMessage(pool: Pool, context: AuthContext, conversationId: string, role: ConversationMessage["role"], content: string) {
    await getNeutralConversation(pool, context, conversationId);
    const result = await pool.query<ConversationMessage>(`INSERT INTO messages(id,conversation_id,role,content) VALUES ($1,$2,$3,$4) RETURNING id,conversation_id AS "conversationId",role,content,created_at AS "createdAt"`, [randomUUID(), conversationId, role, content]);
    await pool.query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conversationId]);
    return result.rows[0]!;
  }
