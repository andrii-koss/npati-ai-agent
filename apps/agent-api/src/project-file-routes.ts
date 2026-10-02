import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { ProjectFileError, type ProjectWorkspace } from "./project-workspace";

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  if (error instanceof WorkspaceAccessError) return reply.code(403).send({ error: { code: error.code, message: error.message } });
  if (error instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: { code: error.code, message: error.message } });
  if (error instanceof ProjectFileError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, currentRevision: error.currentRevision } });
  return reply.code(500).send({ error: { code: "project_files_error", message: "Project file request failed" } });
}
async function authorize(auth: AuthProvider, request: FastifyRequest) {
  const context = await auth.authenticate(request);
  if (!context.permissions.some((permission) => ["workspace:read", "business:manage", "owner", "*"].includes(permission))) throw new WorkspaceAccessError("Missing workspace read permission");
  return context;
}
interface Params { companyId: string; projectId: string }
interface Query { path?: string; query?: string; workspaceId?: string }
export function registerProjectFileRoutes(app: FastifyInstance, workspace: ProjectWorkspace, auth: AuthProvider) {
  app.get<{ Params: Params; Querystring: Query }>("/companies/:companyId/projects/:projectId/files/tree", async (request, reply) => {
    try {
      const context = await authorize(auth, request);
      const { companyId, projectId } = request.params;
      return { workspace: await workspace.info(context, companyId, projectId, request.query.workspaceId), files: await workspace.getFileTree(context, companyId, projectId, request.query.workspaceId) };
    } catch (error) { return fail(reply, error); }
  });
  app.get<{ Params: Params; Querystring: Query }>("/companies/:companyId/projects/:projectId/files/read", async (request, reply) => {
    try { return await workspace.readFile(await authorize(auth, request), request.params.companyId, request.params.projectId, request.query.path ?? "", request.query.workspaceId); }
    catch (error) { return fail(reply, error); }
  });
  app.get<{ Params: Params; Querystring: Query }>("/companies/:companyId/projects/:projectId/files/search", async (request, reply) => {
    try { return { files: await workspace.searchFiles(await authorize(auth, request), request.params.companyId, request.params.projectId, request.query.query ?? "", request.query.workspaceId) }; }
    catch (error) { return fail(reply, error); }
  });
}
