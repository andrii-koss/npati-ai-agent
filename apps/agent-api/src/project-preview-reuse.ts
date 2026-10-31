import type { AuthContext, Project } from "@npati/workspace";
import type { ActivePreviewSession, PreviewTokenPayload } from "./project-preview-service";
import type { ProjectSandboxService } from "./project-sandbox-service";
import type { ProjectService } from "./project-service";
import { projectRuntimeCommandPort } from "./shared-project-runtime-provider";

/**
 * Step 5: when a healthy preview can be kept instead of restarted.
 *
 * Two cases are provably safe:
 *
 * - **development** (`verifiedBuild === false`): a dev server watches the workspace, so the changed files are already
 *   visible; restarting it would only add startup time (and would drop HMR state).
 * - **static** (`framework === "static"`): the server (`python -m http.server`) reads files from the workspace on
 *   every request, so a new file is served without any restart.
 *
 * Everything else keeps the previous behaviour: a production preview (`next start`, `vite preview`, …) reads its build
 * at startup, so a new build genuinely requires a restart. This predicate never decides *whether* a build is verified;
 * the caller still enforces the verification gate before it is asked.
 */
export function canReusePreviewSession(input: {
  verifiedBuild?: boolean;
  command?: string;
  port?: number;
  framework: string;
  forceRestart?: boolean;
}): boolean {
  if (input.forceRestart) return false;
  if (input.command || input.port) return false;
  if (input.verifiedBuild !== true) return true;
  return input.framework === "static";
}

/** Same sandbox and upload path as startPreview; only a healthy matching dev process can be reused. */
export async function reuseDevelopmentPreview(ctx: AuthContext, project: Project, devCommand: string, devPort: number, framework: string,
  sandbox: ProjectSandboxService, projects: Pick<ProjectService,"updatePreview">,
  generateToken: (scope: Omit<PreviewTokenPayload,"expiresAt">) => { token: string }, signal?: AbortSignal) {
  const { companyId, id: projectId } = project;
  if (project.status !== "previewing" || !project.previewPort || !sandbox.supportsPreviewProxy()) return null;
  const command = project.previewPort === devPort ? devCommand : projectRuntimeCommandPort(devCommand, project.previewPort);
  const reusable = await sandbox.refreshPreview(ctx, companyId, projectId, command);
  signal?.throwIfAborted();
  if (!reusable) return null;
  const response = await sandbox.proxyPreview({workspaceId:ctx.workspaceId,userId:ctx.userId,companyId,projectId},reusable.sandboxId,
    {port:project.previewPort,path:"/",method:"GET",headers:{}}).catch(()=>null);
  signal?.throwIfAborted();
  if (!response || response.status < 200 || response.status >= 400) return null;
  const {token}=generateToken({workspaceId:ctx.workspaceId,userId:ctx.userId,companyId,projectId,sandboxId:reusable.sandboxId});
  const previewUrl="/api/companies/"+encodeURIComponent(companyId)+"/projects/"+encodeURIComponent(projectId)+"/preview/proxy/?token="+encodeURIComponent(token);
  const session: ActivePreviewSession={projectId,companyId,...reusable,port:project.previewPort,framework,command,restartCount:0,maxRestarts:3,status:"running",startedAt:new Date().toISOString(),workspaceId:ctx.workspaceId,userId:ctx.userId};
  await projects.updatePreview(ctx,companyId,projectId,{status:"previewing",previewUrl,lastBuildStatus:null});
  return {session,result:{status:"running",previewUrl,token,port:project.previewPort,framework:project.framework||framework,command}};
}
