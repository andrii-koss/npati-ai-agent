import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { MemoryDocumentService } from "./memory-documents";

async function authorize(auth: AuthProvider, request: FastifyRequest, permission: "workspace:read" | "workspace:write" | "business:manage") {
  const context = await auth.authenticate(request);
  if (!context.permissions.includes(permission) && !context.permissions.includes("admin:all")) {
    throw new WorkspaceAccessError("Missing permission: " + permission);
  }
  return context;
}

function handle(reply: any, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof WorkspaceAccessError ? 403 : /changed by another request/i.test(message) ? 409 : 400;
  return reply.code(status).send({ error: { code: status === 409 ? "REVISION_CONFLICT" : "MEMORY_DOCUMENT_ERROR", message } });
}

export function registerMemoryDocumentRoutes(app: FastifyInstance, auth: AuthProvider, service: MemoryDocumentService) {
  app.get("/memory/user.md", async (request, reply) => {
    try {
      const context = await authorize(auth, request, "workspace:read");
      return { document: await service.getUserDocument(context) };
    } catch (error) { return handle(reply, error); }
  });

  app.put<{ Body: { markdown: string; expectedRevision: number } }>("/memory/user.md", {
    schema: { body: { type: "object", required: ["markdown", "expectedRevision"], additionalProperties: false, properties: { markdown: { type: "string", minLength: 1, maxLength: 64_000 }, expectedRevision: { type: "integer", minimum: 0 } } } },
  }, async (request, reply) => {
    try {
      const context = await authorize(auth, request, "workspace:write");
      return { document: await service.putUserDocument(context, request.body.markdown, request.body.expectedRevision) };
    } catch (error) { return handle(reply, error); }
  });

  app.delete<{ Body: { expectedRevision: number } }>("/memory/user.md", {
    schema: { body: { type: "object", required: ["expectedRevision"], additionalProperties: false, properties: { expectedRevision: { type: "integer", minimum: 0 } } } },
  }, async (request, reply) => {
    try {
      const context = await authorize(auth, request, "workspace:write");
      await service.deleteUserDocument(context, request.body.expectedRevision);
      return reply.code(204).send();
    } catch (error) { return handle(reply, error); }
  });

  app.get<{ Params: { companyId: string } }>("/companies/:companyId/memory.md", async (request, reply) => {
    try {
      const context = await authorize(auth, request, "workspace:read");
      return { document: await service.getCompanyDocument(context, request.params.companyId) };
    } catch (error) { return handle(reply, error); }
  });

  app.put<{ Params: { companyId: string }; Body: { markdown: string; expectedRevision: number } }>("/companies/:companyId/memory.md", {
    schema: { body: { type: "object", required: ["markdown", "expectedRevision"], additionalProperties: false, properties: { markdown: { type: "string", minLength: 1, maxLength: 64_000 }, expectedRevision: { type: "integer", minimum: 0 } } } },
  }, async (request, reply) => {
    try {
      const context = await authorize(auth, request, "business:manage");
      return { document: await service.putCompanyDocument(context, request.params.companyId, request.body.markdown, request.body.expectedRevision) };
    } catch (error) { return handle(reply, error); }
  });

  app.delete<{ Params: { companyId: string }; Body: { expectedRevision: number } }>("/companies/:companyId/memory.md", {
    schema: { body: { type: "object", required: ["expectedRevision"], additionalProperties: false, properties: { expectedRevision: { type: "integer", minimum: 0 } } } },
  }, async (request, reply) => {
    try {
      const context = await authorize(auth, request, "business:manage");
      await service.deleteCompanyDocument(context, request.params.companyId, request.body.expectedRevision);
      return reply.code(204).send();
    } catch (error) { return handle(reply, error); }
  });
}
