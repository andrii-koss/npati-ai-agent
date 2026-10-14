import type { Pool } from "pg";
import type {
  AuthContext,
  Conversation,
  ConversationMessage,
  Goal,
  GoalInput,
  MemoryInput,
  MemoryItem,
  WorkspaceOverview,
} from "./types.js";
import { goalColumns, memoryColumns, type StoredUserSetting } from "./postgres-store-schema.js";
import { assertMember, ensureIdentity, getBusiness } from "./postgres-store-support.js";
import * as company from "./postgres-company-repositories.js";
import * as project from "./postgres-workspace-repositories.js";
import { WorkspaceAccessError } from "./types.js";

async function ensureMemberIdentity(pool: Pool, context: AuthContext): Promise<void> {
  const member = await pool.query(
    "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
    [context.workspaceId, context.userId],
  );
  if (!member.rowCount) {
    await ensureIdentity(pool, context);
  }
}

export async function getUserSetting(
  pool: Pool,
  context: AuthContext,
  key: string,
): Promise<StoredUserSetting | null> {
  await ensureMemberIdentity(pool, context);
  const result = await pool.query<StoredUserSetting & { updated_at: string }>(
    `SELECT setting_key AS key, value, revision,
      updated_at::text AS updated_at FROM workspace_user_settings
      WHERE workspace_id=$1 AND user_id=$2 AND setting_key=$3`,
    [context.workspaceId, context.userId, key],
  );
  const row = result.rows[0];
  return row ? { key: row.key, value: row.value, revision: row.revision, updatedAt: row.updated_at } : null;
}

export async function setUserSetting(
  pool: Pool,
  context: AuthContext,
  key: string,
  value: unknown,
  expectedRevision: number,
): Promise<StoredUserSetting | null> {
  await ensureMemberIdentity(pool, context);
  const parameters = [context.workspaceId, context.userId, key, JSON.stringify(value), expectedRevision];
  const sql = expectedRevision === 0
    ? `INSERT INTO workspace_user_settings(workspace_id,user_id,setting_key,value,revision)
        VALUES ($1,$2,$3,$4::jsonb,1) ON CONFLICT DO NOTHING
        RETURNING setting_key AS key,value,revision,updated_at::text AS updated_at`
    : `UPDATE workspace_user_settings SET value=$4::jsonb,revision=revision+1,updated_at=now()
        WHERE workspace_id=$1 AND user_id=$2 AND setting_key=$3 AND revision=$5
        RETURNING setting_key AS key,value,revision,updated_at::text AS updated_at`;
  const queryParameters = expectedRevision === 0 ? parameters.slice(0, 4) : parameters;
  const result = await pool.query<StoredUserSetting & { updated_at: string }>(sql, queryParameters);
  const row = result.rows[0];
  return row ? { key: row.key, value: row.value, revision: row.revision, updatedAt: row.updated_at } : null;
}

export async function overview(pool: Pool, context: AuthContext): Promise<WorkspaceOverview> {
  await ensureIdentity(pool, context);
  const role = await assertMember(pool, context);
  const businesses = await project.listBusinesses(pool, context);
  const identity = await pool.query(
    `SELECT u.display_name, w.name, wm.current_business_id
      FROM workspace_members wm JOIN users u ON u.id=wm.user_id JOIN workspaces w ON w.id=wm.workspace_id
      WHERE wm.workspace_id=$1 AND wm.user_id=$2`,
    [context.workspaceId, context.userId],
  );
  let currentId = identity.rows[0]?.current_business_id as string | null;
  if (!currentId && businesses.length > 0) {
    currentId = businesses[0]!.id;
    await pool.query(
      "UPDATE workspace_members SET current_business_id=$3 WHERE workspace_id=$1 AND user_id=$2",
      [context.workspaceId, context.userId, currentId],
    );
  }
  const onboardings = await project.listOnboardings(pool, context);
  return {
    user: { id: context.userId, displayName: String(identity.rows[0]?.display_name ?? "Dev User") },
    workspace: { id: context.workspaceId, name: String(identity.rows[0]?.name ?? "My Workspace"), role },
    businesses,
    currentBusiness: businesses.find((business) => business.id === currentId) ?? null,
    onboarding: onboardings[0] ?? null,
    onboardings,
  };
}

export async function listGoals(pool: Pool, context: AuthContext, businessId: string) {
  return company.listGoals(pool, context, businessId);
}

export async function listUserGoals(pool: Pool, context: AuthContext) {
  await assertMember(pool, context);
  const result = await pool.query<Goal>(
    `SELECT ${goalColumns} FROM goals
     WHERE workspace_id=$1 AND (created_by_user_id=$2 OR business_id IN (
       SELECT id FROM businesses WHERE workspace_id=$1 AND owner_user_id=$2
     ))
     ORDER BY priority, updated_at DESC`,
    [context.workspaceId, context.userId],
  );
  return result.rows;
}

export async function createGoal(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  input: GoalInput,
) {
  return company.createGoal(pool, context, businessId, input);
}

