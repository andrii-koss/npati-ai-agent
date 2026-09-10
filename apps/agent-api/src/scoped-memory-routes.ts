import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import { AuthenticationError } from "./auth";
import type { ApiKeysRepository, ApiKeyAuthResult } from "./api-keys-repository";
import type { CompanyDelegationRuntime } from "./company-runtime";
import type { ScopedMemoryEngine } from "./scoped-memory";

function tokenOf(request: FastifyRequest) {
  const explicit = request.headers["x-npati-api-key"];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer npati_live_")
    ? authorization.slice(7).trim()
    : "";
}

function hasScope(auth: ApiKeyAuthResult, required: string) {
  const scopes = new Set((auth.scopes ?? []).map((scope) => scope.trim().toLowerCase()));
  return scopes.has("*") || scopes.has("all") || scopes.has(required);
}

export function registerScopedMemoryRoutes(app: FastifyInstance, deps: {
  engine: ScopedMemoryEngine;
  apiKeys: ApiKeysRepository;
  store: WorkspaceStore;
  runtime: CompanyDelegationRuntime;
}) {
  async function authorize(request: FastifyRequest, requiredScope: "memory:read"|"memory:write"|"chat:write") {
    const result = await deps.apiKeys.authenticate(tokenOf(request));
    if (!result.authenticated || !result.companyId || !result.tenantId || !result.keyId || !result.userId) {
      throw new AuthenticationError("A valid Company API key is required", 401, result.error ?? "INVALID_API_KEY");
    }
    if (!hasScope(result, requiredScope)) {
      throw new AuthenticationError("API key does not grant " + requiredScope, 403, "API_KEY_SCOPE_DENIED");
    }
    const context: AuthContext = {
      userId: result.userId,
      workspaceId: result.tenantId,
      permissions: ["workspace:read", "workspace:write", "business:manage"],
      apiKeyId: result.keyId,
    };
    await deps.store.getCompany(context, result.companyId);
    return { result, context };
  }

  app.get<{ Querystring: { query?: string; sessionId?: string; limit?: string } }>(
    "/company-api/memory",
    async (request) => {
      const { result } = await authorize(request, "memory:read");
      const memories = await deps.engine.retrieveMemories({
        companyId: result.companyId!,
        tenantId: result.tenantId!,
        apiKeyId: result.keyId,
        sessionId: request.query.sessionId,
        query: request.query.query,
        limit: Number(request.query.limit) || 50,
      });
      return { memories };
    },
  );

  app.post<{ Headers: { "x-npati-api-key"?: string; authorization?: string; "idempotency-key"?: string };
    Body: { sessionId?: string; category?: string; title: string; content: string; tags?: string[]; confidence?: number } }>(
    "/company-api/memory",
    async (request, reply) => {
      const { result } = await authorize(request, "memory:write");
      const memory = await deps.engine.storeMemory({
        companyId: result.companyId!,
        tenantId: result.tenantId!,
        apiKeyId: result.keyId,
        sessionId: request.body.sessionId,
        category: request.body.category,
        title: request.body.title,
        content: request.body.content,
        tags: request.body.tags,
        confidence: request.body.confidence,
        idempotencyKey: request.headers["idempotency-key"],
      });
      return reply.code(201).send({ memory });
    },
  );

  app.delete<{ Params: { memoryId: string }; Querystring: { sessionId?: string };
    Headers: { "x-npati-api-key"?: string; authorization?: string } }>(
    "/company-api/memory/:memoryId",
    async (request, reply) => {
      const { result } = await authorize(request, "memory:write");
      const deleted = await deps.engine.deleteMemory({
        id: request.params.memoryId,
        companyId: result.companyId!,
        tenantId: result.tenantId!,
        apiKeyId: result.keyId,
        sessionId: request.query.sessionId,
      });
      if (!deleted) return reply.code(404).send({ error: { code: "MEMORY_NOT_FOUND", message: "Scoped memory was not found." } });
      return reply.code(204).send();
    },
  );

  app.post<{ Headers: { "x-npati-api-key"?: string; authorization?: string; "idempotency-key"?: string };
    Body: { message: string; sessionId?: string; noMemory?: boolean } }>(
    "/company-api/chat",
    async (request, reply) => {
      const { result, context } = await authorize(request, "chat:write");
      const message = request.body.message?.trim();
      if (!message) return reply.code(400).send({ error: { code: "MESSAGE_REQUIRED", message: "Enter a message." } });
      const run = await deps.runtime.execute(context, result.companyId!, {
        task: message,
        noMemory: request.body.noMemory === true,
        memoryScope: { apiKeyId: result.keyId, sessionId: request.body.sessionId },
      }, request.headers["idempotency-key"] ?? "company-api-chat-" + Date.now());
      if(run.run.errorCode==="SECURITY_GUARDRAIL_BLOCKED")return reply.code(400).send({error:{code:run.run.errorCode,message:run.run.errorMessage}});
      return {
        message: run.run.result ?? run.run.errorMessage ?? "Company run completed.",
        companyRunId: run.run.id,
        sessionId: request.body.sessionId ?? null,
      };
    },
  );
}
