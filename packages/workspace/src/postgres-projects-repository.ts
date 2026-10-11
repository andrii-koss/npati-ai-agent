/* The projects domain of the Postgres workspace store, split out in an architectural step of
 * docs/refactoring/PLAN.md.
 *
 * The method bodies are the previous ones with mechanical rewrites only: `this.pool` became the `pool`
 * argument, calls to sibling methods in the same domain pass that pool on, and the shared ownership checks
 * come from postgres-lookups.ts. The facade keeps every public method as a thin delegation.
 */
import { Pool } from "pg";
import { assertCompany, getProject } from "./postgres-lookups";
import { randomUUID } from "node:crypto";
import type { AuthContext, Project, ProjectCheckpoint, CreateCheckpointInput, ProjectDeployment, CreateDeploymentInput, ProjectQaReport, CreateProjectQaReportInput, ProjectInput, ProjectCodeSettings, ProjectCodeTrust, ProjectMountedFolder } from "./types";
import { DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS } from "./types";
import { WorkspaceNotFoundError } from "./types";
import { projectColumns, projectCodeTrustColumns, projectMountedFolderColumns, projectCheckpointColumns, projectDeploymentColumns, projectQaReportColumns } from "./postgres-store-schema";

export async function createProject(pool: Pool, context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string) {
    await assertCompany(pool, context, companyId);
    const created = await pool.query<Project>(`INSERT INTO projects
      (id,workspace_id,company_id,created_by,name,description,type,create_request_key,data_backend_id,app_scheme,
       data_classification,retention_class,default_branch,toolchain)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (workspace_id,company_id,created_by,create_request_key) DO NOTHING
      RETURNING ${projectColumns}`,
      [randomUUID(), context.workspaceId, companyId, context.userId, input.name, input.description ?? null, input.type, idempotencyKey,
        input.dataBackendId ?? null, input.appScheme ?? null,
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION, input.retentionClass ?? DEFAULT_RETENTION_CLASS,
        input.defaultBranch ?? null, input.toolchain ? JSON.stringify(input.toolchain) : null]);
    if (created.rows[0]) return { project: created.rows[0], created: true };
    const existing = await pool.query<Project>(`SELECT ${projectColumns} FROM projects
      WHERE workspace_id=$1 AND company_id=$2 AND created_by=$3 AND create_request_key=$4`,
      [context.workspaceId,companyId,context.userId,idempotencyKey]);
    if (!existing.rows[0]) throw new WorkspaceNotFoundError("Project not found");
    return { project: existing.rows[0], created: false };
  }

export async function listProjects(pool: Pool, context: AuthContext, companyId: string, includeArchived = false) {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<Project>(`SELECT ${projectColumns} FROM projects
      WHERE workspace_id=$1 AND company_id=$2 AND created_by=$3 AND ($4 OR status<>'archived')
      ORDER BY updated_at DESC,id`, [context.workspaceId,companyId,context.userId,includeArchived]);
    return result.rows;
  }

export async function updateProject(pool: Pool, context: AuthContext, companyId: string, projectId: string, input: { name?: string; expectedRevision: number; code?: ProjectCodeSettings }) {
    const current = await getProject(pool, context, companyId, projectId);
    const name = input.name === undefined ? current.name : input.name;
    const code = input.code ?? {};
    const result = await pool.query<Project>(`UPDATE projects
      SET name=$5,
          toolchain=COALESCE($7, toolchain),
          default_branch=COALESCE($8, default_branch),
          data_classification=COALESCE($9, data_classification),
          retention_class=COALESCE($10, retention_class),
          revision=revision+1, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4
        AND revision=$6 AND status<>'archived' RETURNING ${projectColumns}`,
      [projectId, context.workspaceId, companyId, context.userId, name, input.expectedRevision,
        code.toolchain ? JSON.stringify(code.toolchain) : null, code.defaultBranch ?? null,
        code.dataClassification ?? null, code.retentionClass ?? null]);
    if (!result.rows[0]) throw new Error("Project changed by another request or is archived");
    return result.rows[0];
  }

export async function setProjectSandbox(pool: Pool, context: AuthContext, companyId: string, projectId: string, sandboxId: string | null, expectedSandboxId: string | null) {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query<Project>(`UPDATE projects
      SET sandbox_id=$5,revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4
        AND sandbox_id IS NOT DISTINCT FROM $6 AND status<>'archived' RETURNING ${projectColumns}`,
      [projectId,context.workspaceId,companyId,context.userId,sandboxId,expectedSandboxId]);
    if (!result.rows[0]) throw new Error("Project sandbox changed by another request or is archived");
    return result.rows[0];
  }

