import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import { sanitizeExecutionTrace } from "@npati/shared";

export interface ProjectTerminalEvent {
  id: string; workspaceId: string; companyId: string; projectId: string; userId: string;
  runId?: string; agentId?: string; sandboxId: string; processId?: string;
  commandSummary: string; riskLevel: "safe" | "controlled" | "approval";
  status: "completed" | "failed" | "timed_out" | "running" | "stopped";
  exitCode: number | null; output: string; errorCode?: string; durationMs: number; createdAt: string;
}
export class ProjectTerminalEventsRepository {
  private readonly events: ProjectTerminalEvent[] = [];
  constructor(private readonly projects: Pick<ProjectService, "get">, private readonly pool?: Pool) {}
  async append(ctx: AuthContext, companyId: string, projectId: string, input: Omit<ProjectTerminalEvent, "id" | "workspaceId" | "companyId" | "projectId" | "userId" | "createdAt">) {
    await this.projects.get(ctx, companyId, projectId);
    const event: ProjectTerminalEvent = { ...input, id: randomUUID(), workspaceId: ctx.workspaceId, companyId, projectId, userId: ctx.userId, commandSummary: sanitizeExecutionTrace(input.commandSummary).slice(0, 2048), output: sanitizeExecutionTrace(input.output).slice(0, 128_000), errorCode:input.errorCode ? sanitizeExecutionTrace(input.errorCode) : undefined, createdAt: new Date().toISOString() };
    if (this.pool) await this.pool.query(`INSERT INTO project_terminal_events
      (id,workspace_id,company_id,project_id,user_id,run_id,agent_id,sandbox_id,process_id,command_summary,risk_level,status,exit_code,output,error_code,duration_ms,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [event.id,event.workspaceId,event.companyId,event.projectId,event.userId,event.runId ?? null,event.agentId ?? null,event.sandboxId,event.processId ?? null,event.commandSummary,event.riskLevel,event.status,event.exitCode,event.output,event.errorCode ?? null,event.durationMs,event.createdAt]);
    else this.events.push(event);
    return event;
  }
  async list(ctx: AuthContext, companyId: string, projectId: string, limit = 100) {
    await this.projects.get(ctx, companyId, projectId);
    const bounded = Math.max(1, Math.min(limit, 200));
    if (!this.pool) return this.events.filter((event) => event.workspaceId === ctx.workspaceId && event.userId === ctx.userId && event.companyId === companyId && event.projectId === projectId).slice(-bounded).reverse();
    const result = await this.pool.query<ProjectTerminalEvent>(`SELECT id,workspace_id AS "workspaceId",company_id AS "companyId",project_id AS "projectId",user_id AS "userId",
      run_id AS "runId",agent_id AS "agentId",sandbox_id AS "sandboxId",process_id AS "processId",command_summary AS "commandSummary",
      risk_level AS "riskLevel",status,exit_code AS "exitCode",output,error_code AS "errorCode",duration_ms AS "durationMs",created_at::text AS "createdAt"
      FROM project_terminal_events WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3 AND user_id=$4
      ORDER BY created_at DESC,id DESC LIMIT $5`, [ctx.workspaceId,companyId,projectId,ctx.userId,bounded]);
    return result.rows;
  }
}
