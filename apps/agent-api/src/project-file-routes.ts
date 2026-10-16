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
  app.post<{ Params: Params; Body: { path: string; content: string; expectedRevision?: string } }>("/companies/:companyId/projects/:projectId/files/write", async (request, reply) => {
    try {
      const context = await authorize(auth, request);
      const { companyId, projectId } = request.params;
      const { path: filePath, content, expectedRevision } = request.body || {};
      if (!filePath || typeof filePath !== "string") {
        return reply.code(400).send({ error: { code: "invalid_path", message: "File path is required" } });
      }
      try {
        await workspace.readFile(context, companyId, projectId, filePath);
        if (!expectedRevision) return reply.code(409).send({ error: { code: "revision_required", message: "Read the file and provide its expected revision before replacing it." } });
        const res = await workspace.writeFile(context, companyId, projectId, filePath, content ?? "", expectedRevision);
        return reply.code(200).send(res);
      } catch (err: any) {
        if (!expectedRevision && (err?.code === "file_not_found" || err?.status === 404)) {
          const res = await workspace.createFile(context, companyId, projectId, filePath, content ?? "");
          return reply.code(201).send(res);
        }
        throw err;
      }
    } catch (error) { return fail(reply, error); }
  });
  app.delete<{ Params: Params; Querystring: { path?: string }; Body?: { path?: string } }>("/companies/:companyId/projects/:projectId/files", async (request, reply) => {
    try {
      const context = await authorize(auth, request);
      const { companyId, projectId } = request.params;
      const filePath = request.query?.path || (request.body as any)?.path;
      if (!filePath || typeof filePath !== "string") {
        return reply.code(400).send({ error: { code: "invalid_path", message: "File path is required" } });
      }
      await workspace.deleteFile(context, companyId, projectId, filePath);
      return reply.code(204).send();
    } catch (error) { return fail(reply, error); }
  });
  app.post<{ Params: Params; Body: { name: string; base64Data: string; targetDir?: string } }>("/companies/:companyId/projects/:projectId/files/upload", async (request, reply) => {
    try {
      const context = await authorize(auth, request);
      const { companyId, projectId } = request.params;
      const { name, base64Data, targetDir = "public/assets" } = request.body || {};
      if (!name || !base64Data) {
        return reply.code(400).send({ error: { code: "invalid_upload", message: "Name and base64Data are required" } });
      }
      const cleanName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = `${targetDir.replace(/\/$/, "")}/${cleanName}`;
      const rawBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
      const content = Buffer.from(rawBase64, "base64").toString("binary");
      try {
        const existing = await workspace.readFile(context, companyId, projectId, filePath);
        await workspace.writeFile(context, companyId, projectId, filePath, content, existing.revision);
      } catch {
        await workspace.createFile(context, companyId, projectId, filePath, content);
      }
      const publicUrl = filePath.startsWith("public/") ? filePath.replace(/^public/, "") : `/${filePath}`;
      return reply.code(201).send({ path: filePath, url: publicUrl, name: cleanName });
    } catch (error) { return fail(reply, error); }
  });
}
