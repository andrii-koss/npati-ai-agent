/* The agent-graph domain of the Postgres workspace store, split out in an architectural step of
 * docs/refactoring/PLAN.md.
 *
 * The method bodies are the previous ones with mechanical rewrites only: `this.pool` became the `pool`
 * argument, calls to sibling methods in the same domain pass that pool on, and the shared ownership checks
 * come from postgres-lookups.ts. The facade keeps every public method as a thin delegation.
 */
import { Pool } from "pg";
import { assertCompany } from "./postgres-lookups";
import { randomUUID } from "node:crypto";
import type { AuthContext, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentInput, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, CompanyMember, CompanyInvite, CompanyInviteInput, UpdateCompanyMemberRoleInput, RemoveCompanyMemberInput } from "./types";
import { isCompanyRole } from "./types";
import { CompanyMembershipError, WorkspaceAccessError, WorkspaceNotFoundError } from "./types";
import { companyPageLimit, decodeBusinessCursor, encodeBusinessCursor } from "./pagination";
import { companyAgentColumns, companyEdgeColumns, companyRunColumns, companyRunStepColumns, companyToolAuditColumns, companyRunEventColumns, companyMemberColumns, companyInviteColumns, lastActiveOwnerPredicate } from "./postgres-store-schema";

export async function listCompanyAgents(pool: Pool, context: AuthContext, companyId: string) {
    await assertCompany(pool, context, companyId);
    return (await pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE workspace_id=$1 AND company_id=$2 ORDER BY sort_order,created_at,id`, [context.workspaceId, companyId])).rows;
  }

export async function listCompanyAgentsPage(pool: Pool, context: AuthContext, companyId: string, requestedLimit = 50, cursor?: string) {
    await assertCompany(pool, context, companyId);
    const limit = companyPageLimit(requestedLimit), after = decodeBusinessCursor(cursor);
    const result = await pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::timestamptz IS NULL OR (created_at,id) > ($3::timestamptz,$4::text))
      ORDER BY created_at,id LIMIT $5`, [context.workspaceId, companyId, after?.createdAt ?? null, after?.id ?? "", limit + 1]);
    const items = result.rows.slice(0, limit), last = items.at(-1);
    return { items, nextCursor: result.rows.length > limit && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

export async function assertProjectAgent(pool: Pool, context: AuthContext, companyId: string, agentId?: string) {
    if (!agentId) return;
    const result = await pool.query("SELECT 1 FROM company_agents WHERE id=$1 AND workspace_id=$2 AND company_id=$3", [agentId, context.workspaceId, companyId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Agent does not belong to this company");
  }

export async function getCompanyAgent(pool: Pool, context: AuthContext, companyId: string, agentId: string) {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3`, [agentId, context.workspaceId, companyId]);
    if (!result.rowCount) throw new WorkspaceNotFoundError("Agent was not found in this company");
    return result.rows[0]!;
  }

export async function createCompanyAgent(pool: Pool, context: AuthContext, companyId: string, input: CompanyAgentInput, idempotencyKey: string) {
    await assertCompany(pool, context, companyId);
    const name = input.name?.trim(), role = input.role?.trim();
    if (!name || !role) throw new Error("Agent name and role are required");
    const values = [randomUUID(), context.workspaceId, companyId, name, role, input.description ?? null,
      input.systemInstruction ?? null, input.promptGuidelines ?? null, JSON.stringify(input.recommendedPrompts ?? []),
      input.modelId ?? null, input.fallbackModelId ?? null, JSON.stringify(input.tools ?? []), input.isActive ?? true,
      input.positionX ?? null, input.positionY ?? null, input.sortOrder ?? 0, idempotencyKey];
    const result = await pool.query<CompanyAgent>(`INSERT INTO company_agents(
      id,workspace_id,company_id,name,role,description,system_instruction,prompt_guidelines,recommended_prompts,
      model_id,fallback_model_id,tools_json,is_active,position_x,position_y,sort_order,create_request_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)
      ON CONFLICT (workspace_id,company_id,create_request_key) WHERE create_request_key IS NOT NULL DO NOTHING
      RETURNING ${companyAgentColumns}`, values);
    const agent = result.rows[0] ?? (await pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE workspace_id=$1 AND company_id=$2 AND create_request_key=$3`, [context.workspaceId, companyId, idempotencyKey])).rows[0];
    if (!agent) throw new Error("Could not create company agent");
    return agent;
  }

export async function updateCompanyAgent(pool: Pool, context: AuthContext, companyId: string, agentId: string, input: Partial<CompanyAgentInput>, expectedRevision: number) {
    await getCompanyAgent(pool, context, companyId, agentId);
    if (input.name !== undefined && !input.name.trim()) throw new Error("Agent name is required");
    if (input.role !== undefined && !input.role.trim()) throw new Error("Agent role is required");
    const patch = JSON.stringify(input);
    const result = await pool.query<CompanyAgent>(`UPDATE company_agents SET
      name=CASE WHEN $4::jsonb ? 'name' THEN trim($4::jsonb->>'name') ELSE name END,
      role=CASE WHEN $4::jsonb ? 'role' THEN trim($4::jsonb->>'role') ELSE role END,
      description=CASE WHEN $4::jsonb ? 'description' THEN NULLIF($4::jsonb->>'description','') ELSE description END,
      system_instruction=CASE WHEN $4::jsonb ? 'systemInstruction' THEN NULLIF($4::jsonb->>'systemInstruction','') ELSE system_instruction END,
      prompt_guidelines=CASE WHEN $4::jsonb ? 'promptGuidelines' THEN NULLIF($4::jsonb->>'promptGuidelines','') ELSE prompt_guidelines END,
      recommended_prompts=CASE WHEN $4::jsonb ? 'recommendedPrompts' THEN $4::jsonb->'recommendedPrompts' ELSE recommended_prompts END,
      model_id=CASE WHEN $4::jsonb ? 'modelId' THEN NULLIF($4::jsonb->>'modelId','') ELSE model_id END,
      fallback_model_id=CASE WHEN $4::jsonb ? 'fallbackModelId' THEN NULLIF($4::jsonb->>'fallbackModelId','') ELSE fallback_model_id END,
      tools_json=CASE WHEN $4::jsonb ? 'tools' THEN $4::jsonb->'tools' ELSE tools_json END,
      is_active=CASE WHEN $4::jsonb ? 'isActive' THEN ($4::jsonb->>'isActive')::boolean ELSE is_active END,
      position_x=CASE WHEN $4::jsonb ? 'positionX' THEN ($4::jsonb->>'positionX')::double precision ELSE position_x END,
      position_y=CASE WHEN $4::jsonb ? 'positionY' THEN ($4::jsonb->>'positionY')::double precision ELSE position_y END,
      sort_order=CASE WHEN $4::jsonb ? 'sortOrder' THEN ($4::jsonb->>'sortOrder')::integer ELSE sort_order END,
      revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND revision=$5 RETURNING ${companyAgentColumns}`,
      [agentId, context.workspaceId, companyId, patch, expectedRevision]);
    if (!result.rowCount) throw new Error("Agent was changed by another request. Reload and try again.");
    return result.rows[0]!;
  }

export async function listCompanyAgentEdges(pool: Pool, context: AuthContext, companyId: string, agentIds?: string[]) {
    await assertCompany(pool, context, companyId);
    const filter = agentIds?.length ? [...new Set(agentIds)] : null;
    return (await pool.query<CompanyAgentEdge>(`SELECT ${companyEdgeColumns} FROM company_agent_edges
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::text[] IS NULL OR parent_agent_id=ANY($3::text[]) OR child_agent_id=ANY($3::text[]))
      ORDER BY created_at,id`, [context.workspaceId, companyId, filter])).rows;
  }

export async function createCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, input: { task: string; requestedMode: "auto" | "single" | "pipeline" | "fusion"; projectId?: string }, idempotencyKey: string) {
    const company = await assertCompany(pool, context, companyId);
    if (!company.mainAgentId) throw new Error("Select an active Main Agent before running the company");
    const mainAgent = await getCompanyAgent(pool, context, companyId, company.mainAgentId);
    if (!mainAgent.isActive) throw new Error("The Main Agent is inactive");
    const task = input.task?.trim();
    if (!task) throw new Error("Company task is required");
    const timestamp = new Date().toISOString();
    const snapshot = {
      contextType: "company",
      workspaceId: context.workspaceId,
      userId: context.userId,
      companyId,
      businessId: null,
      agentId: mainAgent.id,
      companyRevision: company.revision,
      capturedAt: timestamp,
    };
    const result = await pool.query<CompanyAgentRun>(`INSERT INTO company_agent_runs(
      id,workspace_id,company_id,project_id,user_id,main_agent_id,idempotency_key,task,requested_mode,context_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (workspace_id,company_id,user_id,idempotency_key) DO NOTHING
      RETURNING ${companyRunColumns}`,
      [randomUUID(), context.workspaceId, companyId, input.projectId ?? null, context.userId, mainAgent.id, idempotencyKey, task, input.requestedMode, JSON.stringify(snapshot)]);
    if (result.rows[0]) return { run: result.rows[0], created: true };
    const existing = await pool.query<CompanyAgentRun>(`SELECT ${companyRunColumns} FROM company_agent_runs
      WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND idempotency_key=$4`,
      [context.workspaceId, companyId, context.userId, idempotencyKey]);
    if (!existing.rows[0]) throw new Error("Could not create company agent run");
    return { run: existing.rows[0], created: false };
  }

export async function listCompanyAgentRuns(pool: Pool, context: AuthContext, companyId: string, limit = 50, filter?: { projectId?: string }) {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<CompanyAgentRun>(
      `SELECT ${companyRunColumns} FROM company_agent_runs
       WHERE workspace_id=$1 AND company_id=$2 AND ($4::text IS NULL OR project_id=$4)
       ORDER BY created_at DESC LIMIT $3`,
      [context.workspaceId, companyId, Math.max(1, Math.min(100, limit)), filter?.projectId ?? null]
    );
    return result.rows;
  }

export async function getCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, runId: string) {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<CompanyAgentRun>(`SELECT ${companyRunColumns} FROM company_agent_runs
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`, [runId, context.workspaceId, companyId, context.userId]);
    if (!result.rows[0]) throw new WorkspaceAccessError("Agent run is not available in this company");
    const [steps, toolAudit, backgroundEvents] = await Promise.all([
      pool.query<CompanyAgentRunStep>(`SELECT ${companyRunStepColumns} FROM company_agent_run_steps
        WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 ORDER BY step_order,lane,id`, [context.workspaceId, companyId, runId]),
      pool.query<CompanyAgentToolAudit>(`SELECT ${companyToolAuditColumns} FROM company_agent_tool_audit
        WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 ORDER BY created_at,id`, [context.workspaceId, companyId, runId]),
      pool.query<CompanyAgentRunEvent>(`SELECT ${companyRunEventColumns} FROM company_agent_run_events
        WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 ORDER BY created_at,id`, [context.workspaceId, companyId, runId]),
    ]);
    const run = result.rows[0];
    const completionStatus = run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? run.status : undefined;
    return { run, steps: steps.rows, toolAudit: toolAudit.rows, backgroundEvents: backgroundEvents.rows,
      completionReport: completionStatus && run.completedAt ? { runId: run.id, companyId: run.companyId, status: completionStatus,
        result: run.result, errorCode: run.errorCode, errorMessage: run.errorMessage, workerId: run.workerId,
        attemptCount: run.attemptCount, totalCost: run.totalCost ?? 0, totalTokens: run.totalTokens ?? 0,
        totalDurationMs: run.totalDurationMs ?? 0, completedAt: run.completedAt } : undefined };
  }

