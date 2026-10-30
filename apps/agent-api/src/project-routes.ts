import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PROJECT_KINDS, WorkspaceAccessError, WorkspaceNotFoundError, type ProjectInput } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { ProjectService } from "./project-service";

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  if (error instanceof WorkspaceAccessError) return reply.code(403).send({ error: { code: error.code, message: error.message } });
  if (error instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: { code: error.code, message: error.message } });
  const message = error instanceof Error ? error.message : "Project request failed";
  const status = /changed by another request|archived/i.test(message) ? 409
    : /required|invalid|must be|at most/i.test(message) ? 400 : 500;
  return reply.code(status).send({ error: {
    code: status === 409 ? "REVISION_CONFLICT" : status === 400 ? "INVALID_INPUT" : "PROJECT_ERROR",
    message: status === 500 ? "Project request failed" : message,
  } });
}

async function authorize(auth: AuthProvider, request: FastifyRequest, permission: "workspace:read" | "business:manage") {
  const context = await auth.authenticate(request);
  if (!context.permissions.includes(permission)) throw new WorkspaceAccessError("Missing permission: " + permission);
  return context;
}

function key(request: FastifyRequest) {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new Error("A valid Idempotency-Key header is required");
  return value;
}

import type { ProjectWorkspace } from "./project-workspace";