export async function archiveProject(pool: Pool, context: AuthContext, companyId: string, projectId: string, expectedRevision: number) {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query<Project>(`UPDATE projects
      SET status='archived',revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4
        AND revision=$5 AND status<>'archived' RETURNING ${projectColumns}`,
      [projectId,context.workspaceId,companyId,context.userId,expectedRevision]);
    if (!result.rows[0]) throw new Error("Project changed by another request or is archived");
    return result.rows[0];
  }

export async function deleteProject(pool: Pool, context: AuthContext, companyId: string, projectId: string) {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query(`DELETE FROM projects
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4`,
      [projectId,context.workspaceId,companyId,context.userId]);
    return Boolean(result.rowCount);
  }

export async function getProjectCodeTrust(pool: Pool, context: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null> {
    const result = await pool.query<ProjectCodeTrust>(`SELECT ${projectCodeTrustColumns} FROM project_code_trust
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3`,
      [context.workspaceId, companyId, projectId]);
    return result.rows[0] ?? null;
  }

export async function getProjectMountedFolder(pool: Pool, context: AuthContext, companyId: string, projectId: string): Promise<ProjectMountedFolder | null> {
    const result = await pool.query<ProjectMountedFolder>(`SELECT ${projectMountedFolderColumns} FROM project_mounted_folders
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3`,
      [context.workspaceId, companyId, projectId]);
    return result.rows[0] ?? null;
  }

export async function getProjectMountedFolderForSystem(pool: Pool, companyId: string, projectId: string): Promise<ProjectMountedFolder | null> {
    const result = await pool.query<ProjectMountedFolder>(`SELECT ${projectMountedFolderColumns} FROM project_mounted_folders
      WHERE company_id=$1 AND project_id=$2`,
      [companyId, projectId]);
    return result.rows[0] ?? null;
  }

export async function createProjectCheckpoint(pool: Pool, context: AuthContext, companyId: string, projectId: string, input: CreateCheckpointInput): Promise<ProjectCheckpoint> {
    await getProject(pool, context, companyId, projectId);
    const id = `chk_${randomUUID()}`;
    const result = await pool.query<ProjectCheckpoint>(`INSERT INTO project_checkpoints
      (id, workspace_id, company_id, project_id, user_id, name, description, commit_hash, trigger, run_id, file_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING ${projectCheckpointColumns}`,
      [id, context.workspaceId, companyId, projectId, context.userId, input.name.trim(), input.description ?? null, input.commitHash ?? null, input.trigger, input.runId ?? null, input.fileCount ?? 0]);
    return result.rows[0]!;
  }

export async function listProjectCheckpoints(pool: Pool, context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectCheckpoint[]> {
    await getProject(pool, context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const result = await pool.query<ProjectCheckpoint>(`SELECT ${projectCheckpointColumns} FROM project_checkpoints
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3
      ORDER BY created_at DESC, id DESC LIMIT $4`,
      [context.workspaceId, companyId, projectId, safeLimit]);
    return result.rows;
  }

export async function getProjectCheckpoint(pool: Pool, context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<ProjectCheckpoint> {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query<ProjectCheckpoint>(`SELECT ${projectCheckpointColumns} FROM project_checkpoints
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [checkpointId, context.workspaceId, companyId, projectId]);
    if (!result.rowCount) throw new WorkspaceNotFoundError("Project checkpoint not found");
    return result.rows[0]!;
  }

export async function deleteProjectCheckpoint(pool: Pool, context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<boolean> {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query(`DELETE FROM project_checkpoints
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [checkpointId, context.workspaceId, companyId, projectId]);
    return Boolean(result.rowCount);
  }

export async function createProjectDeployment(pool: Pool, context: AuthContext, companyId: string, projectId: string, input: CreateDeploymentInput): Promise<ProjectDeployment> {
    await getProject(pool, context, companyId, projectId);
    const id = `dep_${randomUUID()}`;
    const result = await pool.query<ProjectDeployment>(`INSERT INTO project_deployments
      (id, workspace_id, company_id, project_id, user_id, provider, environment, branch, commit_hash, status, target_url, external_deployment_id, preflight_summary, error_message, run_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING ${projectDeploymentColumns}`,
      [id, context.workspaceId, companyId, projectId, context.userId, input.provider, input.environment ?? "production", input.branch ?? "project/main", input.commitHash ?? null, input.status ?? "queued", input.targetUrl ?? null, input.externalDeploymentId ?? null, input.preflightSummary ? JSON.stringify(input.preflightSummary) : null, input.errorMessage ?? null, input.runId ?? null]);
    return result.rows[0]!;
  }

export async function listProjectDeployments(pool: Pool, context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectDeployment[]> {
    await getProject(pool, context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const result = await pool.query<ProjectDeployment>(`SELECT ${projectDeploymentColumns} FROM project_deployments
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3
      ORDER BY created_at DESC, id DESC LIMIT $4`,
      [context.workspaceId, companyId, projectId, safeLimit]);
    return result.rows;
  }

export async function getProjectDeployment(pool: Pool, context: AuthContext, companyId: string, projectId: string, deploymentId: string): Promise<ProjectDeployment | null> {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query<ProjectDeployment>(`SELECT ${projectDeploymentColumns} FROM project_deployments
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [deploymentId, context.workspaceId, companyId, projectId]);
    if (!result.rowCount) return null;
    return result.rows[0]!;
  }

export async function updateProjectDeployment(pool: Pool, context: AuthContext, companyId: string, projectId: string, deploymentId: string, patch: Partial<ProjectDeployment>): Promise<ProjectDeployment> {
    await getProject(pool, context, companyId, projectId);
    const current = await getProjectDeployment(pool, context, companyId, projectId, deploymentId);
    if (!current) throw new WorkspaceNotFoundError("Project deployment not found");
    const status = patch.status ?? current.status;
    const targetUrl = patch.targetUrl !== undefined ? patch.targetUrl : (current.targetUrl ?? null);
    const externalDeploymentId = patch.externalDeploymentId !== undefined ? patch.externalDeploymentId : (current.externalDeploymentId ?? null);
    const preflightSummary = patch.preflightSummary !== undefined ? JSON.stringify(patch.preflightSummary) : (current.preflightSummary ? JSON.stringify(current.preflightSummary) : null);
    const errorMessage = patch.errorMessage !== undefined ? patch.errorMessage : (current.errorMessage ?? null);
    const result = await pool.query<ProjectDeployment>(`UPDATE project_deployments
      SET status=$5, target_url=$6, external_deployment_id=$7, preflight_summary=$8, error_message=$9, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4
      RETURNING ${projectDeploymentColumns}`,
      [deploymentId, context.workspaceId, companyId, projectId, status, targetUrl, externalDeploymentId, preflightSummary, errorMessage]);
    if (!result.rows[0]) throw new WorkspaceNotFoundError("Project deployment not found");
    return result.rows[0];
  }

export async function createProjectQaReport(pool: Pool, context: AuthContext, companyId: string, projectId: string, input: CreateProjectQaReportInput): Promise<ProjectQaReport> {
    await getProject(pool, context, companyId, projectId);
    const id = `qa_${randomUUID()}`;
    const result = await pool.query<ProjectQaReport>(`INSERT INTO project_qa_reports
      (id, workspace_id, company_id, project_id, user_id, status, target_url, summary, issues, metrics, screenshots, run_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING ${projectQaReportColumns}`,
      [id, context.workspaceId, companyId, projectId, context.userId, input.status, input.targetUrl, input.summary, JSON.stringify(input.issues ?? []), JSON.stringify(input.metrics ?? {}), JSON.stringify(input.screenshots ?? []), input.runId ?? null]);
    return result.rows[0]!;
  }

export async function listProjectQaReports(pool: Pool, context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectQaReport[]> {
    await getProject(pool, context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const result = await pool.query<ProjectQaReport>(`SELECT ${projectQaReportColumns} FROM project_qa_reports
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3
      ORDER BY created_at DESC, id DESC LIMIT $4`,
      [context.workspaceId, companyId, projectId, safeLimit]);
    return result.rows;
  }

export async function getProjectQaReport(pool: Pool, context: AuthContext, companyId: string, projectId: string, reportId: string): Promise<ProjectQaReport | null> {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query<ProjectQaReport>(`SELECT ${projectQaReportColumns} FROM project_qa_reports
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [reportId, context.workspaceId, companyId, projectId]);
    if (!result.rowCount) return null;
    return result.rows[0]!;
  }

export async function getProjectForSystem(pool: Pool, companyId: string, projectId: string): Promise<Project | null> {
    const result = await pool.query<Project>(
      `SELECT ${projectColumns} FROM projects WHERE id=$1 AND company_id=$2 LIMIT 1`,
      [projectId, companyId],
    );
    return result.rows[0] ?? null;
  }