export async function getCompanyRunPendingPlan(pool: Pool, context: AuthContext, companyId: string, runId: string): Promise<unknown | null> {
    await getCompanyAgentRun(pool, context, companyId, runId);
    const result = await pool.query<{ pending_plan: unknown }>("SELECT pending_plan FROM company_agent_runs WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4", [runId, context.workspaceId, companyId, context.userId]);
    return result.rows[0]?.pending_plan ?? null;
  }

export async function setCompanyRunPendingPlan(pool: Pool, context: AuthContext, companyId: string, runId: string, plan: unknown | null): Promise<void> {
    await getCompanyAgentRun(pool, context, companyId, runId);
    await pool.query("UPDATE company_agent_runs SET pending_plan=$5::jsonb,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4", [runId, context.workspaceId, companyId, context.userId, plan === null ? null : JSON.stringify(plan)]);
  }

export async function updateCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, runId: string, patch: Partial<CompanyAgentRun>) {
    await getCompanyAgentRun(pool, context, companyId, runId);
    const value = JSON.stringify(patch);
    const result = await pool.query<CompanyAgentRun>(`UPDATE company_agent_runs SET
      status=CASE WHEN $5::jsonb ? 'status' THEN $5::jsonb->>'status' ELSE status END,
      execution_mode=CASE WHEN $5::jsonb ? 'executionMode' THEN NULLIF($5::jsonb->>'executionMode','') ELSE execution_mode END,
      selected_agent_ids=CASE WHEN $5::jsonb ? 'selectedAgentIds' THEN $5::jsonb->'selectedAgentIds' ELSE selected_agent_ids END,
      omniroute_task_id=CASE WHEN $5::jsonb ? 'omnirouteTaskId' THEN NULLIF($5::jsonb->>'omnirouteTaskId','') ELSE omniroute_task_id END,
      omniroute_combo_name=CASE WHEN $5::jsonb ? 'omnirouteComboName' THEN NULLIF($5::jsonb->>'omnirouteComboName','') ELSE omniroute_combo_name END,
      result=CASE WHEN $5::jsonb ? 'result' THEN $5::jsonb->>'result' ELSE result END,
      error_code=CASE WHEN $5::jsonb ? 'errorCode' THEN NULLIF($5::jsonb->>'errorCode','') ELSE error_code END,
      error_message=CASE WHEN $5::jsonb ? 'errorMessage' THEN NULLIF($5::jsonb->>'errorMessage','') ELSE error_message END,
      cancel_requested=CASE WHEN $5::jsonb ? 'cancelRequested' THEN ($5::jsonb->>'cancelRequested')::boolean ELSE cancel_requested END,
      total_cost=CASE WHEN $5::jsonb ? 'totalCost' THEN ($5::jsonb->>'totalCost')::numeric ELSE total_cost END,
      total_tokens=CASE WHEN $5::jsonb ? 'totalTokens' THEN ($5::jsonb->>'totalTokens')::bigint ELSE total_tokens END,
      total_duration_ms=CASE WHEN $5::jsonb ? 'totalDurationMs' THEN ($5::jsonb->>'totalDurationMs')::int ELSE total_duration_ms END,
      started_at=CASE WHEN ($5::jsonb->>'status') IN ('planning','running') THEN COALESCE(started_at,now()) ELSE started_at END,
      completed_at=CASE WHEN ($5::jsonb->>'status') IN ('completed','failed','cancelled') THEN now() WHEN ($5::jsonb->>'status') IN ('planning','running','awaiting_approval') THEN NULL ELSE completed_at END,
      updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4
      RETURNING ${companyRunColumns}`, [runId, context.workspaceId, companyId, context.userId, value]);
    if (!result.rows[0]) throw new WorkspaceAccessError("Agent run is not available in this company");
    return result.rows[0];
  }

