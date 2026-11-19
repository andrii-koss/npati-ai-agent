import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { assertMember, businessCredentialScopeSql, getBusiness } from "./postgres-store-support";
import { goalColumns } from "./postgres-store-schema";
import { WorkspaceAccessError } from "./types";
import type { AuthContext, Goal, GoalInput } from "./types";
import { GOALS_PAGE_SIZE, goalPageCursor, type GoalCounts, type GoalPage, type GoalPageQuery } from "./goals-page";

export async function listGoals(pool: Pool, context: AuthContext, businessId: string) {
    await getBusiness(pool, context, businessId);
    const goals = (await pool.query<Goal>(`SELECT ${goalColumns} FROM goals WHERE workspace_id=$1 AND business_id=$2 ORDER BY priority, updated_at DESC`, [context.workspaceId, businessId])).rows;
    return withAssignedAgents(pool, context, goals);
  }

export async function listGoalPage(pool: Pool, context: AuthContext, query: GoalPageQuery): Promise<GoalPage> {
  if (query.businessId) await getBusiness(pool, context, query.businessId);
  else await assertMember(pool, context);
  const result = await pool.query<{ goals: Goal[]; counts: GoalCounts | null }>(
    `WITH scope AS MATERIALIZED (
      SELECT id, created_at, status, priority, title, description, target_unit
      FROM goals
      WHERE workspace_id=$1 AND business_id IN (
        SELECT id FROM businesses WHERE workspace_id=$1 AND owner_user_id=$2
          AND ${businessCredentialScopeSql(3)}
          AND (($4::text IS NULL AND activation_status='active') OR id=$4)
      )
    ), page AS (
      SELECT ${goalColumns}
      FROM goals WHERE id IN (
        SELECT id FROM scope
        WHERE ($5::text IS NULL OR status=$5)
          AND ($6::integer IS NULL OR priority=$6)
          AND ($7::text IS NULL OR strpos(lower(title), lower($7)) > 0
            OR strpos(lower(description), lower($7)) > 0
            OR strpos(lower(target_unit), lower($7)) > 0)
          AND ($8::timestamptz IS NULL OR (date_trunc('milliseconds',created_at),id) < ($8,$9::text))
        ORDER BY date_trunc('milliseconds',created_at) DESC, id DESC LIMIT $10
      )
    )
    SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY date_trunc('milliseconds',"createdAt") DESC, id DESC), '[]'::jsonb) FROM page) AS goals,
      CASE WHEN $8::timestamptz IS NULL THEN (
        SELECT jsonb_build_object('total',count(*),'active',count(*) FILTER (WHERE status='active'),
          'paused',count(*) FILTER (WHERE status='paused'),'completed',count(*) FILTER (WHERE status='completed'),
          'highPriority',count(*) FILTER (WHERE priority=1))
        FROM scope
      ) END AS counts`,
    [context.workspaceId, context.userId, context.companyId ?? null, query.businessId ?? null, query.status ?? null,
      query.priority ?? null, query.search || null, query.after?.createdAt ?? null, query.after?.id ?? null, GOALS_PAGE_SIZE + 1],
  );
  const { goals, counts } = result.rows[0]!;
  const items = await withAssignedAgents(pool, context, goals.slice(0, GOALS_PAGE_SIZE));
  return { goals: items, counts, nextCursor: goals.length > GOALS_PAGE_SIZE ? goalPageCursor(items.at(-1)!) : null };
}

async function withAssignedAgents(pool: Pool, context: AuthContext, goals: Goal[]) {
    const ids = [...new Set(goals.map((goal) => goal.assignedAgentId).filter((id): id is string => Boolean(id)))];
    if (!ids.length) return goals;
    const agents = new Map((await pool.query<{ id: string; name: string; role: string; companyName: string }>(
      `SELECT a.id, a.name, a.role, c.name AS "companyName" FROM company_agents a JOIN companies c ON c.id=a.company_id
       WHERE a.id = ANY($1::text[]) AND a.workspace_id=$2 AND c.workspace_id=$2 AND c.user_id=$3`, [ids, context.workspaceId, context.userId])).rows.map((row) => [row.id, row]));
    return goals.map((goal) => {
      const agent = goal.assignedAgentId ? agents.get(goal.assignedAgentId) : undefined;
      return { ...goal, assignedAgent: agent ? { name: agent.name, role: agent.role, companyName: agent.companyName } : null };
    });
  }

/** An assigned goal agent must belong to a company owned by the same user in this workspace. */
async function assertGoalAgent(pool: Pool, context: AuthContext, agentId: string | null | undefined) {
    if (!agentId) return;
    const owned = await pool.query("SELECT 1 FROM company_agents a JOIN companies c ON c.id=a.company_id WHERE a.id=$1 AND a.workspace_id=$2 AND c.workspace_id=$2 AND c.user_id=$3", [agentId, context.workspaceId, context.userId]);
    if (!owned.rowCount) throw new WorkspaceAccessError("Assigned agent is not available");
  }

export async function createGoal(pool: Pool, context: AuthContext, businessId: string, input: GoalInput) {
    await getBusiness(pool, context, businessId);
    await assertGoalAgent(pool, context, input.assignedAgentId);
    const values = [randomUUID(), context.workspaceId, businessId, context.userId, input.title.trim(), input.description ?? null, input.status ?? "active", input.targetValue ?? null, input.targetUnit ?? null, input.currentValue ?? null, input.targetDate ?? null, input.priority ?? 3, input.assignedAgentId ?? null];
    const result = await pool.query<Goal>(`INSERT INTO goals(id,workspace_id,business_id,created_by_user_id,title,description,status,target_value,target_unit,current_value,target_date,priority,assigned_agent_id)
      VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING ${goalColumns}`, values);
    return result.rows[0]!;
  }

export async function updateGoal(pool: Pool, context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>) {
    await getBusiness(pool, context, businessId);
    await assertGoalAgent(pool, context, input.assignedAgentId);
    // assignedAgentId: undefined keeps the assignment, null clears it, an ID sets it.
    const values = [goalId, context.workspaceId, businessId, input.title, input.description, input.status, input.targetValue, input.targetUnit, input.currentValue, input.targetDate, input.priority, input.assignedAgentId !== undefined, input.assignedAgentId];
    const result = await pool.query<Goal>(`UPDATE goals SET title=COALESCE($4,title),description=COALESCE($5,description),status=COALESCE($6,status),target_value=COALESCE($7,target_value),target_unit=COALESCE($8,target_unit),current_value=COALESCE($9,current_value),target_date=COALESCE($10,target_date),priority=COALESCE($11,priority),assigned_agent_id=CASE WHEN $12::boolean THEN $13 ELSE assigned_agent_id END,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING ${goalColumns}`, values.map((value) => value === undefined ? null : value));
    if (!result.rowCount) throw new WorkspaceAccessError("Goal is not available for this business");
    return result.rows[0]!;
  }

export async function deleteGoal(pool: Pool, context: AuthContext, businessId: string, goalId: string) {
    await getBusiness(pool, context, businessId);
    return Boolean((await pool.query("DELETE FROM goals WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING id", [goalId, context.workspaceId, businessId])).rowCount);
  }
