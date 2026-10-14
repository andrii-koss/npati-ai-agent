import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  AuthContext,
  Project,
  ProjectCodeTrust,
  ProjectCodeTrustInput,
  ProjectMountedFolder,
  ProjectMountedFolderInput,
  ProjectStatus,
} from "./types.js";
import {
  projectCodeTrustColumns,
  projectColumns,
  projectMountedFolderColumns,
} from "./postgres-store-schema.js";
import { getProject } from "./postgres-store-support.js";
import { getProjectCodeTrust, getProjectMountedFolder } from "./postgres-workspace-repositories.js";
import { mountedFolderPathKey } from "./mounted-folder.js";
import { WorkspaceAccessError } from "./types.js";

export async function updateProjectRepository(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  projectId: string,
  input: { provider: string; url: string; branch: string },
): Promise<Project> {
  await getProject(pool, context, companyId, projectId);
  const result = await pool.query<Project>(
    `UPDATE projects
      SET repository_provider=$5, repository_url=$6, repository_branch=$7, revision=revision+1, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4 AND status<>'archived'
      RETURNING ${projectColumns}`,
    [projectId, context.workspaceId, companyId, context.userId, input.provider, input.url, input.branch],
  );
  if (!result.rows[0]) throw new Error("Project repository update failed or project is archived");
  return result.rows[0];
}

export async function updateProjectPreview(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  projectId: string,
  patch: {
    status?: ProjectStatus;
    previewUrl?: string | null;
    previewPort?: number | null;
    framework?: string | null;
    runtime?: string | null;
    lastBuildStatus?: string | null;
    deploymentUrl?: string | null;
    deploymentStatus?: string | null;
    lastDeploymentStatus?: string | null;
    lastDeployedAt?: string | null;
  },
): Promise<Project> {
  const current = await getProject(pool, context, companyId, projectId);
  const status = patch.status ?? current.status;
  const previewUrl = patch.previewUrl !== undefined ? patch.previewUrl : (current.previewUrl ?? null);
  const previewPort = patch.previewPort !== undefined ? patch.previewPort : (current.previewPort ?? null);
  const framework = patch.framework !== undefined ? patch.framework : (current.framework ?? null);
  const runtime = patch.runtime !== undefined ? patch.runtime : (current.runtime ?? null);
  const lastBuildStatus = patch.lastBuildStatus !== undefined ? patch.lastBuildStatus : (current.lastBuildStatus ?? null);
  const deploymentUrl = patch.deploymentUrl !== undefined ? patch.deploymentUrl : (current.deploymentUrl ?? null);
  const deploymentStatus = patch.deploymentStatus !== undefined
    ? patch.deploymentStatus
    : (patch.lastDeploymentStatus !== undefined ? patch.lastDeploymentStatus : (current.deploymentStatus ?? null));
  const lastDeployedAt = patch.lastDeployedAt !== undefined
    ? patch.lastDeployedAt
    : (patch.deploymentUrl ? new Date().toISOString() : (current.lastDeployedAt ?? null));
  const result = await pool.query<Project>(
    `UPDATE projects
      SET status=$5, preview_url=$6, preview_port=$7, framework=$8, runtime=$9, last_build_status=$10, deployment_url=$11, deployment_status=$12, last_deployed_at=$13, revision=revision+1, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4 AND status<>'archived'
      RETURNING ${projectColumns}`,
    [
      projectId,
      context.workspaceId,
      companyId,
      context.userId,
      status,
      previewUrl,
      previewPort,
      framework,
      runtime,
      lastBuildStatus,
      deploymentUrl,
      deploymentStatus,
      lastDeployedAt,
    ],
  );
  if (!result.rows[0]) throw new Error("Project preview update failed or project is archived");
  return result.rows[0];
}

export async function setProjectCodeTrust(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  projectId: string,
  input: ProjectCodeTrustInput,
): Promise<ProjectCodeTrust> {
  const existing = await getProjectCodeTrust(pool, context, companyId, projectId);
  const currentRevision = existing?.revision ?? 0;
  if (input.expectedRevision !== currentRevision) {
    throw new WorkspaceAccessError("Project trust changed by another request. Reload and try again.");
  }
  const result = await pool.query<ProjectCodeTrust>(
    `INSERT INTO project_code_trust
      (id, workspace_id, company_id, project_id, trusted, trusted_by, trusted_at, revoked_by, revoked_at, reason, revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
      ON CONFLICT (company_id, project_id) DO UPDATE SET
        trusted=$5,
        trusted_by=CASE WHEN $5 THEN $6 ELSE project_code_trust.trusted_by END,
        trusted_at=CASE WHEN $5 THEN now() ELSE project_code_trust.trusted_at END,
        revoked_by=CASE WHEN $5 THEN project_code_trust.revoked_by ELSE $6 END,
        revoked_at=CASE WHEN $5 THEN project_code_trust.revoked_at ELSE now() END,
        reason=$10,
        revision=project_code_trust.revision+1,
        updated_at=now()
      RETURNING ${projectCodeTrustColumns}`,
    [
      randomUUID(),
      context.workspaceId,
      companyId,
      projectId,
      input.trusted,
      input.actor,
      input.trusted ? new Date().toISOString() : null,
      input.trusted ? null : input.actor,
      input.trusted ? null : new Date().toISOString(),
      input.reason ?? null,
    ],
  );
  return result.rows[0]!;
}

export async function setProjectMountedFolder(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  projectId: string,
  input: ProjectMountedFolderInput,
): Promise<ProjectMountedFolder> {
  const existing = await getProjectMountedFolder(pool, context, companyId, projectId);
  if (input.expectedRevision !== (existing?.revision ?? 0)) {
    throw new WorkspaceAccessError("Mounted folder changed by another request. Reload and try again.");
  }
  const result = await pool.query<ProjectMountedFolder>(
    `INSERT INTO project_mounted_folders
      (id, workspace_id, company_id, project_id, path, path_key, mode, confirmed_by, confirmed_at, revoked_by, revoked_at, reason, revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1)
      ON CONFLICT (company_id, project_id) DO UPDATE SET
        path=$5,
        path_key=$6,
        mode=$7,
        confirmed_by=CASE WHEN $13 THEN $8 ELSE project_mounted_folders.confirmed_by END,
        confirmed_at=CASE WHEN $13 THEN $9 ELSE project_mounted_folders.confirmed_at END,
        revoked_by=CASE WHEN $13 THEN project_mounted_folders.revoked_by ELSE $10 END,
        revoked_at=CASE WHEN $13 THEN project_mounted_folders.revoked_at ELSE $11 END,
        reason=$12,
        revision=project_mounted_folders.revision+1,
        updated_at=now()
      RETURNING ${projectMountedFolderColumns}`,
    [
      randomUUID(),
      context.workspaceId,
      companyId,
      projectId,
      input.path,
      mountedFolderPathKey(input.path),
      input.mode,
      input.confirmed ? input.actor : null,
      input.confirmed ? new Date().toISOString() : null,
      input.confirmed ? null : input.actor,
      input.confirmed ? null : new Date().toISOString(),
      input.reason ?? null,
      input.confirmed,
    ],
  );
  return result.rows[0]!;
}