export async function replaceCompanyAgentRunSteps(pool: Pool, context: AuthContext, companyId: string, runId: string, steps: Array<Pick<CompanyAgentRunStep, "agentId" | "stepOrder" | "lane" | "role" | "status" | "modelId">>) {
    await getCompanyAgentRun(pool, context, companyId, runId);
    const uniqueAgentIds = [...new Set(steps.map((step) => step.agentId))];
    if (uniqueAgentIds.length !== steps.length) throw new Error("A run cannot contain the same agent twice");
    for (const agentId of uniqueAgentIds) await getCompanyAgent(pool, context, companyId, agentId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [runId]);
      await client.query("DELETE FROM company_agent_run_steps WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3",
        [context.workspaceId, companyId, runId]);
      const rows: CompanyAgentRunStep[] = [];
      for (const step of steps) {
        const result = await client.query<CompanyAgentRunStep>(`INSERT INTO company_agent_run_steps(
          id,workspace_id,company_id,run_id,agent_id,step_order,lane,role,status,model_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${companyRunStepColumns}`,
          [randomUUID(), context.workspaceId, companyId, runId, step.agentId, step.stepOrder, step.lane, step.role, step.status, step.modelId]);
        rows.push(result.rows[0]!);
      }
      await client.query("COMMIT");
      return rows;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

export async function appendCompanyAgentToolAudit(pool: Pool, context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentToolAudit, "agentId" | "toolName" | "decision" | "status" | "inputSummary" | "errorMessage"> & Partial<Pick<CompanyAgentToolAudit, "latencyMs" | "cost" | "tokens" | "reasonCode" | "sequenceNumber">>) {
    await getCompanyAgentRun(pool, context, companyId, runId);
    await getCompanyAgent(pool, context, companyId, entry.agentId);
    const result = await pool.query<CompanyAgentToolAudit>(`INSERT INTO company_agent_tool_audit(
      id,workspace_id,company_id,run_id,agent_id,tool_name,decision,status,input_summary,error_message,
      latency_ms,cost,tokens,reason_code,sequence_number,completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,CASE WHEN $8 IN ('succeeded','failed','blocked') THEN now() END)
      RETURNING ${companyToolAuditColumns}`,
      [randomUUID(), context.workspaceId, companyId, runId, entry.agentId, entry.toolName, entry.decision,
        entry.status, JSON.stringify(entry.inputSummary ?? {}), entry.errorMessage ?? null, entry.latencyMs ?? null,
        entry.cost ?? null, entry.tokens ?? null, entry.reasonCode ?? null, entry.sequenceNumber ?? null]);
    return result.rows[0]!;
  }

export async function appendCompanyAgentRunEvent(pool: Pool, context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentRunEvent, "eventKey" | "eventType" | "runStatus" | "message"> & Partial<Pick<CompanyAgentRunEvent, "workerId" | "attemptCount" | "details">>) {
    const { run } = await getCompanyAgentRun(pool, context, companyId, runId);
    const values = [randomUUID(), context.workspaceId, companyId, runId, entry.eventKey, entry.eventType, entry.runStatus,
      entry.workerId ?? null, entry.attemptCount ?? run.attemptCount, entry.message.slice(0, 1000), JSON.stringify(entry.details ?? {})];
    const inserted = await pool.query<CompanyAgentRunEvent>(`INSERT INTO company_agent_run_events(
      id,workspace_id,company_id,run_id,event_key,event_type,run_status,worker_id,attempt_count,message,details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT (run_id,event_key) DO NOTHING RETURNING ${companyRunEventColumns}`, values);
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await pool.query<CompanyAgentRunEvent>(`SELECT ${companyRunEventColumns} FROM company_agent_run_events
      WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 AND event_key=$4`, [context.workspaceId, companyId, runId, entry.eventKey]);
    if (!existing.rows[0]) throw new Error("Could not append Company background run event");
    return existing.rows[0];
  }

export async function claimCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) {
    await assertCompany(pool, context, companyId);
    const result = await pool.query(`UPDATE company_agent_runs SET worker_id=$5,
      lease_expires_at=now()+($6::text||' milliseconds')::interval,last_heartbeat_at=now(),attempt_count=attempt_count+1,
      status='planning',error_code=NULL,error_message=NULL,completed_at=NULL,started_at=COALESCE(started_at,now()),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND cancel_requested=false
        AND attempt_count < max_attempts AND next_attempt_at <= now()
        AND (status='queued' OR (status IN ('planning','running') AND lease_expires_at < now()))`,
      [runId, context.workspaceId, companyId, context.userId, workerId, leaseMs]);
    return Boolean(result.rowCount);
  }

