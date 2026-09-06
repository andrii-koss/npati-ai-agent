import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";

export type AutomationStatus = "active" | "paused" | "deleted";
export type AutomationRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface CompanyAutomation {
  id: string;
  workspaceId: string;
  companyId: string;
  userId: string;
  agentId?: string | null;
  name: string;
  description?: string | null;
  prompt: string;
  cronExpression: string;
  timezone: string;
  status: AutomationStatus;
  lastRunAt?: string | null;
  nextRunAt: string;
  workerId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyAutomationRun {
  id: string;
  workspaceId: string;
  companyId: string;
  automationId: string;
  status: AutomationRunStatus;
  result?: string | null;
  errorMessage?: string | null;
  durationMs: number;
  startedAt: string;
  completedAt?: string | null;
}

export interface CreateAutomationInput {
  name: string;
  description?: string;
  prompt: string;
  cronExpression: string;
  timezone?: string;
  agentId?: string;
  nextRunAt?: string;
}

export interface UpdateAutomationInput {
  name?: string;
  description?: string;
  prompt?: string;
  cronExpression?: string;
  timezone?: string;
  agentId?: string | null;
  status?: AutomationStatus;
  nextRunAt?: string;
}

const autoCols = `id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
  agent_id AS "agentId", name, description, prompt, cron_expression AS "cronExpression",
  timezone, status, last_run_at AS "lastRunAt", next_run_at AS "nextRunAt",
  worker_id AS "workerId", created_at AS "createdAt", updated_at AS "updatedAt"`;

const runCols = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  automation_id AS "automationId", status, result, error_message AS "errorMessage",
  duration_ms AS "durationMs", started_at AS "startedAt", completed_at AS "completedAt"`;

export class CompanyAutomationsRepository {
  private pool: Pool;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }

  async list(ctx: AuthContext, companyId: string): Promise<CompanyAutomation[]> {
    const result = await this.pool.query<CompanyAutomation>(
      `SELECT ${autoCols} FROM company_automations
       WHERE workspace_id = $1 AND company_id = $2 AND user_id = $3 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 100`,
      [ctx.workspaceId, companyId, ctx.userId]
    );
    return result.rows;
  }

  async get(ctx: AuthContext, companyId: string, id: string): Promise<CompanyAutomation> {
    const result = await this.pool.query<CompanyAutomation>(
      `SELECT ${autoCols} FROM company_automations
       WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4 AND deleted_at IS NULL`,
      [id, ctx.workspaceId, companyId, ctx.userId]
    );
    if (!result.rows[0]) throw Object.assign(new Error("Automation not found"), { status: 404 });
    return result.rows[0];
  }

  async create(ctx: AuthContext, companyId: string, input: CreateAutomationInput): Promise<CompanyAutomation> {
    const id = randomUUID();
    const result = await this.pool.query<CompanyAutomation>(
      `INSERT INTO company_automations (
         id, workspace_id, company_id, user_id, agent_id, name, description,
         prompt, cron_expression, timezone, next_run_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${autoCols}`,
      [
        id,
        ctx.workspaceId,
        companyId,
        ctx.userId,
        input.agentId || null,
        input.name.trim(),
        input.description?.trim() || null,
        input.prompt.trim(),
        input.cronExpression.trim(),
        input.timezone || "Europe/Kyiv",
        input.nextRunAt || new Date().toISOString(),
      ]
    );
    return result.rows[0]!;
  }

  async update(ctx: AuthContext, companyId: string, id: string, input: UpdateAutomationInput): Promise<CompanyAutomation> {
    const current = await this.get(ctx, companyId, id);
    const result = await this.pool.query<CompanyAutomation>(
      `UPDATE company_automations SET
         name = COALESCE($5, name),
         description = COALESCE($6, description),
         prompt = COALESCE($7, prompt),
         cron_expression = COALESCE($8, cron_expression),
         timezone = COALESCE($9, timezone),
         agent_id = CASE WHEN $10::text IS NOT NULL THEN $10 ELSE agent_id END,
         status = COALESCE($11, status),
         next_run_at = COALESCE($12, next_run_at),
         updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4 AND deleted_at IS NULL
       RETURNING ${autoCols}`,
      [
        id,
        ctx.workspaceId,
        companyId,
        ctx.userId,
        input.name?.trim() ?? null,
        input.description?.trim() ?? null,
        input.prompt?.trim() ?? null,
        input.cronExpression?.trim() ?? null,
        input.timezone ?? null,
        input.agentId !== undefined ? input.agentId : null,
        input.status ?? null,
        input.nextRunAt ?? null,
      ]
    );
    return result.rows[0] || current;
  }

  async delete(ctx: AuthContext, companyId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE company_automations SET status = 'deleted', deleted_at = now(), updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4 AND deleted_at IS NULL`,
      [id, ctx.workspaceId, companyId, ctx.userId]
    );
    return Boolean(result.rowCount);
  }

  async claimDueAutomations(workerId: string, leaseMs = 120000, limit = 10): Promise<CompanyAutomation[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<CompanyAutomation>(
        `SELECT ${autoCols} FROM company_automations
         WHERE status = 'active' AND deleted_at IS NULL
           AND next_run_at <= now()
           AND (lease_expires_at IS NULL OR lease_expires_at < now())
         ORDER BY next_run_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit]
      );
      if (due.rows.length === 0) {
        await client.query("COMMIT");
        return [];
      }
      const ids = due.rows.map((row) => row.id);
      await client.query(
        `UPDATE company_automations SET
           worker_id = $1,
           lease_expires_at = now() + ($2 || ' milliseconds')::interval,
           updated_at = now()
         WHERE id = ANY($3)`,
        [workerId, leaseMs, ids]
      );
      await client.query("COMMIT");
      return due.rows;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async recordRunStart(auto: CompanyAutomation): Promise<CompanyAutomationRun> {
    const id = randomUUID();
    const result = await this.pool.query<CompanyAutomationRun>(
      `INSERT INTO company_automation_runs (id, workspace_id, company_id, automation_id, status)
       VALUES ($1, $2, $3, $4, 'running')
       RETURNING ${runCols}`,
      [id, auto.workspaceId, auto.companyId, auto.id]
    );
    return result.rows[0]!;
  }

  async recordRunComplete(
    runId: string,
    autoId: string,
    nextRunAt: string,
    resultText: string,
    durationMs: number
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE company_automation_runs SET
           status = 'completed',
           result = $2,
           duration_ms = $3,
           completed_at = now()
         WHERE id = $1`,
        [runId, resultText.slice(0, 50000), durationMs]
      );
      await client.query(
        `UPDATE company_automations SET
           last_run_at = now(),
           next_run_at = $2,
           worker_id = NULL,
           lease_expires_at = NULL,
           updated_at = now()
         WHERE id = $1`,
        [autoId, nextRunAt]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async recordRunFail(
    runId: string,
    autoId: string,
    nextRunAt: string,
    errorMessage: string,
    durationMs: number
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE company_automation_runs SET
           status = 'failed',
           error_message = $2,
           duration_ms = $3,
           completed_at = now()
         WHERE id = $1`,
        [runId, errorMessage.slice(0, 2000), durationMs]
      );
      await client.query(
        `UPDATE company_automations SET
           last_run_at = now(),
           next_run_at = $2,
           worker_id = NULL,
           lease_expires_at = NULL,
           updated_at = now()
         WHERE id = $1`,
        [autoId, nextRunAt]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async listRuns(ctx: AuthContext, companyId: string, automationId: string, limit = 20): Promise<CompanyAutomationRun[]> {
    // Verify ownership
    await this.get(ctx, companyId, automationId);
    const result = await this.pool.query<CompanyAutomationRun>(
      `SELECT ${runCols} FROM company_automation_runs
       WHERE automation_id = $1 AND workspace_id = $2 AND company_id = $3
       ORDER BY started_at DESC LIMIT $4`,
      [automationId, ctx.workspaceId, companyId, Math.min(100, Math.max(1, limit))]
    );
    return result.rows;
  }

  async close() {
    await this.pool.end();
  }
}
