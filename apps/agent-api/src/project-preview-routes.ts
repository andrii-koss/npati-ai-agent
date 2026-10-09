import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { PreviewError, type ProjectPreviewService } from "./project-preview-service";
import type { ProjectWorkspace } from "./project-workspace";

interface ProjectParams {
  companyId: string;
  projectId: string;
}

export function registerProjectPreviewRoutes(
  app: FastifyInstance,
  previewService: ProjectPreviewService,
  workspace: ProjectWorkspace,
  auth: AuthProvider,
  workspaceStore?: WorkspaceStore,
) {
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> => {
    try {
      return await auth.authenticate(request);
    } catch (error) {
      const known = error instanceof AuthenticationError ? error : new AuthenticationError("Unauthorized", 401, "UNAUTHORIZED");
      reply.code(known.status).send({ error: { code: known.code, message: known.message } });
      return null;
    }
  };

  // Start preview server
  app.post<{ Params: ProjectParams; Body: { command?: string; port?: number } }>(
    "/companies/:companyId/projects/:projectId/preview/start",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      const { command, port } = request.body ?? {};
      try {
        const result = await previewService.startPreview(ctx, companyId, projectId, { command, port });
        return reply.code(200).send(result);
      } catch (error) {
        const known = error instanceof PreviewError ? error : new PreviewError("preview_start_failed", error instanceof Error ? error.message : "Failed to start preview", 500);
        return reply.code(known.status).send({ error: { code: known.code, message: known.message } });
      }
    },
  );

  // Stop preview server
  app.post<{ Params: ProjectParams }>(
    "/companies/:companyId/projects/:projectId/preview/stop",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      try {
        const result = await previewService.stopPreview(ctx, companyId, projectId);
        return reply.code(200).send(result);
      } catch (error) {
        const known = error instanceof PreviewError ? error : new PreviewError("preview_stop_failed", error instanceof Error ? error.message : "Failed to stop preview", 500);
        return reply.code(known.status).send({ error: { code: known.code, message: known.message } });
      }
    },
  );

  // Get preview status
  app.get<{ Params: ProjectParams }>(
    "/companies/:companyId/projects/:projectId/preview/status",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      try {
        const result = await previewService.getPreviewStatus(ctx, companyId, projectId);
        return reply.code(200).send(result);
      } catch (error) {
        const known = error instanceof PreviewError ? error : new PreviewError("preview_status_failed", error instanceof Error ? error.message : "Failed to get preview status", 500);
        return reply.code(known.status).send({ error: { code: known.code, message: known.message } });
      }
    },
  );

  // Refresh or generate preview token
  app.get<{ Params: ProjectParams; Querystring: { ttlMs?: string } }>(
    "/companies/:companyId/projects/:projectId/preview/token",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      const ttl = Number(request.query.ttlMs) || 15 * 60 * 1000;
      try { await previewService.assertProjectAccess(ctx, companyId, projectId); }
      catch (error) {
        const status = error instanceof WorkspaceAccessError ? 403 : error instanceof WorkspaceNotFoundError ? 404 : 500;
        return reply.code(status).send({ error: { code: "preview_token_denied", message: "Preview token is unavailable for this project." } });
      }
      const session = previewService.getSession(projectId);
      const sandboxId = session?.sandboxId || "default";
      const token = previewService.generateToken({
        userId: ctx.userId,
        companyId,
        projectId,
        sandboxId,
      }, ttl);
      return reply.code(200).send(token);
    },
  );

  // Changes: get workspace diffs
  app.get<{ Params: ProjectParams }>(
    "/companies/:companyId/projects/:projectId/changes",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      try {
        const result = await workspace.getChanges(ctx, companyId, projectId);
        return reply.code(200).send(result);
      } catch (error) {
        return reply.code(500).send({ error: { code: "changes_error", message: error instanceof Error ? error.message : "Failed to get changes" } });
      }
    },
  );

  // Baseline snapshot
  app.post<{ Params: ProjectParams }>(
    "/companies/:companyId/projects/:projectId/changes/baseline",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      try {
        const result = await workspace.setBaseline(ctx, companyId, projectId);
        return reply.code(200).send(result);
      } catch (error) {
        return reply.code(500).send({ error: { code: "baseline_error", message: error instanceof Error ? error.message : "Failed to set baseline" } });
      }
    },
  );

  // Project runs for Activity tab
  app.get<{ Params: ProjectParams }>(
    "/companies/:companyId/projects/:projectId/runs",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      if (!workspaceStore) return reply.code(200).send({ runs: [] });
      try {
        const runs = await workspaceStore.listCompanyAgentRuns(ctx, companyId, 50, { projectId });
        const withTasks = await Promise.all(runs.map(async (run) => {
          if (run.requestedMode !== "pipeline") return run;
          const details = await workspaceStore.getCompanyAgentRun(ctx, companyId, run.id);
          const plan = details.backgroundEvents.find((event) => event.eventKey === "project-plan");
          const planned = Array.isArray(plan?.details.tasks) ? plan.details.tasks as Array<Record<string, unknown>> : [];
          const tasks = planned.map((task) => {
            const latest = [...details.backgroundEvents].reverse().find((event) => event.details.taskId === task.id);
            return { id: task.id, title: task.title, role: task.role, agentId: task.agentId,
              dependsOn: task.dependsOn, status: latest?.details.status ?? "queued" };
          });
          return { ...run, tasks };
        }));
        return reply.code(200).send({ runs: withTasks });
      } catch (error) {
        return reply.code(500).send({ error: { code: "runs_error", message: error instanceof Error ? error.message : "Failed to list runs" } });
      }
    },
  );

  // Authenticated Reverse Proxy routes (with token validation)
  app.all<{ Params: { companyId: string; projectId: string; "*": string }; Querystring: { token?: string } }>(
    "/companies/:companyId/projects/:projectId/preview/proxy",
    async (request, reply) => {
      return previewService.handleProxy(request, reply);
    },
  );

  app.all<{ Params: { companyId: string; projectId: string; "*": string }; Querystring: { token?: string } }>(
    "/companies/:companyId/projects/:projectId/preview/proxy/*",
    async (request, reply) => {
      return previewService.handleProxy(request, reply);
    },
  );
}
