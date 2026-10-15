import { randomUUID } from "node:crypto";
import type { AuthContext, Project, ProjectCheckpoint, CreateCheckpointInput, ProjectDeployment, CreateDeploymentInput, ProjectQaReport, CreateProjectQaReportInput, ProjectInput, ProjectStatus, ProjectCodeSettings, ProjectCodeTrust, ProjectCodeTrustInput, ProjectMountedFolder, ProjectMountedFolderInput, ProjectDataPolicyRecord } from "./types";
import { WorkspaceNotFoundError, WorkspaceAccessError, DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS } from "./types";
import { now } from "./in-memory-clock";

export interface InMemoryProjectState {
  dataPolicyOps: any
  projectCheckpoints: any
  projectCodeTrust: any
  projectCreateRequests: any
  projectDeployments: any
  projectMountedFolders: any
  projectQaReports: any
  projects: any
  assertCompany: (context: AuthContext, companyId: string) => void
}

export async function createProject(host: InMemoryProjectState, context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string) {
    host.assertCompany(context, companyId);
    const requestKey = [context.workspaceId, context.userId, companyId, idempotencyKey].join(":");
    const previous = host.projectCreateRequests.get(requestKey);
    if (previous) return { project: await getProject(host, context, companyId, previous), created: false };
    const timestamp = now();
    const project: Project = {
      id: randomUUID(), workspaceId: context.workspaceId, companyId, createdBy: context.userId,
      name: input.name, description: input.description, type: input.type ?? "website", status: "ready",
      dataBackendId: input.dataBackendId, appScheme: input.appScheme,
      toolchain: input.toolchain ?? null, defaultBranch: input.defaultBranch ?? null,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
      revision: 1, createdAt: timestamp, updatedAt: timestamp,
    };
    host.projects.set(project.id, project);
    host.projectCreateRequests.set(requestKey, project.id);
    return { project: structuredClone(project), created: true };
  }

