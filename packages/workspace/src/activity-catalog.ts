import type { Pool } from "pg";
import { WorkspaceAccessError, type AuthContext, type CodeRunStateRecord, type CompanyAgentRun } from "./types";

export type ActivityAgentRun = Pick<CompanyAgentRun,
  "id" | "companyId" | "projectId" | "task" | "requestedMode" | "executionMode" | "status" |
  "omnirouteComboName" | "totalDurationMs" | "totalTokens" | "totalCost" | "createdAt" | "completedAt"
>;
export type ActivityCodeRun = Pick<CodeRunStateRecord,
  "runId" | "companyId" | "projectId" | "status" | "startedAt" | "finishedAt" | "details" |
  "leaseOwner" | "heartbeatAt" | "leaseExpiresAt" | "turnIndex"
>;
export type ActivityCatalog = {
  companies: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; companyId: string }>;
  agentRuns: ActivityAgentRun[];
  codeRuns: ActivityCodeRun[];
};

export async function readActivityCatalog(pool: Pool, context: AuthContext, companyId?: string): Promise<ActivityCatalog> {
  const result = await pool.query<ActivityCatalog>(`
    WITH member AS (
      SELECT workspace_id,user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2
    ), owned AS (
      SELECT company.id,company.name,company.created_at
      FROM companies company JOIN member USING (workspace_id,user_id)
      WHERE ($3::text IS NULL OR company.id=$3)
    ), scope AS (
      SELECT id FROM owned WHERE ($4::text IS NULL OR id=$4)
    )
    SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY created_at,id) FROM owned),'[]') AS companies,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id',project.id,'companyId',project.company_id))
        FROM projects project JOIN scope ON scope.id=project.company_id
        WHERE project.workspace_id=member.workspace_id AND project.created_by=member.user_id
      ),'[]') AS projects,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id',run.id,'companyId',run.company_id,'projectId',run.project_id,'task',run.task,
          'requestedMode',run.requested_mode,'executionMode',run.execution_mode,'status',run.status,
          'omnirouteComboName',run.omniroute_combo_name,'totalDurationMs',run.total_duration_ms,
          'totalTokens',run.total_tokens,'totalCost',run.total_cost,
          'createdAt',run.created_at,'completedAt',run.completed_at))
        FROM company_agent_runs run JOIN scope ON scope.id=run.company_id
        WHERE run.workspace_id=member.workspace_id AND run.user_id=member.user_id
      ),'[]') AS "agentRuns",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'runId',run.run_id,'companyId',run.company_id,'projectId',run.project_id,
          'status',run.status,'startedAt',run.started_at,'finishedAt',run.finished_at,
          'details',jsonb_build_object('stopReason',run.details->'stopReason'),
          'leaseOwner',run.lease_owner,'heartbeatAt',run.heartbeat_at,
          'leaseExpiresAt',run.lease_expires_at,'turnIndex',run.turn_index))
        FROM code_run_states run
        JOIN scope ON scope.id=run.company_id
        JOIN projects project ON project.id=run.project_id AND project.company_id=run.company_id
          AND project.workspace_id=run.workspace_id
        WHERE run.workspace_id=member.workspace_id AND project.created_by=member.user_id
      ),'[]') AS "codeRuns"
    FROM member
  `, [context.workspaceId, context.userId, context.companyId ?? null, companyId ?? null]);
  const resultRow = result.rows[0];
  if (!resultRow) throw new WorkspaceAccessError("Workspace access denied");
  return resultRow;
}
