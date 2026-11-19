import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { goalPageCursor, type AuthContext } from "@npati/workspace";

export type AutomationStatus = "active" | "paused" | "deleted";
export type AutomationRunStatus = "running" | "completed" | "failed" | "cancelled";

/** A run stopped by the user ends as cancelled, not failed (V6 step 12). The executor marks such errors. */
export function automationRunEndStatus(error: unknown): "failed" | "cancelled" {
  return (error as { cancelled?: unknown } | null)?.cancelled === true ? "cancelled" : "failed";
}

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

export type AutomationPageQuery = {
  status?: "active" | "paused";
  search?: string;
  after?: { createdAt: string; id: string };
};

type AutomationCounts = { total: number; active: number; paused: number; agentsCount: number };
type AutomationPageRow = CompanyAutomation & { isRunning: boolean; agentName?: string | null };
const automationPageSize = 10;
function automationPage(items: AutomationPageRow[], counts: AutomationCounts | null) {
  const page = items.slice(0, automationPageSize);
  return { items: page, counts, nextCursor: items.length > automationPageSize ? goalPageCursor(page.at(-1)!) : null };
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

  async listPage(ctx: AuthContext, companyIds: string[], query: AutomationPageQuery,
    readAgent: (companyId: string, agentId: string) => Promise<string | null>) {
    if (this.pool) {
      const result = await this.pool.query<{ items: AutomationPageRow[]; counts: AutomationCounts | null }>(
        `WITH scope AS MATERIALIZED (
          SELECT id, company_id, agent_id, status, created_at FROM company_automations
          WHERE workspace_id=$1 AND user_id=$2 AND company_id=ANY($3::text[]) AND deleted_at IS NULL AND status<>'deleted'
        ), page AS (
          SELECT ${autoCols} FROM company_automations WHERE id IN (
            SELECT id FROM scope
            WHERE ($4::text IS NULL OR status=$4)
              AND ($5::text IS NULL OR EXISTS (
                SELECT 1 FROM company_automations AS entry
                LEFT JOIN company_agents AS agent ON agent.id=entry.agent_id AND agent.workspace_id=$1 AND agent.company_id=entry.company_id
                WHERE entry.id=scope.id AND (
                  strpos(lower(entry.name),lower($5))>0 OR strpos(lower(entry.description),lower($5))>0
                  OR strpos(lower(entry.prompt),lower($5))>0 OR strpos(lower(entry.cron_expression),lower($5))>0
                  OR strpos(lower(COALESCE(agent.name,'main agent')),lower($5))>0)
              ))
              AND ($6::timestamptz IS NULL OR (date_trunc('milliseconds',created_at),id::text) < ($6,$7::text))
            ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $8
          )
        ), display AS (
          SELECT page.*, agent.name AS "agentName", EXISTS (
            SELECT 1 FROM company_automation_runs AS run
            WHERE run.workspace_id=$1 AND run.company_id=page."companyId" AND run.automation_id=page.id AND run.status='running'
          ) AS "isRunning"
          FROM page LEFT JOIN company_agents AS agent ON agent.id=page."agentId" AND agent.workspace_id=$1 AND agent.company_id=page."companyId"
        )
        SELECT
          (SELECT COALESCE(jsonb_agg(to_jsonb(display) ORDER BY date_trunc('milliseconds',"createdAt") DESC,id DESC),'[]'::jsonb) FROM display) AS items,
          CASE WHEN $6::timestamptz IS NULL THEN (
            SELECT jsonb_build_object('total',count(*),'active',count(*) FILTER (WHERE status='active'),
              'paused',count(*) FILTER (WHERE status='paused'),'agentsCount',
              greatest(count(DISTINCT NULLIF(agent_id,'')),sign(count(*)))) FROM scope
          ) END AS counts`,
        [ctx.workspaceId, ctx.userId, companyIds, query.status ?? null, query.search || null,
          query.after?.createdAt ?? null, query.after?.id ?? null, automationPageSize + 1],
      );
      const { items, counts } = result.rows[0]!;
      return automationPage(items, counts);
    }
    const scope = this.ownedAutomations(ctx, companyIds);
    const needle = query.search?.toLowerCase();
    const after = query.after;
    const agentNames = new Map<string, Promise<string | null>>();
    const agentName = (item: CompanyAutomation) => {
      if (!item.agentId) return Promise.resolve(null);
      const key = `${item.companyId}:${item.agentId}`;
      const existing = agentNames.get(key);
      if (existing) return existing;
      const request = readAgent(item.companyId, item.agentId);
      agentNames.set(key, request);
      return request;
    };
    const candidates = scope.filter(item => (!query.status || item.status === query.status)
      && (!after || item.createdAt < after.createdAt || (item.createdAt === after.createdAt && item.id < after.id)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const items: AutomationPageRow[] = [];
    for (const item of candidates) {
      const name = await agentName(item);
      if (needle && ![item.name, item.description, item.prompt, item.cronExpression, name ?? "main agent"]
        .some(value => value?.toLowerCase().includes(needle))) continue;
      items.push({ ...item, agentName: name, isRunning: this.memoryRuns.get(item.id)?.some(run => run.status === "running") ?? false });
      if (items.length > automationPageSize) break;
    }
    const counts: AutomationCounts | null = after ? null : {
      total: scope.length,
      active: scope.filter(item => item.status === "active").length,
      paused: scope.filter(item => item.status === "paused").length,
      agentsCount: new Set(scope.map(item => item.agentId).filter(Boolean)).size || Number(scope.length > 0),
    };
    return automationPage(items, counts);
  }

  async listCampaignOptions(ctx: AuthContext, companyId: string): Promise<Array<Pick<CompanyAutomation, "id" | "name">>> {
    if (this.pool) {
      return (await this.pool.query<Pick<CompanyAutomation, "id" | "name">>(
        `SELECT id,name FROM company_automations WHERE workspace_id=$1 AND user_id=$2 AND company_id=$3
         AND deleted_at IS NULL AND status<>'deleted' ORDER BY created_at DESC,id DESC`,
        [ctx.workspaceId, ctx.userId, companyId],
      )).rows;
    }
    return this.ownedAutomations(ctx, [companyId])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map(({ id, name }) => ({ id, name }));
  }

  private ownedAutomations(ctx: AuthContext, companyIds: string[]) {
    const ids = new Set(companyIds);
    return [...this.memoryAutomations.values()].filter(item => item.workspaceId === ctx.workspaceId
      && item.userId === ctx.userId && ids.has(item.companyId) && item.status !== "deleted" && !item.deletedAt);
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

  /** Automations of a company with a run in progress (the page offers Stop for them). */
  async runningAutomationIds(ctx: AuthContext, companyId: string): Promise<string[]> {
    if (this.pool) {
      const result = await this.pool.query<{ automation_id: string }>(
        `SELECT DISTINCT automation_id::text FROM company_automation_runs WHERE workspace_id = $1 AND company_id = $2 AND status = 'running'`,
        [ctx.workspaceId, companyId],
      );
      return result.rows.map((row) => row.automation_id);
    }
    const ids: string[] = [];
    for (const [automationId, runs] of this.memoryRuns) if (runs.some((run) => run.status === "running" && run.companyId === companyId)) ids.push(automationId);
    return ids;
  }

  /** Keeps a long run's lease: without renewal another claim could run the same slot again (V6 step 12). */
  async renewLease(autoId: string, workerId: string, leaseMs: number): Promise<void> {
    if (this.pool) {
      await this.pool.query(`UPDATE company_automations SET lease_expires_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1 AND worker_id = $2`, [autoId, workerId, leaseMs]);
      return;
    }
    const item = this.memoryAutomations.get(autoId);
    if (item?.workerId === workerId) item.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  }

  /** Moves the schedule to the next slot as soon as a slot is claimed, so a crash cannot run it twice. */
  async advanceNextRun(autoId: string, nextRunAt: string): Promise<void> {
    if (this.pool) {
      await this.pool.query(`UPDATE company_automations SET next_run_at = $2, updated_at = now() WHERE id = $1`, [autoId, nextRunAt]);
      return;
    }
    const item = this.memoryAutomations.get(autoId);
    if (item) item.nextRunAt = nextRunAt;
  }

  /**
   * Runs left "running" by a stopped process. Automation runs execute only inside the API process that owns the
   * scheduler, so at its start none of them can still be executing; one stayed "running" for ever after a restart
   * (V6 step 12).
   */
  async failInterruptedRuns(startedBefore: Date): Promise<number> {
    const message = "Interrupted: the server restarted during this run";
    if (this.pool) {
      const result = await this.pool.query(
        `UPDATE company_automation_runs SET status = 'failed', error_message = $2, completed_at = now(),
           duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int)
         WHERE status = 'running' AND started_at < $1`,
        [startedBefore.toISOString(), message],
      );
      return result.rowCount ?? 0;
    }
    let count = 0;
    for (const runs of this.memoryRuns.values()) for (const run of runs) {
      if (run.status === "running" && new Date(run.startedAt).getTime() < startedBefore.getTime()) { run.status = "failed"; run.errorMessage = message; run.completedAt = new Date().toISOString(); count++; }
    }
    return count;
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
    durationMs: number,
    status: "failed" | "cancelled" = "failed",
  ): Promise<void> {
    const now = new Date().toISOString();

    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE company_automation_runs SET
             status = $4,
             error_message = $2,
             duration_ms = $3,
             completed_at = now()
           WHERE id = $1`,
          [runId, errorMessage.slice(0, 2000), durationMs, status]
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
        run.status = status;
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
