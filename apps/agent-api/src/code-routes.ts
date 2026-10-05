import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { CodeError, type CodeService } from "./code-service";

type CompanyParams = { companyId: string };
type ProjectParams = { companyId: string; projectId: string };
type SessionParams = { companyId: string; sessionId: string };

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, retryable: false } });
  if (error instanceof CodeError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, retryable: error.retryable } });
  if (error instanceof WorkspaceAccessError) return reply.code(403).send({ error: { code: "code_access_denied", message: error.message, retryable: false } });
  if (error instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: { code: "code_not_found", message: error.message, retryable: false } });
  const message = error instanceof Error ? error.message : "Coding Agent request failed";
  return reply.code(500).send({ error: { code: "code_error", message, retryable: true } });
}

/**
 * C1: code project and code session API.
 *
 * C1a puts every route behind the coding feature flag; until the flag service exists these routes
 * are only reachable by an authenticated owner/admin of the company (checked server-side on every
 * call), and they expose no tools, no sandbox execution and no model calls.
 */
export function registerCodeRoutes(app: FastifyInstance, auth: AuthProvider, service?: CodeService) {
  const authorize = async (request: FastifyRequest, permission: "workspace:read" | "business:manage") => {
    const ctx = await auth.authenticate(request);
    if (!ctx.permissions.includes(permission) && !ctx.permissions.some((value) => ["*", "owner", "admin:all"].includes(value))) {
      throw new WorkspaceAccessError("Missing permission: " + permission);
    }
    if (!service) throw new CodeError("code_unavailable", "Coding Agent is unavailable", 503, true);
    return { ctx, service };
  };

  app.get<{ Params: CompanyParams; Querystring: { includeArchived?: string } }>("/companies/:companyId/code/projects", async (request, reply) => {
    try {
      const { ctx, service } = await authorize(request, "workspace:read");
      return { projects: await service.listProjects(ctx, request.params.companyId, request.query.includeArchived === "true") };
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: CompanyParams; Body: { name: string; description?: string; repositoryUrl?: string; branch?: string; credentialId?: string; dataClassification?: string; retentionClass?: string } }>(
    "/companies/:companyId/code/projects",
    { schema: { body: { type: "object", additionalProperties: false, required: ["name"], properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 5000 },
      repositoryUrl: { type: "string", maxLength: 2000 },
      branch: { type: "string", maxLength: 200 },
      credentialId: { type: "string", maxLength: 200 },
      dataClassification: { type: "string", enum: ["public", "internal", "confidential", "restricted"] },
      retentionClass: { type: "string", enum: ["ephemeral", "short", "standard", "extended", "until_deleted"] },
    } } } },
    async (request, reply) => {
      try {
        const { ctx, service } = await authorize(request, "business:manage");
        const project = await service.createProject(ctx, request.params.companyId, request.body as never);
        return reply.code(201).send(project);
      } catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: ProjectParams }>("/companies/:companyId/projects/:projectId/code/detect-toolchain", async (request, reply) => {
    try {
      const { ctx, service } = await authorize(request, "business:manage");
      return await service.detectAndPersist(ctx, request.params.companyId, request.params.projectId);
    } catch (error) { return fail(reply, error); }
  });

  app.patch<{ Params: ProjectParams; Body: { expectedRevision: number; toolchain?: unknown; verifyCommands?: Record<string, string>; defaultBranch?: string; dataClassification?: string; retentionClass?: string } }>(
    "/companies/:companyId/projects/:projectId/code",
    { schema: { body: { type: "object", additionalProperties: false, required: ["expectedRevision"], properties: {
      expectedRevision: { type: "integer", minimum: 1 },
      toolchain: { type: "object", additionalProperties: true },
      verifyCommands: { type: "object", additionalProperties: { type: "string", maxLength: 300 } },
      defaultBranch: { type: "string", maxLength: 200 },
      dataClassification: { type: "string", enum: ["public", "internal", "confidential", "restricted"] },
      retentionClass: { type: "string", enum: ["ephemeral", "short", "standard", "extended", "until_deleted"] },
    } } } },
    async (request, reply) => {
      try {
        const { ctx, service } = await authorize(request, "business:manage");
        return await service.updateProject(ctx, request.params.companyId, request.params.projectId, request.body as never);
      } catch (error) { return fail(reply, error); }
    },
  );

  app.get<{ Params: CompanyParams; Querystring: { projectId?: string } }>("/companies/:companyId/code/sessions", async (request, reply) => {
    try {
      const { ctx, service } = await authorize(request, "workspace:read");
      return { sessions: await service.listSessionsWithProjects(ctx, request.params.companyId, request.query.projectId) };
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: ProjectParams; Body: { mode?: string; agentId?: string; modelProfile?: string; parentSessionId?: string; dataClassification?: string; retentionClass?: string; summary?: string } }>(
    "/companies/:companyId/projects/:projectId/code/sessions",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
      mode: { type: "string", enum: ["plan", "edit", "auto", "full_auto"] },
      agentId: { type: "string", maxLength: 200 },
      modelProfile: { type: "string", maxLength: 200 },
      parentSessionId: { type: "string", maxLength: 200 },
      dataClassification: { type: "string", enum: ["public", "internal", "confidential", "restricted"] },
      retentionClass: { type: "string", enum: ["ephemeral", "short", "standard", "extended", "until_deleted"] },
      summary: { type: "string", maxLength: 4000 },
    } } } },
    async (request, reply) => {
      try {
        const { ctx, service } = await authorize(request, "business:manage");
        const session = await service.createSession(ctx, request.params.companyId, request.params.projectId, request.body as never);
        return reply.code(201).send(session);
      } catch (error) { return fail(reply, error); }
    },
  );

  app.get<{ Params: SessionParams }>("/companies/:companyId/code/sessions/:sessionId", async (request, reply) => {
    try {
      const { ctx, service } = await authorize(request, "workspace:read");
      return await service.getSession(ctx, request.params.companyId, request.params.sessionId);
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: SessionParams }>("/companies/:companyId/code/sessions/:sessionId/archive", async (request, reply) => {
    try {
      const { ctx, service } = await authorize(request, "business:manage");
      return await service.archiveSession(ctx, request.params.companyId, request.params.sessionId);
    } catch (error) { return fail(reply, error); }
  });

  app.get<{ Params: CompanyParams }>("/companies/:companyId/code/limits", async (request, reply) => {
    try {
      const { service } = await authorize(request, "workspace:read");
      return { limits: service.getLimits() };
    } catch (error) { return fail(reply, error); }
  });
}
