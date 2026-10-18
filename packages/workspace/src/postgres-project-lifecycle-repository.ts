import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { AuthContext, Project } from "./types";
import { getProject } from "./postgres-store-support";
import { projectColumns } from "./postgres-store-schema";

export async function softDeleteProject(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  projectId: string,
  reason?: string,
  purgeAfter?: string,
): Promise<Project> {
  await getProject(pool, context, companyId, projectId);
  const purgeDate = purgeAfter ? new Date(purgeAfter) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const result = await pool.query<Project>(
    `UPDATE projects
     SET status='soft_deleted', deleted_at=now(), purge_after=$5, deletion_reason=$6, revision=revision+1, updated_at=now()
     WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4 AND status NOT IN ('purging', 'deleted')
     RETURNING ${projectColumns}`,
    [projectId, context.workspaceId, companyId, context.userId, purgeDate.toISOString(), reason ?? "user_requested"],
  );
  if (!result.rows[0]) throw new Error("Project could not be soft-deleted or is already purging");
  return result.rows[0];
}

export async function restoreProject(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  projectId: string,
): Promise<Project> {
  const current = await getProject(pool, context, companyId, projectId);
  if (current.status !== "soft_deleted") {
    throw new Error(`Cannot restore project with status '${current.status}' (expected 'soft_deleted')`);
  }
  const result = await pool.query<Project>(
    `UPDATE projects
     SET status='ready', deleted_at=NULL, purge_after=NULL, deletion_reason=NULL, restored_at=now(), revision=revision+1, updated_at=now()
     WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4 AND status='soft_deleted'
     RETURNING ${projectColumns}`,
    [projectId, context.workspaceId, companyId, context.userId],
  );
  if (!result.rows[0]) throw new Error("Project changed by another request or is not soft-deleted");
  return result.rows[0];
}

export async function transitionProjectToPurging(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  projectId: string,
): Promise<Project> {
  const result = await pool.query<Project>(
    `UPDATE projects
     SET status='purging', revision=revision+1, updated_at=now()
     WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4 AND status='soft_deleted'
     RETURNING ${projectColumns}`,
    [projectId, context.workspaceId, companyId, context.userId],
  );
  if (!result.rows[0]) throw new Error("Project is not in soft_deleted state");
  return result.rows[0];
}

export async function recordProjectLifecycleRecord(
  pool: Pool,
  record: {
    workspaceId: string;
    companyId: string;
    projectId: string;
    operation: "soft_delete" | "restore" | "hard_purge";
    status: "pending" | "in_progress" | "completed" | "failed";
    details?: Record<string, unknown>;
    lastError?: string;
  },
): Promise<void> {
  const id = `plc_${randomUUID()}`;
  await pool.query(
    `INSERT INTO project_lifecycle_records (id, workspace_id, company_id, project_id, operation, status, details, last_error, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())`,
    [id, record.workspaceId, record.companyId, record.projectId, record.operation, record.status, JSON.stringify(record.details ?? {}), record.lastError ?? null],
  );
}

export async function listExpiredSoftDeletedProjects(
  pool: Pool,
  limit = 50,
): Promise<Array<{ id: string; companyId: string; workspaceId: string; createdBy: string; purgeAfter: string }>> {
  const result = await pool.query<{ id: string; companyId: string; workspaceId: string; createdBy: string; purgeAfter: string }>(
    `SELECT id, company_id AS "companyId", workspace_id AS "workspaceId", created_by AS "createdBy", purge_after AS "purgeAfter"
     FROM projects
     WHERE status = 'soft_deleted' AND purge_after <= now()
     ORDER BY purge_after ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 200))],
  );
  return result.rows;
}

