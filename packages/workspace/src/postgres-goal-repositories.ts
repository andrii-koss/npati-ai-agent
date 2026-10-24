import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { getBusiness } from "./postgres-store-support";
import { goalColumns } from "./postgres-store-schema";
import { WorkspaceAccessError } from "./types";
import type { AuthContext, Goal, GoalInput } from "./types";

export async function listGoals(pool: Pool, context: AuthContext, businessId: string) {
    await getBusiness(pool, context, businessId);
    return (await pool.query<Goal>(`SELECT ${goalColumns} FROM goals WHERE workspace_id=$1 AND business_id=$2 ORDER BY priority, updated_at DESC`, [context.workspaceId, businessId])).rows;
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