export function registerProjectRoutes(app: FastifyInstance, service: ProjectService, auth: AuthProvider, workspace?: ProjectWorkspace) {
  app.get<{ Querystring: import("@npati/workspace").ProjectCatalogInput }>("/projects/catalog", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: {
      companyId: { type: "string", minLength: 1, maxLength: 100 }, search: { type: "string", maxLength: 200 },
      status: { type: "string", enum: ["all", "active", "archived"] },
      framework: { type: "string", enum: ["all", "static", "nextjs", "vite", "astro", "expo"] },
      kind: { type: "string", enum: ["all", ...PROJECT_KINDS] }, cursor: { type: "string", maxLength: 4096 },
    } } },
  }, async (request, reply) => {
    try {
      reply.header("Cache-Control", "private, no-store");
      return await service.catalog(await authorize(auth, request, "workspace:read"), request.query);
    } catch (error) { return fail(reply, error); }
  });
  app.get<{ Params: { companyId: string }; Querystring: { includeArchived?: string } }>("/companies/:companyId/projects", async (request, reply) => {
    try {
      if (request.query.includeArchived && !["true", "false"].includes(request.query.includeArchived)) throw new Error("Invalid includeArchived");
      return { projects: await service.list(await authorize(auth, request, "workspace:read"), request.params.companyId, request.query.includeArchived === "true") };
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: { companyId: string }; Body: ProjectInput }>("/companies/:companyId/projects", {
    schema: { body: { type: "object", additionalProperties: false, required: ["name", "type"], properties: {
      name: { type: "string" }, type: { type: "string", enum: ["website", "web_app", "landing_page", "mobile_app", "code_project"] },
      kind: { type: "string", enum: [...PROJECT_KINDS] },
      description: { type: "string" },
      // Mobile projects (D6) attach to an existing DataBackend instead of copying a database.
      dataBackendId: { type: "string" },
      appScheme: { type: "string" },
      deploymentUrl: { type: "string", maxLength: 500 },
      previewUrl: { type: "string", maxLength: 500 },
      previewPort: { type: "integer", minimum: 1, maximum: 65535 },
      framework: { type: "string", maxLength: 100 },
    } } },
  }, async (request, reply) => {
    try {
      const ctx = await authorize(auth, request, "business:manage");
      const result = await service.create(ctx, request.params.companyId, request.body, key(request));
      const bodyAny = request.body as unknown as Record<string, unknown>;
      if (bodyAny.deploymentUrl !== undefined || bodyAny.previewUrl !== undefined || bodyAny.previewPort !== undefined || bodyAny.framework !== undefined) {
        const updated = await service.updatePreview(ctx, request.params.companyId, result.project.id, {
          deploymentUrl: typeof bodyAny.deploymentUrl === "string" ? bodyAny.deploymentUrl : undefined,
          deploymentStatus: typeof bodyAny.deploymentUrl === "string" && bodyAny.deploymentUrl ? "deployed" : undefined,
          previewUrl: typeof bodyAny.previewUrl === "string" ? bodyAny.previewUrl : undefined,
          previewPort: typeof bodyAny.previewPort === "number" ? bodyAny.previewPort : undefined,
          framework: typeof bodyAny.framework === "string" ? bodyAny.framework : undefined,
        });
        return reply.code(result.created ? 201 : 200).send(updated);
      }
      return reply.code(result.created ? 201 : 200).send(result.project);
    } catch (error) { return fail(reply, error); }
  });

  app.get<{ Params: { companyId: string; projectId: string } }>("/companies/:companyId/projects/:projectId", async (request, reply) => {
    try { return await service.get(await authorize(auth, request, "workspace:read"), request.params.companyId, request.params.projectId); }
    catch (error) { return fail(reply, error); }
  });

  app.patch<{ Params: { companyId: string; projectId: string }; Body: { name: string; expectedRevision: number } }>("/companies/:companyId/projects/:projectId", {
    schema: { body: { type: "object", additionalProperties: false, required: ["name", "expectedRevision"], properties: {
      name: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 },
      deploymentUrl: { type: "string", maxLength: 500 },
      deploymentStatus: { type: "string", maxLength: 100 },
      previewUrl: { type: "string", maxLength: 500 },
      previewPort: { type: "integer", minimum: 1, maximum: 65535 },
      framework: { type: "string", maxLength: 100 },
    } } },
  }, async (request, reply) => {
    try {
      const ctx = await authorize(auth, request, "business:manage");
      let updated = await service.rename(ctx, request.params.companyId, request.params.projectId, request.body.name, request.body.expectedRevision);
      const bodyAny = request.body as unknown as Record<string, unknown>;
      if (bodyAny.deploymentUrl !== undefined || bodyAny.deploymentStatus !== undefined || bodyAny.previewUrl !== undefined || bodyAny.previewPort !== undefined || bodyAny.framework !== undefined) {
        updated = await service.updatePreview(ctx, request.params.companyId, request.params.projectId, {
          deploymentUrl: typeof bodyAny.deploymentUrl === "string" ? bodyAny.deploymentUrl : undefined,
          deploymentStatus: typeof bodyAny.deploymentStatus === "string" ? bodyAny.deploymentStatus : (typeof bodyAny.deploymentUrl === "string" && bodyAny.deploymentUrl ? "deployed" : undefined),
          previewUrl: typeof bodyAny.previewUrl === "string" ? bodyAny.previewUrl : undefined,
          previewPort: typeof bodyAny.previewPort === "number" ? bodyAny.previewPort : undefined,
          framework: typeof bodyAny.framework === "string" ? bodyAny.framework : undefined,
        });
      }
      return updated;
    }
    catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: { companyId: string; projectId: string }; Body: { expectedRevision: number } }>("/companies/:companyId/projects/:projectId/archive", {
    schema: { body: { type: "object", additionalProperties: false, required: ["expectedRevision"], properties: {
      expectedRevision: { type: "integer", minimum: 1 },
    } } },
  }, async (request, reply) => {
    try { return await service.archive(await authorize(auth, request, "business:manage"), request.params.companyId, request.params.projectId, request.body.expectedRevision); }
    catch (error) { return fail(reply, error); }
  });

  app.delete<{ Params: { companyId: string; projectId: string } }>("/companies/:companyId/projects/:projectId", async (request, reply) => {
    try {
      const context = await authorize(auth, request, "business:manage");
      await service.delete(context, request.params.companyId, request.params.projectId);
      if (workspace) {
        await workspace.removeProjectWorkspace(context, request.params.companyId, request.params.projectId).catch(() => undefined);
      }
      return reply.code(204).send();
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: { companyId: string; projectId: string }; Body: { name?: string } }>("/companies/:companyId/projects/:projectId/duplicate", async (request, reply) => {
    try {
      const context = await authorize(auth, request, "business:manage");
      const { companyId, projectId } = request.params;
      const source = await service.get(context, companyId, projectId);
      const newName = (request.body?.name || `${source.name} (Copy)`).trim();
      const idempotency = `dup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await service.create(context, companyId, {
        name: newName,
        type: source.type,
        kind: source.kind,
        description: source.description,
      }, idempotency);

      if (workspace) {
        try {
          const files = await workspace.getFileTree(context, companyId, projectId);
          for (const file of files) {
            if (file.type === "file") {
              try {
                const item = await workspace.readFile(context, companyId, projectId, file.path);
                await workspace.createFile(context, companyId, result.project.id, file.path, item.content);
              } catch {}
            }
          }
        } catch {}
      }

      return reply.code(201).send(result.project);
    } catch (error) { return fail(reply, error); }
  });
}