export async function heartbeatCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) {
    const result = await pool.query(`UPDATE company_agent_runs SET
      lease_expires_at=now()+($6::text||' milliseconds')::interval,last_heartbeat_at=now(),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND worker_id=$5
        AND status IN ('planning','running') AND cancel_requested=false`,
      [runId, context.workspaceId, companyId, context.userId, workerId, leaseMs]);
    return Boolean(result.rowCount);
  }

export async function requeueCompanyAgentRun(pool: Pool, context: AuthContext, companyId: string, runId: string, workerId: string, delayMs: number) {
    const result = await pool.query(`UPDATE company_agent_runs SET status='queued',worker_id=NULL,lease_expires_at=NULL,
      next_attempt_at=now()+($6::text||' milliseconds')::interval,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND worker_id=$5
        AND cancel_requested=false AND attempt_count < max_attempts`,
      [runId, context.workspaceId, companyId, context.userId, workerId, delayMs]);
    return Boolean(result.rowCount);
  }

export async function listRecoverableCompanyAgentRuns(pool: Pool, limit = 200) {
    const safeLimit = Math.max(1, Math.min(1000, limit));
    const result = await pool.query<{ workspaceId: string; userId: string; companyId: string; runId: string }>(`SELECT
      workspace_id AS "workspaceId",user_id AS "userId",company_id AS "companyId",id AS "runId"
      FROM company_agent_runs WHERE cancel_requested=false AND attempt_count < max_attempts AND next_attempt_at <= now()
        AND (status='queued' OR (status IN ('planning','running') AND lease_expires_at < now()))
      ORDER BY created_at LIMIT $1`, [safeLimit]);
    return result.rows.map((row) => ({ context: { workspaceId: row.workspaceId, userId: row.userId,
      permissions: ['workspace:read','business:manage'] }, companyId: row.companyId, runId: row.runId }));
  }

