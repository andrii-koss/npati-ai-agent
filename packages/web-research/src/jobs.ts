import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { ResearchJob, ResearchJobStatus } from "./types";

type Scope = Pick<ResearchJob, "workspaceId" | "businessId" | "userId">;

export interface ResearchJobStore {
  create(input: Pick<ResearchJob, "workspaceId" | "businessId" | "userId" | "type" | "input">): Promise<ResearchJob>;
  get(scope: Scope, id: string): Promise<ResearchJob | undefined>;
  update(scope: Scope, id: string, patch: { status: ResearchJobStatus; resultSummary?: string; error?: string }): Promise<ResearchJob>;
}

export class InMemoryResearchJobStore implements ResearchJobStore {
  private readonly jobs = new Map<string, ResearchJob>();
  async create(input: Pick<ResearchJob, "workspaceId" | "businessId" | "userId" | "type" | "input">) {
    const job: ResearchJob = { id: randomUUID(), ...input, status: "queued", createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    return job;
  }
  async get(scope: Scope, id: string) {
    const job = this.jobs.get(id);
    return job && job.workspaceId === scope.workspaceId && job.businessId === scope.businessId && job.userId === scope.userId ? job : undefined;
  }
  async update(scope: Scope, id: string, patch: { status: ResearchJobStatus; resultSummary?: string; error?: string }) {
    const job = await this.get(scope, id);
    if (!job) throw new Error("Research job not found");
    const timestamp = new Date().toISOString();
    const updated: ResearchJob = {
      ...job, ...patch,
      startedAt: patch.status === "running" && !job.startedAt ? timestamp : job.startedAt,
      completedAt: ["completed", "failed", "cancelled"].includes(patch.status) ? timestamp : job.completedAt,
    };
    this.jobs.set(id, updated);
    return updated;
  }
}

type JobRow = {
  id: string; workspace_id: string; business_id: string; user_id: string; type: ResearchJob["type"];
  status: ResearchJobStatus; input: Record<string, unknown>; result_summary: string | null; error: string | null;
  created_at: Date; started_at: Date | null; completed_at: Date | null;
};

function fromRow(row: JobRow): ResearchJob {
  return {
    id: row.id, workspaceId: row.workspace_id, businessId: row.business_id, userId: row.user_id,
    type: row.type, status: row.status, input: row.input, resultSummary: row.result_summary ?? undefined,
    error: row.error ?? undefined, createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString(), completedAt: row.completed_at?.toISOString(),
  };
}

export class PostgresResearchJobStore implements ResearchJobStore {
  private readonly pool: Pool;
  private ready?: Promise<void>;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 4 }); }

  private ensureSchema() {
    if (!this.ready) this.ready = this.pool.query(`
      CREATE TABLE IF NOT EXISTS research_jobs (
        id uuid PRIMARY KEY,
        workspace_id text NOT NULL,
        business_id uuid NOT NULL,
        user_id text NOT NULL,
        type text NOT NULL CHECK (type IN ('search','fetch','crawl','competitor_analysis')),
        status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
        input jsonb NOT NULL DEFAULT '{}'::jsonb,
        result_summary text,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        completed_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS research_jobs_scope_created_idx
        ON research_jobs(workspace_id, business_id, user_id, created_at DESC);
    `).then(() => undefined);
    return this.ready;
  }

  async create(input: Pick<ResearchJob, "workspaceId" | "businessId" | "userId" | "type" | "input">) {
    await this.ensureSchema();
    const result = await this.pool.query<JobRow>(`
      INSERT INTO research_jobs (id, workspace_id, business_id, user_id, type, status, input)
      VALUES ($1,$2,$3,$4,$5,'queued',$6::jsonb) RETURNING *
    `, [randomUUID(), input.workspaceId, input.businessId, input.userId, input.type, JSON.stringify(input.input)]);
    return fromRow(result.rows[0]!);
  }

  async get(scope: Scope, id: string) {
    await this.ensureSchema();
    const result = await this.pool.query<JobRow>(`
      SELECT * FROM research_jobs
      WHERE id=$1 AND workspace_id=$2 AND business_id=$3 AND user_id=$4
    `, [id, scope.workspaceId, scope.businessId, scope.userId]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async update(scope: Scope, id: string, patch: { status: ResearchJobStatus; resultSummary?: string; error?: string }) {
    await this.ensureSchema();
    const result = await this.pool.query<JobRow>(`
      UPDATE research_jobs SET
        status=$5,
        result_summary=COALESCE($6,result_summary),
        error=COALESCE($7,error),
        started_at=CASE WHEN $5='running' THEN COALESCE(started_at,now()) ELSE started_at END,
        completed_at=CASE WHEN $5 IN ('completed','failed','cancelled') THEN now() ELSE completed_at END
      WHERE id=$1 AND workspace_id=$2 AND business_id=$3 AND user_id=$4
      RETURNING *
    `, [id, scope.workspaceId, scope.businessId, scope.userId, patch.status, patch.resultSummary ?? null, patch.error ?? null]);
    if (!result.rows[0]) throw new Error("Research job not found");
    return fromRow(result.rows[0]);
  }
}