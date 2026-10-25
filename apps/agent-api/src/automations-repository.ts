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
  leaseExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
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
  status?: "active" | "paused";
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
  private pool?: Pool;
  private memoryAutomations = new Map<string, CompanyAutomation>();
  private memoryRuns = new Map<string, CompanyAutomationRun[]>();

  constructor(databaseUrl?: string, pool?: Pool) {
    if (pool) {
      this.pool = pool;
    } else if (databaseUrl && databaseUrl.trim().length > 0) {
      this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
    }
  }

  async list(ctx: AuthContext, companyId: string): Promise<CompanyAutomation[]> {
    if (this.pool) {
      const result = await this.pool.query<CompanyAutomation>(
        `SELECT ${autoCols} FROM company_automations
         WHERE workspace_id = $1 AND company_id = $2 AND user_id = $3 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 100`,
        [ctx.workspaceId, companyId, ctx.userId]
      );
      return result.rows;
    }

    return Array.from(this.memoryAutomations.values())
      .filter(
        (a) =>
          a.workspaceId === ctx.workspaceId &&
          a.companyId === companyId &&
          a.userId === ctx.userId &&
          a.status !== "deleted" &&
          !a.deletedAt
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 100);
  }

  async get(ctx: AuthContext, companyId: string, id: string): Promise<CompanyAutomation> {
    if (this.pool) {
      const result = await this.pool.query<CompanyAutomation>(
        `SELECT ${autoCols} FROM company_automations
         WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4 AND deleted_at IS NULL`,
        [id, ctx.workspaceId, companyId, ctx.userId]
      );
      if (!result.rows[0]) throw Object.assign(new Error("Automation not found"), { status: 404 });
      return result.rows[0];
    }

    const item = this.memoryAutomations.get(id);
    if (
      !item ||
      item.workspaceId !== ctx.workspaceId ||
      item.companyId !== companyId ||
      item.userId !== ctx.userId ||
      item.status === "deleted" ||
      item.deletedAt
    ) {
      throw Object.assign(new Error("Automation not found"), { status: 404 });
    }
    return item;
  }

  async create(ctx: AuthContext, companyId: string, input: CreateAutomationInput): Promise<CompanyAutomation> {
    const id = randomUUID();
    const now = new Date().toISOString();

    if (this.pool) {
      const result = await this.pool.query<CompanyAutomation>(
        `INSERT INTO company_automations (
           id, workspace_id, company_id, user_id, agent_id, name, description,
           prompt, cron_expression, timezone, next_run_at, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
          input.nextRunAt || now,
          input.status ?? "active",
        ]
      );
      return result.rows[0]!;
    }

    const item: CompanyAutomation = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      userId: ctx.userId,
      agentId: input.agentId || null,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      prompt: input.prompt.trim(),
      cronExpression: input.cronExpression.trim(),
      timezone: input.timezone || "Europe/Kyiv",
      status: input.status ?? "active",
      lastRunAt: null,
      nextRunAt: input.nextRunAt || now,
      workerId: null,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.memoryAutomations.set(id, item);
    return item;
  }

  async update(ctx: AuthContext, companyId: string, id: string, input: UpdateAutomationInput): Promise<CompanyAutomation> {
    const current = await this.get(ctx, companyId, id);
    const now = new Date().toISOString();

    if (this.pool) {
      const result = await this.pool.query<CompanyAutomation>(
        `UPDATE company_automations SET
           name = COALESCE($5, name),
           description = COALESCE($6, description),
           prompt = COALESCE($7, prompt),
           cron_expression = COALESCE($8, cron_expression),
           timezone = COALESCE($9, timezone),
           agent_id = CASE WHEN $13::boolean THEN $10 ELSE agent_id END,
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
          input.agentId !== undefined,
        ]
      );
      return result.rows[0] || current;
    }

    const updated: CompanyAutomation = {
      ...current,
      name: input.name !== undefined ? input.name.trim() : current.name,
      description: input.description !== undefined ? input.description?.trim() || null : current.description,
      prompt: input.prompt !== undefined ? input.prompt.trim() : current.prompt,
      cronExpression: input.cronExpression !== undefined ? input.cronExpression.trim() : current.cronExpression,
      timezone: input.timezone !== undefined ? input.timezone : current.timezone,
      agentId: input.agentId !== undefined ? input.agentId : current.agentId,
      status: input.status !== undefined ? input.status : current.status,
      nextRunAt: input.nextRunAt !== undefined ? input.nextRunAt : current.nextRunAt,
      updatedAt: now,
    };
    this.memoryAutomations.set(id, updated);
    return updated;
  }

  async delete(ctx: AuthContext, companyId: string, id: string): Promise<boolean> {
    if (this.pool) {
      const result = await this.pool.query(
        `UPDATE company_automations SET status = 'deleted', deleted_at = now(), updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4 AND deleted_at IS NULL`,
        [id, ctx.workspaceId, companyId, ctx.userId]
      );
      return Boolean(result.rowCount);
    }

    const item = await this.get(ctx, companyId, id).catch(() => null);
    if (!item) return false;
    item.status = "deleted";
    item.deletedAt = new Date().toISOString();
    item.updatedAt = item.deletedAt;
    return true;
  }

  async claimDueAutomations(workerId: string, leaseMs = 120000, limit = 10): Promise<CompanyAutomation[]> {
    if (this.pool) {
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

    const now = new Date();
    const nowMs = now.getTime();
    const claimed: CompanyAutomation[] = [];

    for (const item of this.memoryAutomations.values()) {
      if (
        item.status === "active" &&
        !item.deletedAt &&
        new Date(item.nextRunAt).getTime() <= nowMs &&
        (!item.leaseExpiresAt || new Date(item.leaseExpiresAt).getTime() < nowMs)
      ) {
        item.workerId = workerId;
        item.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
        item.updatedAt = now.toISOString();
        claimed.push({ ...item });
        if (claimed.length >= limit) break;
      }
    }

    return claimed;
  }

  async recordRunStart(auto: CompanyAutomation): Promise<CompanyAutomationRun> {
    const id = randomUUID();
    const now = new Date().toISOString();

    if (this.pool) {
      const result = await this.pool.query<CompanyAutomationRun>(
        `INSERT INTO company_automation_runs (id, workspace_id, company_id, automation_id, status)
         VALUES ($1, $2, $3, $4, 'running')
         RETURNING ${runCols}`,
        [id, auto.workspaceId, auto.companyId, auto.id]
      );
      return result.rows[0]!;
    }

    const run: CompanyAutomationRun = {
      id,
      workspaceId: auto.workspaceId,
      companyId: auto.companyId,
      automationId: auto.id,
      status: "running",
      durationMs: 0,
      startedAt: now,
    };
    const list = this.memoryRuns.get(auto.id) || [];
    list.push(run);
    this.memoryRuns.set(auto.id, list);
    return run;
  }

  async recordRunComplete(
    runId: string,
    autoId: string,
    nextRunAt: string,
    resultText: string,
    durationMs: number
  ): Promise<void> {
    const now = new Date().toISOString();

    if (this.pool) {
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
      return;
    }

    const runs = this.memoryRuns.get(autoId);
    if (runs) {
      const run = runs.find((r) => r.id === runId);
      if (run) {
        run.status = "completed";
        run.result = resultText;
        run.durationMs = durationMs;
        run.completedAt = now;
      }
    }

    const auto = this.memoryAutomations.get(autoId);
    if (auto) {
      auto.lastRunAt = now;
      auto.nextRunAt = nextRunAt;
      auto.workerId = null;
      auto.leaseExpiresAt = null;
      auto.updatedAt = now;
    }
  }

  async recordRunFail(
    runId: string,
    autoId: string,
    nextRunAt: string,
    errorMessage: string,
    durationMs: number
  ): Promise<void> {
    const now = new Date().toISOString();

    if (this.pool) {
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
      return;
    }

    const runs = this.memoryRuns.get(autoId);
    if (runs) {
      const run = runs.find((r) => r.id === runId);
      if (run) {
        run.status = "failed";
        run.errorMessage = errorMessage;
        run.durationMs = durationMs;
        run.completedAt = now;
      }
    }

    const auto = this.memoryAutomations.get(autoId);
    if (auto) {
      auto.lastRunAt = now;
      auto.nextRunAt = nextRunAt;
      auto.workerId = null;
      auto.leaseExpiresAt = null;
      auto.updatedAt = now;
    }
  }

  async listRuns(ctx: AuthContext, companyId: string, automationId: string, limit = 20): Promise<CompanyAutomationRun[]> {
    await this.get(ctx, companyId, automationId);

    if (this.pool) {
      const result = await this.pool.query<CompanyAutomationRun>(
        `SELECT ${runCols} FROM company_automation_runs
         WHERE automation_id = $1 AND workspace_id = $2 AND company_id = $3
         ORDER BY started_at DESC LIMIT $4`,
        [automationId, ctx.workspaceId, companyId, Math.min(100, Math.max(1, limit))]
      );
      return result.rows;
    }

    const runs = this.memoryRuns.get(automationId) || [];
    return runs
      .filter((r) => r.workspaceId === ctx.workspaceId && r.companyId === companyId)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, Math.min(100, Math.max(1, limit)));
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => undefined);
    }
  }
}