export async function getCompanyMembership(pool: Pool, companyId: string, userId: string): Promise<CompanyMember | null> {
    const result = await pool.query<CompanyMember>(`SELECT ${companyMemberColumns} FROM company_members
      WHERE company_id=$1 AND user_id=$2`, [companyId, userId]);
    return result.rows[0] ?? null;
  }

export async function listCompanyMembers(pool: Pool, companyId: string): Promise<CompanyMember[]> {
    const result = await pool.query<CompanyMember>(`SELECT ${companyMemberColumns} FROM company_members
      WHERE company_id=$1 ORDER BY created_at, id`, [companyId]);
    return result.rows;
  }

export async function countCompanyOwners(pool: Pool, companyId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM company_members
      WHERE company_id=$1 AND role='owner' AND status='active'`, [companyId]);
    return Number(result.rows[0]?.count ?? 0);
  }

export async function createCompanyInvite(pool: Pool, input: CompanyInviteInput): Promise<CompanyInvite> {
    if (!isCompanyRole(input.role)) {
      throw new CompanyMembershipError("invalid_company_role", `Unknown company role: ${String(input.role)}`, { httpStatus: 400 });
    }
    // A token hash is unique (company_invites_token_hash_key): a duplicate must be refused loudly rather
    // than silently reused, because two live invites would share one secret.
    const duplicate = await pool.query("SELECT 1 FROM company_invites WHERE token_hash=$1", [input.tokenHash]);
    if (duplicate.rowCount) {
      throw new CompanyMembershipError("invite_token_conflict", "An invite with this token hash already exists", { httpStatus: 409 });
    }
    const result = await pool.query<CompanyInvite>(`INSERT INTO company_invites
      (id, company_id, email, role, token_hash, expires_at, created_by, accepted_at, created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (token_hash) DO NOTHING
      RETURNING ${companyInviteColumns}`,
      [input.id, input.companyId, input.email, input.role, input.tokenHash, input.expiresAt, input.createdBy,
        input.acceptedAt ?? null, input.createdAt ?? new Date()]);
    if (!result.rows[0]) {
      // The unique index won a race with the check above.
      throw new CompanyMembershipError("invite_token_conflict", "An invite with this token hash already exists", { httpStatus: 409 });
    }
    return result.rows[0];
  }

export async function findCompanyInviteByTokenHash(pool: Pool, tokenHash: string): Promise<CompanyInvite | null> {
    const result = await pool.query<CompanyInvite>(`SELECT ${companyInviteColumns} FROM company_invites
      WHERE token_hash=$1`, [tokenHash]);
    return result.rows[0] ?? null;
  }

export async function updateCompanyMemberRole(pool: Pool, input: UpdateCompanyMemberRoleInput): Promise<CompanyMember> {
    if (!isCompanyRole(input.role)) {
      throw new CompanyMembershipError("invalid_company_role", `Unknown company role: ${String(input.role)}`, { httpStatus: 400 });
    }
    const result = await pool.query<CompanyMember>(`UPDATE company_members
      SET role=$3, revision=revision+1, updated_at=$5
      WHERE company_id=$1 AND user_id=$2 AND revision=$4
        AND NOT (status='active' AND role='owner' AND $3<>'owner'
          AND ${lastActiveOwnerPredicate("$1")})
      RETURNING ${companyMemberColumns}`,
      [input.companyId, input.userId, input.role, input.expectedRevision, input.updatedAt]);
    if (result.rows[0]) return result.rows[0];
    // The guarded write matched nothing: find out why, in the same order the in-memory store reports.
    const current = await getCompanyMembership(pool, input.companyId, input.userId);
    if (!current) {
      throw new CompanyMembershipError("membership_not_found", "User is not a member of this company", { httpStatus: 404 });
    }
    if (current.revision !== input.expectedRevision) {
      throw new CompanyMembershipError(
        "membership_revision_conflict",
        "Company member changed by another request. Reload and try again.",
        {
          httpStatus: 409,
          details: { expectedRevision: input.expectedRevision, actualRevision: current.revision },
        },
      );
    }
    const owners = await countCompanyOwners(pool, input.companyId);
    throw new CompanyMembershipError(
      "last_owner_protected",
      "Cannot demote the only owner of the company",
      { httpStatus: 409, details: { operation: "demote", owners } },
    );
  }

export async function removeCompanyMember(pool: Pool, input: RemoveCompanyMemberInput): Promise<void> {
    const result = await pool.query(`DELETE FROM company_members
      WHERE company_id=$1 AND user_id=$2
        AND NOT (status='active' AND role='owner' AND ${lastActiveOwnerPredicate("$1")})`,
      [input.companyId, input.userId]);
    if (result.rowCount) return;
    // Nothing was deleted: either there was no row, or the only-owner guard refused the delete.
    const current = await getCompanyMembership(pool, input.companyId, input.userId);
    if (!current) return;
    const owners = await countCompanyOwners(pool, input.companyId);
    throw new CompanyMembershipError(
      "last_owner_protected",
      "Cannot remove the only owner of the company",
      { httpStatus: 409, details: { operation: "remove", owners } },
    );
  }
