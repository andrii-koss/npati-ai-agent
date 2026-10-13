import path from "node:path";
import { access } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthProvider } from "./auth";
import { AuthenticationError } from "./auth";
import { CodeExecutionModeError, type CodeExecutionMode } from "./code-execution-mode";
import type { FeatureFlagService } from "./feature-flags";
import type { CodeService } from "./code-service";
import type { CodeMountedFolderService } from "./code-mounted-folder";

function fail(reply: FastifyReply, error: unknown) {
  const shaped = error as { code?: string; status?: number; httpStatus?: number; message?: string };
  return reply.code(error instanceof AuthenticationError ? error.status : shaped.status ?? shaped.httpStatus ?? 500)
    .send({ error: { code: shaped.code ?? "execution_mode_error", message: shaped.message ?? "Execution mode request failed", retryable: false } });
}

export function registerCodeExecutionModeRoutes(app: FastifyInstance, deps: {
  auth: AuthProvider; flags: FeatureFlagService; code: CodeService; mounts: CodeMountedFolderService;
}) {
  const modes = deps.flags.executionModes;
  app.put<{ Params: { companyId: string }; Body: { mode: CodeExecutionMode; expectedRevision: number } }>(
    "/companies/:companyId/code/execution-mode",
    { schema: { body: { type: "object", additionalProperties: false, required: ["mode", "expectedRevision"],
      properties: { mode: { type: "string", enum: ["global", "company", "sandbox"] }, expectedRevision: { type: "integer", minimum: 0 } } } } },
    async (request, reply) => {
      try { return await modes.set(await deps.auth.authenticate(request), request.params.companyId, request.body.mode, request.body.expectedRevision); }
      catch (error) { return fail(reply, error); }
    });

  app.post<{ Params: { companyId: string } }>("/companies/:companyId/code/creator-workspace", async (request, reply) => {
    try {
      const ctx = await deps.auth.authenticate(request);
      const companyId = request.params.companyId;
      const view = await modes.get(ctx, companyId);
      if (!view.canSelectGlobal) throw new CodeExecutionModeError("creator_admin_required", "Global requires the installation owner or an administrator");
      const root = modes.creatorSourceRoot;
      if (!root) throw new CodeExecutionModeError("creator_source_unconfigured", "The NPATI source repository is not mounted", 503);
      // A dist directory is not a source checkout. Validate before creating a project or session.
      await Promise.all(["package.json", "apps/web/src/App.tsx", "apps/agent-api/src/server.ts"].map(file => access(path.join(root, file))))
        .catch(() => { throw new CodeExecutionModeError("creator_source_invalid", "The configured folder is not an NPATI source checkout", 503); });
      const project = view.creatorProjectId
        ? { id: view.creatorProjectId }
        : await deps.code.createProject(ctx, companyId, { name: "NPATI Creator", description: "Source workspace for the NPATI installation" }, `npati-creator:${ctx.userId}`);
      const mount = await deps.mounts.get(ctx, companyId, project.id);
      const mountContext = { ...ctx, role: "owner" };
      if (!mount?.confirmedAt || mount.revokedAt || path.resolve(mount.path) !== path.resolve(root) || mount.mode !== "rw") {
        await deps.mounts.confirm(mountContext, companyId, project.id, { path: root, mode: "rw",
          expectedRevision: mount?.revision ?? 0, confirm: true, reason: "Global: NPATI Creator Workspace" });
      }
      await deps.code.detectAndPersist(ctx, companyId, project.id);
      const sessions = await deps.code.listSessions(ctx, companyId, project.id, { limit: 20 });
      const session = sessions.find(item => item.id === view.creatorSessionId && item.status !== "archived")
        ?? sessions.find(item => item.status === "active")
        ?? await deps.code.createSession(ctx, companyId, project.id, { mode: "auto" });
      await modes.bindCreator(ctx, companyId, project.id, session.id);
      return { projectId: project.id, sessionId: session.id,
        workspaceUrl: `/settings/code/${encodeURIComponent(companyId)}/${encodeURIComponent(project.id)}?session=${encodeURIComponent(session.id)}` };
    } catch (error) { return fail(reply, error); }
  });
}
