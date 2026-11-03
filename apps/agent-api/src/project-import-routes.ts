import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { SandboxProviderError } from "./sandbox-provider";
import { PreviewError } from "./project-preview-service";
import { ProjectFileError } from "./project-workspace";
import type { ProjectImportService } from "./project-import-service";
import { ProjectImportError } from "./project-import-zip";

interface ProjectParams { companyId: string; projectId: string; }

export function registerProjectImportRoutes(app: FastifyInstance, imports: ProjectImportService, auth: AuthProvider): void {
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> => {
    try { return await auth.authenticate(request); }
    catch (error) {
      const known = error instanceof AuthenticationError ? error : new AuthenticationError("Unauthorized", 401, "UNAUTHORIZED");
      reply.code(known.status).send({ error: { code: known.code, message: known.message } });
      return null;
    }
  };
  const fail = (error: unknown, reply: FastifyReply) => {
    if (error instanceof ProjectImportError || error instanceof SandboxProviderError
      || error instanceof PreviewError || error instanceof ProjectFileError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const status = typeof error === "object" && error && "status" in error && typeof error.status === "number"
      ? Math.min(Math.max(error.status, 400), 599) : 500;
    return reply.code(status).send({ error: { code: "project_import_failed", message: "Project import failed" } });
  };

  app.post<{ Params: ProjectParams; Body: { url?: string; branch?: string; credentialId?: string; token?: string } }>(
    "/companies/:companyId/projects/:projectId/import/repository",
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      if (request.body?.token !== undefined) return reply.code(400).send({ error: { code: "raw_credential_forbidden", message: "Use a Company vault credential reference" } });
      try {
        if (typeof request.body?.url !== "string") throw new ProjectImportError("repository_url_required", "Repository URL is required");
        const result = await imports.importRepository(ctx, request.params.companyId, request.params.projectId, {
          url: request.body.url,
          branch: request.body.branch,
          credentialId: request.body.credentialId,
        });
        return reply.code(200).send(result);
      } catch (error) { return fail(error, reply); }
    },
  );

  app.post<{ Params: ProjectParams; Body: { filename?: string; contentBase64?: string } }>(
    "/companies/:companyId/projects/:projectId/import/zip",
    { bodyLimit: Number.MAX_SAFE_INTEGER },
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      try {
        const content = request.body?.contentBase64;
        if (typeof content !== "string" || content.length % 4 !== 0
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)
          || !/\.zip$/i.test(request.body.filename ?? "")) {
          throw new ProjectImportError("invalid_zip_upload", "A ZIP file within 10 MB is required", 400);
        }
        const archive = Buffer.from(content, "base64");
        const result = await imports.importZip(ctx, request.params.companyId, request.params.projectId, archive);
        return reply.code(200).send(result);
      } catch (error) { return fail(error, reply); }
    },
  );
}
