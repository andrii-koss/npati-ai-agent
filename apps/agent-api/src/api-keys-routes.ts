import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { normalizeApiKeyScopes, type ApiKeysRepository } from "./api-keys-repository";
import { ScopedRemoteAccessTokenManager } from "./security-guardrails-and-tokens";

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
    return context;
  }
  // List API keys for a company
  app.get(
    "/companies/:companyId/api-keys",
    async (request: FastifyRequest<{ Params: { companyId: string } }>, reply: FastifyReply) => {
      const context = await authorize(request);
      const keys = await repo.listApiKeys(request.params.companyId, context.workspaceId);
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
      const context = await authorize(request, true);
      const { name, scopes, expiresInDays } = request.body || {};

      if (!name || typeof name !== "string" || name.trim() === "") {
        return reply.status(400).send({ error: "KEY_NAME_REQUIRED", message: "API key name is required" });
      }

      let requestedScopes;
      try {
        requestedScopes = normalizeApiKeyScopes(Array.isArray(scopes) ? scopes : undefined);
      } catch (error: any) {
        return reply.status(error?.status ?? 400).send({ error: error?.code ?? "INVALID_API_KEY_SCOPE", message: error?.message });
      }
      const isAdministrator = context.permissions.includes("admin:all") || context.permissions.includes("*");
      const unauthorizedScope = requestedScopes.find((scope) => scope === "*" ? !isAdministrator : !isAdministrator && !context.permissions.includes(scope));
      if (unauthorizedScope) {
        return reply.status(403).send({ error: "API_KEY_SCOPE_ESCALATION", message: `You cannot delegate scope '${unauthorizedScope}'.` });
      }

      const created = await repo.createApiKey({
        companyId: request.params.companyId,
        tenantId: context.workspaceId,
        ownerUserId: context.userId,
        name: name.trim(),
        scopes: requestedScopes,
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
      const context = await authorize(request, true);
      const revoked = await repo.revokeApiKey(request.params.keyId, request.params.companyId, context.workspaceId);

      if (!revoked) {
        return reply.status(404).send({ error: "KEY_NOT_FOUND", message: "API key not found or already revoked" });
      }

      return { revoked: true, id: request.params.keyId };
    }
  );

  // List tracked devices for an API key (#221)
  app.get(
    "/companies/:companyId/api-keys/:keyId/devices",
    async (
      request: FastifyRequest<{
        Params: { companyId: string; keyId: string };
      }>,
      reply: FastifyReply
    ) => {
      const context = await authorize(request);
      try {
        const result = await repo.listDevices(request.params.keyId, request.params.companyId, context.workspaceId);
        return result;
      } catch (err: any) {
        if (err.message === "KEY_NOT_FOUND") {
          return reply.status(404).send({ error: "KEY_NOT_FOUND", message: "API key not found" });
        }
        throw err;
      }
    }
  );

  // Mint scoped remote access token (#62)
  const remoteTokens = new ScopedRemoteAccessTokenManager();

  app.post(
    "/companies/:companyId/remote-tokens",
    async (
      request: FastifyRequest<{
        Params: { companyId: string };
        Body: { scopes?: string[]; ttlSeconds?: number; ipAllowlist?: string[] };
      }>,
      reply: FastifyReply
    ) => {
      const context = await authorize(request, true);
      const { scopes, ttlSeconds, ipAllowlist } = request.body || {};

      const minted = remoteTokens.mintRemoteToken({
        companyId: request.params.companyId,
        userId: context.userId,
        scopes: Array.isArray(scopes) && scopes.length > 0 ? scopes : ["chat:use"],
        ttlSeconds: typeof ttlSeconds === "number" ? ttlSeconds : 3600,
        ipAllowlist: Array.isArray(ipAllowlist) ? ipAllowlist : undefined,
      });

      return reply.status(201).send(minted);
    }
  );

  // Verify scoped remote access token
  app.post(
    "/companies/:companyId/remote-tokens/verify",
    async (
      request: FastifyRequest<{
        Params: { companyId: string };
        Body: { token: string; clientIp?: string };
      }>,
      reply: FastifyReply
    ) => {
      await authorize(request);
      const { token, clientIp } = request.body || {};
      if (!token) return reply.status(400).send({ error: "TOKEN_REQUIRED", message: "Token is required" });

      const checkIp = clientIp || (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || request.ip;
      const result = remoteTokens.verifyRemoteToken(token, checkIp);
      if (!result.isValid) {
        return reply.status(401).send({ isValid: false, error: result.error });
      }
      return { isValid: true, details: result.details };
    }
  );
}
