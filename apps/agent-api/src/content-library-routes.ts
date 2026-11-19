import type { FastifyInstance, FastifyReply } from "fastify";
import type { WorkspaceStore } from "@npati/workspace";
import { WorkspaceAccessError } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { ContentLibraryStore, type ContentLibraryType } from "./content-library-store";

function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  if (error instanceof WorkspaceAccessError) return reply.code(403).send({ error: { code: error.code, message: error.message } });
  const message = error instanceof Error ? error.message : "Content library request failed";
  return reply.code(/not found/i.test(message) ? 404 : 400).send({ error: { code: "CONTENT_LIBRARY_ERROR", message } });
}

export function registerContentLibraryRoutes(app: FastifyInstance, auth: AuthProvider, workspace: WorkspaceStore, content: ContentLibraryStore) {
  app.get("/content/open", async (request, reply) => {
    try {
      const context = await auth.authenticate(request);
      if (!context.permissions.includes("workspace:read")) throw new WorkspaceAccessError("Missing permission: workspace:read");
      return reply.header("cache-control", "private, no-store").send(await content.open(context));
    } catch (error) { return failure(reply, error); }
  });

  app.get("/content/overrides", async (request, reply) => {
    try {
      const context = await auth.authenticate(request);
      if (!context.permissions.includes("workspace:read")) throw new WorkspaceAccessError("Missing permission: workspace:read");
      return { overrides: await content.list(context) };
    } catch (error) { return failure(reply, error); }
  });

  app.patch<{ Params: { companyId: string; runId: string }; Body: { title?: string; type?: ContentLibraryType; content?: string } }>("/companies/:companyId/content/:runId", {
    schema: { body: { type: "object", additionalProperties: false, properties: {
      title: { type: "string", minLength: 1, maxLength: 300 },
      type: { type: "string", enum: ["article", "seo_structure", "social_post", "brief"] },
      content: { type: "string", maxLength: 200000 },
    } } },
  }, async (request, reply) => {
    try {
      const context = await auth.authenticate(request);
      if (!context.permissions.includes("business:manage")) throw new WorkspaceAccessError("Missing permission: business:manage");
      await workspace.getCompanyAgentRun(context, request.params.companyId, request.params.runId);
      if (!Object.keys(request.body).length) throw new Error("At least one content field is required");
      return await content.update(context, request.params.runId, request.params.companyId, request.body);
    } catch (error) { return failure(reply, error); }
  });

  app.delete<{ Params: { companyId: string; runId: string } }>("/companies/:companyId/content/:runId", async (request, reply) => {
    try {
      const context = await auth.authenticate(request);
      if (!context.permissions.includes("business:manage")) throw new WorkspaceAccessError("Missing permission: business:manage");
      await workspace.getCompanyAgentRun(context, request.params.companyId, request.params.runId);
      await content.delete(context, request.params.runId, request.params.companyId);
      return reply.code(204).send();
    } catch (error) { return failure(reply, error); }
  });
}