export async function listProjects(host: InMemoryProjectState, context: AuthContext, companyId: string, includeArchived = false) {
    host.assertCompany(context, companyId);
    return structuredClone([...host.projects.values()]
      .filter((project) => project.workspaceId === context.workspaceId && project.companyId === companyId
        && project.createdBy === context.userId && (includeArchived || project.status !== "archived"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
  }

export async function getProject(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string) {
    host.assertCompany(context, companyId);
    const project = host.projects.get(projectId);
    if (!project || project.workspaceId !== context.workspaceId || project.companyId !== companyId
      || project.createdBy !== context.userId) throw new WorkspaceNotFoundError("Project not found");
    return structuredClone(project);
  }

export async function updateProject(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, input: { name?: string; expectedRevision: number; code?: ProjectCodeSettings }) {
    const project = await getProject(host, context, companyId, projectId);
    if (project.revision !== input.expectedRevision || project.status === "archived") throw new Error("Project changed by another request or is archived");
    const code = input.code ?? {};
    const next: Project = {
      ...project,
      name: input.name ?? project.name,
      toolchain: code.toolchain ?? project.toolchain ?? null,
      defaultBranch: code.defaultBranch ?? project.defaultBranch ?? null,
      dataClassification: code.dataClassification ?? project.dataClassification,
      retentionClass: code.retentionClass ?? project.retentionClass,
      revision: project.revision + 1, updatedAt: now(),
    };
    host.projects.set(projectId, next);
    return structuredClone(next);
  }

export async function getProjectCodeTrust(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null> {
    host.assertCompany(context, companyId);
    return structuredClone(host.projectCodeTrust.get(`${companyId}:${projectId}`) ?? null);
  }

export async function getProjectMountedFolder(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string): Promise<ProjectMountedFolder | null> {
    host.assertCompany(context, companyId);
    const record = host.projectMountedFolders.get(`${companyId}:${projectId}`);
    if (!record || record.workspaceId !== context.workspaceId) return null;
    return structuredClone(record);
  }

export async function getProjectMountedFolderForSystem(host: InMemoryProjectState, companyId: string, projectId: string): Promise<ProjectMountedFolder | null> {
    return structuredClone(host.projectMountedFolders.get(`${companyId}:${projectId}`) ?? null);
  }

export async function updateProjectRepository(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, input: { provider: string; url: string; branch: string }): Promise<Project> {
    const project = await getProject(host, context, companyId, projectId);
    if (project.status === "archived") throw new Error("Project is archived");
    const next = { ...project, repositoryProvider: input.provider, repositoryUrl: input.url, repositoryBranch: input.branch, revision: project.revision + 1, updatedAt: now() };
    host.projects.set(projectId, next);
    return structuredClone(next);
  }

export async function updateProjectPreview(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, patch: { status?: ProjectStatus; previewUrl?: string | null; previewPort?: number | null; framework?: string | null; runtime?: string | null; lastBuildStatus?: string | null; deploymentUrl?: string | null; deploymentStatus?: string | null; lastDeploymentStatus?: string | null; lastDeployedAt?: string | null }) {
    const project = await getProject(host, context, companyId, projectId);
    if (project.status === "archived") throw new Error("Project is archived");
    const next: Project = {
      ...project,
      status: patch.status ?? project.status,
      previewUrl: patch.previewUrl !== undefined ? (patch.previewUrl ?? undefined) : project.previewUrl,
      previewPort: patch.previewPort !== undefined ? (patch.previewPort ?? undefined) : project.previewPort,
      framework: patch.framework !== undefined ? (patch.framework ?? undefined) : project.framework,
      runtime: patch.runtime !== undefined ? (patch.runtime ?? undefined) : project.runtime,
      lastBuildStatus: patch.lastBuildStatus !== undefined ? (patch.lastBuildStatus ?? undefined) : project.lastBuildStatus,
      deploymentUrl: patch.deploymentUrl !== undefined ? (patch.deploymentUrl ?? undefined) : project.deploymentUrl,
      deploymentStatus: patch.deploymentStatus !== undefined ? (patch.deploymentStatus ?? undefined) : (patch.lastDeploymentStatus !== undefined ? (patch.lastDeploymentStatus ?? undefined) : project.deploymentStatus),
      lastDeployedAt: patch.lastDeployedAt !== undefined ? (patch.lastDeployedAt ?? undefined) : (patch.deploymentUrl ? now() : project.lastDeployedAt),
      revision: project.revision + 1,
      updatedAt: now(),
    };
    host.projects.set(projectId, next);
    return structuredClone(next);
  }

export async function archiveProject(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, expectedRevision: number) {
    const project = await getProject(host, context, companyId, projectId);
    if (project.revision !== expectedRevision || project.status === "archived") throw new Error("Project changed by another request or is archived");
    const next: Project = { ...project, status: "archived", revision: project.revision + 1, updatedAt: now() };
    host.projects.set(projectId, next);
    return structuredClone(next);
  }

export async function deleteProject(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string) {
    await getProject(host, context, companyId, projectId);
    for (const [key, id] of host.projectCreateRequests) if (id === projectId) host.projectCreateRequests.delete(key);
    for (const [id, chk] of host.projectCheckpoints) {
      if (chk.projectId === projectId && chk.companyId === companyId && chk.workspaceId === context.workspaceId) {
        host.projectCheckpoints.delete(id);
      }
    }
    for (const [id, dep] of host.projectDeployments) {
      if (dep.projectId === projectId && dep.companyId === companyId && dep.workspaceId === context.workspaceId) {
        host.projectDeployments.delete(id);
      }
    }
    for (const [id, rep] of host.projectQaReports) {
      if (rep.projectId === projectId && rep.companyId === companyId && rep.workspaceId === context.workspaceId) {
        host.projectQaReports.delete(id);
      }
    }
    return host.projects.delete(projectId);
  }

export async function createProjectCheckpoint(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, input: CreateCheckpointInput): Promise<ProjectCheckpoint> {
    await getProject(host, context, companyId, projectId);
    const checkpoint: ProjectCheckpoint = {
      id: `chk_${randomUUID()}`,
      workspaceId: context.workspaceId,
      companyId,
      projectId,
      userId: context.userId,
      name: input.name.trim(),
      description: input.description,
      commitHash: input.commitHash,
      trigger: input.trigger,
      runId: input.runId,
      fileCount: input.fileCount ?? 0,
      createdAt: now(),
    };
    host.projectCheckpoints.set(checkpoint.id, checkpoint);
    return structuredClone(checkpoint);
  }

export async function getProjectCheckpoint(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<ProjectCheckpoint> {
    await getProject(host, context, companyId, projectId);
    const checkpoint = host.projectCheckpoints.get(checkpointId);
    if (!checkpoint || checkpoint.workspaceId !== context.workspaceId || checkpoint.companyId !== companyId || checkpoint.projectId !== projectId) {
      throw new WorkspaceNotFoundError("Project checkpoint not found");
    }
    return structuredClone(checkpoint);
  }

export async function deleteProjectCheckpoint(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<boolean> {
    await getProject(host, context, companyId, projectId);
    const checkpoint = host.projectCheckpoints.get(checkpointId);
    if (!checkpoint || checkpoint.workspaceId !== context.workspaceId || checkpoint.companyId !== companyId || checkpoint.projectId !== projectId) {
      return false;
    }
    return host.projectCheckpoints.delete(checkpointId);
  }

export async function createProjectDeployment(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, input: CreateDeploymentInput): Promise<ProjectDeployment> {
    await getProject(host, context, companyId, projectId);
    const deployment: ProjectDeployment = {
      id: `dep_${randomUUID()}`,
      workspaceId: context.workspaceId,
      companyId,
      projectId,
      userId: context.userId,
      provider: input.provider,
      environment: input.environment ?? "production",
      branch: input.branch ?? "project/main",
      commitHash: input.commitHash,
      status: input.status ?? "queued",
      targetUrl: input.targetUrl,
      externalDeploymentId: input.externalDeploymentId,
      preflightSummary: input.preflightSummary,
      errorMessage: input.errorMessage,
      runId: input.runId,
      createdAt: now(),
      updatedAt: now(),
    };
    host.projectDeployments.set(deployment.id, deployment);
    return structuredClone(deployment);
  }

export async function getProjectDeployment(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, deploymentId: string): Promise<ProjectDeployment | null> {
    await getProject(host, context, companyId, projectId);
    const deployment = host.projectDeployments.get(deploymentId);
    if (!deployment || deployment.workspaceId !== context.workspaceId || deployment.companyId !== companyId || deployment.projectId !== projectId) {
      return null;
    }
    return structuredClone(deployment);
  }

export async function updateProjectDeployment(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, deploymentId: string, patch: Partial<ProjectDeployment>): Promise<ProjectDeployment> {
    await getProject(host, context, companyId, projectId);
    const current = host.projectDeployments.get(deploymentId);
    if (!current || current.workspaceId !== context.workspaceId || current.companyId !== companyId || current.projectId !== projectId) {
      throw new WorkspaceNotFoundError("Project deployment not found");
    }
    const updated: ProjectDeployment = {
      ...current,
      ...patch,
      id: current.id,
      workspaceId: current.workspaceId,
      companyId: current.companyId,
      projectId: current.projectId,
      updatedAt: now(),
    };
    host.projectDeployments.set(deploymentId, updated);
    return structuredClone(updated);
  }

export async function createProjectQaReport(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, input: CreateProjectQaReportInput): Promise<ProjectQaReport> {
    await getProject(host, context, companyId, projectId);
    const report: ProjectQaReport = {
      id: `qa_${randomUUID()}`,
      workspaceId: context.workspaceId,
      companyId,
      projectId,
      userId: context.userId,
      status: input.status,
      targetUrl: input.targetUrl,
      summary: input.summary,
      issues: structuredClone(input.issues),
      metrics: structuredClone(input.metrics),
      screenshots: structuredClone(input.screenshots ?? []),
      runId: input.runId,
      createdAt: now(),
    };
    host.projectQaReports.set(report.id, report);
    return structuredClone(report);
  }

export async function getProjectQaReport(host: InMemoryProjectState, context: AuthContext, companyId: string, projectId: string, reportId: string): Promise<ProjectQaReport | null> {
    await getProject(host, context, companyId, projectId);
    const report = host.projectQaReports.get(reportId);
    if (!report || report.workspaceId !== context.workspaceId || report.companyId !== companyId || report.projectId !== projectId) {
      return null;
    }
    return structuredClone(report);
  }

export async function getProjectDataPolicy(host: InMemoryProjectState, companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null> {
    return host.dataPolicyOps.getProjectDataPolicy(companyId, projectId);
  }

export async function getProjectForSystem(host: InMemoryProjectState, companyId: string, projectId: string): Promise<Project | null> {
    const project = host.projects.get(projectId);
    if (!project || project.companyId !== companyId) return null;
    return structuredClone(project);
  }

export async function setProjectCodeTrust(
  host: InMemoryProjectState,
  context: AuthContext,
  companyId: string,
  projectId: string,
  input: ProjectCodeTrustInput,
): Promise<ProjectCodeTrust> {
  host.assertCompany(context, companyId);
  const key = `${companyId}:${projectId}`;
  const existing = host.projectCodeTrust.get(key);
  if (input.expectedRevision !== (existing?.revision ?? 0)) {
    throw new WorkspaceAccessError("Project trust changed by another request. Reload and try again.");
  }
  const timestamp = now();
  const next: ProjectCodeTrust = {
    id: existing?.id ?? randomUUID(),
    workspaceId: context.workspaceId,
    companyId,
    projectId,
    trusted: input.trusted,
    trustedBy: input.trusted ? input.actor : (existing?.trustedBy ?? null),
    trustedAt: input.trusted ? timestamp : (existing?.trustedAt ?? null),
    revokedBy: input.trusted ? (existing?.revokedBy ?? null) : input.actor,
    revokedAt: input.trusted ? (existing?.revokedAt ?? null) : timestamp,
    reason: input.reason ?? null,
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: timestamp,
  };
  host.projectCodeTrust.set(key, next);
  return structuredClone(next);
}

export async function setProjectMountedFolder(
  host: InMemoryProjectState,
  context: AuthContext,
  companyId: string,
  projectId: string,
  input: ProjectMountedFolderInput,
): Promise<ProjectMountedFolder> {
  host.assertCompany(context, companyId);
  const key = `${companyId}:${projectId}`;
  const existing = host.projectMountedFolders.get(key);
  if (input.expectedRevision !== (existing?.revision ?? 0)) {
    throw new WorkspaceAccessError("Mounted folder changed by another request. Reload and try again.");
  }
  const timestamp = now();
  const next: ProjectMountedFolder = {
    id: existing?.id ?? randomUUID(),
    workspaceId: context.workspaceId,
    companyId,
    projectId,
    path: input.path,
    mode: input.mode,
    confirmedBy: input.confirmed ? input.actor : (existing?.confirmedBy ?? null),
    confirmedAt: input.confirmed ? timestamp : (existing?.confirmedAt ?? null),
    revokedBy: input.confirmed ? (existing?.revokedBy ?? null) : input.actor,
    revokedAt: input.confirmed ? (existing?.revokedAt ?? null) : timestamp,
    reason: input.reason ?? null,
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: timestamp,
  };
  host.projectMountedFolders.set(key, next);
  return structuredClone(next);
}

export async function setProjectSandbox(
  host: InMemoryProjectState,
  context: AuthContext,
  companyId: string,
  projectId: string,
  sandboxId: string | null,
  expectedSandboxId: string | null,
): Promise<Project> {
  const project = await getProject(host, context, companyId, projectId);
  if ((project.sandboxId ?? null) !== expectedSandboxId || project.status === "archived") {
    throw new Error("Project sandbox changed by another request or is archived");
  }
  const next: Project = { ...project, sandboxId: sandboxId ?? undefined, revision: project.revision + 1, updatedAt: now() };
  host.projects.set(projectId, next);
  return structuredClone(next);
}

export async function listProjectCheckpoints(
  host: InMemoryProjectState,
  context: AuthContext,
  companyId: string,
  projectId: string,
  limit = 50,
): Promise<ProjectCheckpoint[]> {
  await getProject(host, context, companyId, projectId);
  const safeLimit = Math.max(1, Math.min(limit, 200));
  return structuredClone([...host.projectCheckpoints.values()]
    .filter((c: any) => c.workspaceId === context.workspaceId && c.companyId === companyId && c.projectId === projectId)
    .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, safeLimit));
}

export async function listProjectDeployments(
  host: InMemoryProjectState,
  context: AuthContext,
  companyId: string,
  projectId: string,
  limit = 50,
): Promise<ProjectDeployment[]> {
  await getProject(host, context, companyId, projectId);
  const safeLimit = Math.max(1, Math.min(limit, 200));
  return structuredClone([...host.projectDeployments.values()]
    .filter((d: any) => d.workspaceId === context.workspaceId && d.companyId === companyId && d.projectId === projectId)
    .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, safeLimit));
}

export async function listProjectQaReports(
  host: InMemoryProjectState,
  context: AuthContext,
  companyId: string,
  projectId: string,
  limit = 50,
  runId?: string,
): Promise<ProjectQaReport[]> {
  await getProject(host, context, companyId, projectId);
  const safeLimit = Math.max(1, Math.min(limit, 200));
  return structuredClone([...host.projectQaReports.values()]
    .filter((r: any) => r.workspaceId === context.workspaceId && r.companyId === companyId && r.projectId === projectId)
    .filter((r: ProjectQaReport) => !runId || r.runId === runId)
    .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, safeLimit));
}

export async function getLatestProjectQaReport(
  host: InMemoryProjectState,
  context: AuthContext,
  companyId: string,
  projectId: string,
): Promise<ProjectQaReport | null> {
  const list = await listProjectQaReports(host, context, companyId, projectId, 1);
  return list[0] ?? null;
}