export async function linkGoal(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  goalId: string,
) {
  await getBusiness(pool, context, businessId);
  const result = await pool.query<Goal>(
    `UPDATE goals SET business_id=$1, updated_at=now()
     WHERE id=$2 AND workspace_id=$3 AND (created_by_user_id=$4 OR business_id IN (
       SELECT id FROM businesses WHERE workspace_id=$3 AND owner_user_id=$4
     ))
     RETURNING ${goalColumns}`,
    [businessId, goalId, context.workspaceId, context.userId],
  );
  if (!result.rowCount) throw new WorkspaceAccessError("Goal not found or not owned by user");
  return result.rows[0]!;
}

export async function updateGoal(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  goalId: string,
  input: Partial<GoalInput>,
) {
  return company.updateGoal(pool, context, businessId, goalId, input);
}

export async function deleteGoal(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  goalId: string,
) {
  return company.deleteGoal(pool, context, businessId, goalId);
}

export async function listMemory(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  query = "",
  limit = 100,
) {
  return company.listMemory(pool, context, businessId, query, limit);
}

export async function listUserMemories(
  pool: Pool,
  context: AuthContext,
  query = "",
  limit = 100,
) {
  await assertMember(pool, context);
  const needle = `%${query.trim()}%`;
  const result = await pool.query<MemoryItem>(
    `SELECT ${memoryColumns} FROM memory_items
     WHERE workspace_id=$1 AND (user_id=$2 OR business_id IN (
       SELECT id FROM businesses WHERE workspace_id=$1 AND owner_user_id=$2
     )) AND ($3='' OR type ILIKE $4 OR title ILIKE $4 OR content ILIKE $4)
     ORDER BY updated_at DESC LIMIT $5`,
    [context.workspaceId, context.userId, query.trim(), needle, Math.min(limit, 100)],
  );
  return result.rows;
}

export async function createMemory(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  input: MemoryInput,
) {
  return company.createMemory(pool, context, businessId, input);
}

export async function linkMemory(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  memoryId: string,
) {
  await getBusiness(pool, context, businessId);
  const result = await pool.query<MemoryItem>(
    `UPDATE memory_items SET business_id=$1, updated_at=now()
     WHERE id=$2 AND workspace_id=$3 AND (user_id=$4 OR business_id IN (
       SELECT id FROM businesses WHERE workspace_id=$3 AND owner_user_id=$4
     ))
     RETURNING ${memoryColumns}`,
    [businessId, memoryId, context.workspaceId, context.userId],
  );
  if (!result.rowCount) throw new WorkspaceAccessError("Memory item not found or not owned by user");
  return result.rows[0]!;
}

export async function updateMemory(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  memoryId: string,
  input: Partial<MemoryInput>,
) {
  return company.updateMemory(pool, context, businessId, memoryId, input);
}

export async function deleteMemory(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  memoryId: string,
) {
  return company.deleteMemory(pool, context, businessId, memoryId);
}

export async function listConversations(
  pool: Pool,
  context: AuthContext,
  businessId: string,
) {
  return company.listConversations(pool, context, businessId);
}

export async function createConversation(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  title: string,
) {
  return company.createConversation(pool, context, businessId, title);
}

export async function getConversation(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  conversationId: string,
) {
  return company.getConversation(pool, context, businessId, conversationId);
}

export async function updateConversation(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  conversationId: string,
  title: string,
) {
  return company.updateConversation(pool, context, businessId, conversationId, title);
}

export async function deleteConversation(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  conversationId: string,
) {
  return company.deleteConversation(pool, context, businessId, conversationId);
}

export async function appendMessage(
  pool: Pool,
  context: AuthContext,
  businessId: string,
  conversationId: string,
  role: ConversationMessage["role"],
  content: string,
) {
  return company.appendMessage(pool, context, businessId, conversationId, role, content);
}

export async function listNeutralConversations(
  pool: Pool,
  context: AuthContext,
) {
  return company.listNeutralConversations(pool, context);
}

export async function createNeutralConversation(
  pool: Pool,
  context: AuthContext,
  title: string,
) {
  return company.createNeutralConversation(pool, context, title);
}

export async function getNeutralConversation(
  pool: Pool,
  context: AuthContext,
  conversationId: string,
) {
  return company.getNeutralConversation(pool, context, conversationId);
}

export async function updateNeutralConversation(
  pool: Pool,
  context: AuthContext,
  conversationId: string,
  title: string,
) {
  return company.updateNeutralConversation(pool, context, conversationId, title);
}

export async function deleteNeutralConversation(
  pool: Pool,
  context: AuthContext,
  conversationId: string,
) {
  return company.deleteNeutralConversation(pool, context, conversationId);
}

export async function appendNeutralMessage(
  pool: Pool,
  context: AuthContext,
  conversationId: string,
  role: ConversationMessage["role"],
  content: string,
) {
  return company.appendNeutralMessage(pool, context, conversationId, role, content);
}
