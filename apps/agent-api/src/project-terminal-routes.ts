import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { ProjectTerminalEventsRepository } from "./project-terminal-events";
import type { ProjectSandboxService } from "./project-sandbox-service";

export function registerProjectTerminalRoutes(app: FastifyInstance, auth: AuthProvider, events: ProjectTerminalEventsRepository, sandbox?: ProjectSandboxService) {
  const context = async (request: FastifyRequest) => {
    const ctx = await auth.authenticate(request);
    if (!ctx.permissions.includes("workspace:read")) throw new WorkspaceAccessError("Missing permission: workspace:read");
    return ctx;
  };
  const fail = (reply: FastifyReply, error: unknown) => {
    const code = error instanceof WorkspaceAccessError ? 403 : error instanceof WorkspaceNotFoundError ? 404 : 503;
    return reply.code(code).send({ error: { code: code === 403 ? "ACCESS_DENIED" : code === 404 ? "NOT_FOUND" : "TERMINAL_UNAVAILABLE", message: code === 503 ? "Project terminal unavailable" : (error as Error).message } });
  };
  app.get<{ Params: { companyId: string; projectId: string } }>("/companies/:companyId/projects/:projectId/terminal/events", async (request, reply) => {
    try { return { events: await events.list(await context(request), request.params.companyId, request.params.projectId) }; }
    catch (error) { return fail(reply, error); }
  });
  app.get<{ Params: { companyId: string; projectId: string } }>("/companies/:companyId/projects/:projectId/terminal/live", async (request, reply) => {
    try {
      const ctx = await context(request);
      return sandbox ? await sandbox.liveOutput(ctx, request.params.companyId, request.params.projectId) : { running: false, lines: [] };
    } catch (error) { return fail(reply, error); }
  });
  app.get<{ Params: { companyId: string; projectId: string } }>("/companies/:companyId/projects/:projectId/terminal/logs", async (request, reply) => {
    try {
      const ctx = await context(request);
      await events.list(ctx, request.params.companyId, request.params.projectId, 1);
      return { logs: sandbox ? await sandbox.logs(ctx, request.params.companyId, request.params.projectId) : "", status: sandbox ? await sandbox.status(ctx, request.params.companyId, request.params.projectId) : null };
    } catch (error) { return fail(reply, error); }
  });
}