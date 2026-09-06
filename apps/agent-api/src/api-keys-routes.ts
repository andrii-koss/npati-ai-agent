import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import type { ApiKeysRepository } from "./api-keys-repository";

export function registerApiKeyRoutes(app: FastifyInstance, repo: ApiKeysRepository, auth: AuthProvider, store: WorkspaceStore) {
  async function authorize(request: FastifyRequest<{ Params: { companyId: string } }>, write = false) {
    const context = await auth.authenticate(request);
    const permission = write ? "workspace:write" : "workspace:read";
    if (!context.permissions.some(p => p === permission || p === "*" || p === "admin:all")) {
      throw new AuthenticationError("Permission denied", 403, "FORBIDDEN");
    }
    try { await store.getCompany(context, request.params.companyId); }
    catch (error) {
      if (error instanceof WorkspaceAccessError) throw new AuthenticationError("Company not found", 404, "NOT_FOUND");
      throw error;
    }
    return context.workspaceId;
  }
  // List API keys for a company
  app.get(
    "/companies/:companyId/api-keys",
    async (request: FastifyRequest<{ Params: { companyId: string } }>, reply: FastifyReply) => {
      const tenantId = await authorize(request);
      const keys = await repo.listApiKeys(request.params.companyId, tenantId);
      return { keys };
    }
  );

  // Create a new API key for a company
  app.post(
    "/companies/:companyId/api-keys",
    async (
      request: FastifyRequest<{
        Params: { companyId: string };
        Body: { name: string; scopes?: string[]; expiresInDays?: number };
      }>,
      reply: FastifyReply
    ) => {
      const tenantId = await authorize(request, true);
      const { name, scopes, expiresInDays } = request.body || {};

      if (!name || typeof name !== "string" || name.trim() === "") {
        return reply.status(400).send({ error: "KEY_NAME_REQUIRED", message: "API key name is required" });
      }

      const created = await repo.createApiKey({
        companyId: request.params.companyId,
        tenantId,
        name: name.trim(),
        scopes: Array.isArray(scopes) ? scopes : ["*"],
        expiresInDays: typeof expiresInDays === "number" ? expiresInDays : undefined,
      });

      return reply.status(201).send({ key: created });
    }
  );

  // Revoke an API key
  app.delete(
    "/companies/:companyId/api-keys/:keyId",
    async (
      request: FastifyRequest<{
        Params: { companyId: string; keyId: string };
      }>,
      reply: FastifyReply
    ) => {
      const tenantId = await authorize(request, true);
      const revoked = await repo.revokeApiKey(request.params.keyId, request.params.companyId, tenantId);

      if (!revoked) {
        return reply.status(404).send({ error: "KEY_NOT_FOUND", message: "API key not found or already revoked" });
      }

      return { revoked: true, id: request.params.keyId };
    }
  );
}
