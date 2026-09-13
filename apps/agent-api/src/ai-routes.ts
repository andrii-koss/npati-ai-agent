import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { OmniRouteError, type AIEngine, type MarketplaceQuery, type OmniRouteMarketplace, type ProviderAuthType, type ProviderFreeStatus } from "@npati/omniroute-adapter";
import { AIPreferencesStore, type AICompressionMode, type AIMode } from "./ai-preferences";
import type { AuthProvider } from "./auth";
import { ContentModerationEngine } from "./multimodal-inference-engine";
import { ResilientEmbeddingPipeline, ResilientRerankPipeline, type RerankCandidate } from "./resilient-inference-pipeline";

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof OmniRouteError) {
    return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof AIAccessError) return reply.code(403).send({ error: { code: error.code, message: error.message } });
  const message = error instanceof Error ? error.message : "Unexpected AI marketplace error";
  return reply.code(/must|required|not found/i.test(message) ? 400 : 500).send({ error: { code: "MARKETPLACE_ERROR", message } });
}

class AIAccessError extends Error { readonly code = "AI_ACCESS_DENIED"; readonly statusCode = 403; }

async function authorize(auth: AuthProvider, request: FastifyRequest, permission: "workspace:read" | "workspace:write" | "chat:use"): Promise<AuthContext> {
  const scope = await auth.authenticate(request);
  if (!scope.permissions.includes(permission) && !scope.permissions.includes("*") && !scope.permissions.includes("admin:all")) {
    throw new AIAccessError(`Missing permission: ${permission}`);
  }
  return scope;
}

export function registerAIRoutes(app: FastifyInstance, marketplace: OmniRouteMarketplace, preferences: AIPreferencesStore, auth: AuthProvider, ai: AIEngine) {
  // Moderations API (#57)
  app.post<{ Body: { input?: string | string[] } }>("/ai/moderations", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const input = request.body?.input;
      if (!input) return reply.code(400).send({ error: { code: "INPUT_REQUIRED", message: "input text is required" } });
      const texts = Array.isArray(input) ? input : [input];
      const results = texts.map((t) => ContentModerationEngine.moderateText(t));
      return {
        id: "modr_" + randomUUID(),
        model: "npati-moderation-v1",
        results,
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Embeddings API (#64)
  app.post<{
    Body: {
      input?: string | string[];
      model?: string;
      dimensions?: number;
    };
  }>("/ai/embeddings", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const input = request.body?.input;
      if (!input) return reply.code(400).send({ error: { code: "INPUT_REQUIRED", message: "input text is required" } });
      const texts = Array.isArray(input) ? input : [input];
      if (texts.length === 0) return reply.code(400).send({ error: { code: "INPUT_EMPTY", message: "input array cannot be empty" } });

      let resultModel = request.body?.model || "text-embedding-3-small";
      let vectors: number[][];
      let totalTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);

      // Try OmniRoute embed if available
      if (ai.embed) {
        try {
          const res = await ai.embed({
            input: texts,
            model: request.body?.model,
          });
          vectors = res.vectors.map((v) => ResilientEmbeddingPipeline.normalizeVector(v));
          resultModel = res.model;
          if (res.usage?.total_tokens) totalTokens = res.usage.total_tokens;
        } catch {
          // Fallback to ResilientEmbeddingPipeline
          const fallback = await ResilientEmbeddingPipeline.generateEmbeddings({
            texts,
            dimensions: request.body?.dimensions ?? 1536,
            provider: "fallback-resilient",
          });
          vectors = fallback.vectors;
        }
      } else {
        const fallback = await ResilientEmbeddingPipeline.generateEmbeddings({
          texts,
          dimensions: request.body?.dimensions ?? 1536,
          provider: "fallback-resilient",
        });
        vectors = fallback.vectors;
      }

      return {
        object: "list",
        model: resultModel,
        data: vectors.map((embedding, index) => ({
          object: "embedding",
          index,
          embedding,
        })),
        dimensions: vectors[0]?.length ?? 1536,
        usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Cross-Encoder Rerank API (#65 & #302)
  app.post<{
    Body: {
      query?: string;
      documents?: string[];
      model?: string;
      topN?: number;
      minScore?: number;
    };
  }>("/ai/rerank", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { query, documents, model, topN, minScore } = request.body || {};
      if (!query || typeof query !== "string") {
        return reply.code(400).send({ error: { code: "QUERY_REQUIRED", message: "query string is required" } });
      }
      if (!documents || !Array.isArray(documents) || documents.length === 0) {
        return reply.code(400).send({ error: { code: "DOCUMENTS_REQUIRED", message: "documents array is required and cannot be empty" } });
      }

      let resultModel = model || "omniroute-rerank-v1";
      const candidates: RerankCandidate[] = documents.map((doc, idx) => ({
        id: `doc_${idx}`,
        text: doc,
        metadata: { originalIndex: idx },
      }));

      let results: Array<{ index: number; document: string; relevanceScore: number; rank: number }> = [];

      // 1. Try OmniRoute rerank endpoint (#302)
      let omniRouteSucceeded = false;
      if (ai.rerank) {
        try {
          const omniRes = await ai.rerank({
            query,
            documents,
            model,
            topN,
          });
          resultModel = omniRes.model;
          results = omniRes.results.map((r, rankIdx) => ({
            index: r.index,
            document: documents[r.index] ?? "",
            relevanceScore: r.relevanceScore,
            rank: rankIdx + 1,
          }));
          omniRouteSucceeded = true;
        } catch {
          omniRouteSucceeded = false;
        }
      }

      // 2. Seamless Failover to Resilient Cross-Encoder Pipeline if OmniRoute fails or is not available
      if (!omniRouteSucceeded) {
        const localRerank = await ResilientRerankPipeline.rerank(query, candidates, {
          topK: topN,
          minScore: minScore ?? 0.0,
          provider: "local-cross-encoder-resilient",
        });
        resultModel = "local-cross-encoder-resilient";
        results = localRerank.items.map((item, rankIdx) => {
          const origIdx = (item.metadata?.originalIndex as number) ?? parseInt(item.id.replace("doc_", ""), 10);
          return {
            index: origIdx,
            document: item.text,
            relevanceScore: item.relevanceScore,
            rank: rankIdx + 1,
          };
        });
      }

      // Apply minScore threshold if specified
      if (typeof minScore === "number" && minScore > 0) {
        results = results.filter((r) => r.relevanceScore >= minScore);
      }

      return {
        id: "rerank_" + randomUUID(),
        model: resultModel,
        query,
        results,
        totalEvaluated: documents.length,
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/ai/resilience", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      if (!ai.resilienceStatus) return reply.code(503).send({ error: { code: "OMNIROUTE_RESILIENCE_UNAVAILABLE", message: "OmniRoute resilience API is unavailable" } });
      return await ai.resilienceStatus();
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/ai/marketplace", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      const stored = await preferences.get(scope);
      const query: MarketplaceQuery = {
        tab: request.query.tab as MarketplaceQuery["tab"],
        search: request.query.search,
        type: request.query.type as MarketplaceQuery["type"],
        auth: request.query.auth as ProviderAuthType,
        cost: request.query.cost as ProviderFreeStatus,
        capability: request.query.capability,
        connectableOnly: request.query.connectableOnly === "true",
        offset: Number.parseInt(request.query.offset ?? "0", 10) || 0,
        limit: Number.parseInt(request.query.limit ?? "24", 10) || 24,
        refresh: request.query.refresh === "true",
      };
      return await marketplace.marketplace(query, stored.addedModels.map((model) => model.id));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/ai/providers", async (_request, reply) => {
    try { return (await marketplace.marketplace({ limit: 400 })).providers; }
    catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { providerId: string } }>("/ai/providers/:providerId/icon", async (request, reply) => {
    try {
      const icon = await marketplace.providerIcon(request.params.providerId);
      return reply
        .header("content-type", icon.contentType)
        .header("cache-control", "public, max-age=86400, stale-while-revalidate=604800")
        .send(Buffer.from(icon.body));
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { providerId: string } }>("/ai/providers/:providerId", async (request, reply) => {
    try { return await marketplace.provider(request.params.providerId); }
    catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { providerId: string }; Querystring: { refresh?: string; search?: string; offset?: string; limit?: string } }>(
    "/ai/providers/:providerId/models",
    async (request, reply) => {
      try {
        const stored = await preferences.get(await authorize(auth, request, "workspace:read"));
        const models = await marketplace.models(request.params.providerId, stored.addedModels.map((model) => model.id), request.query.refresh === "true");
        const search = request.query.search?.trim().toLowerCase();
        const filtered = search ? models.filter((model) => `${model.id} ${model.name} ${model.capabilities.join(" ")}`.toLowerCase().includes(search)) : models;
        const offset = Math.max(0, Number.parseInt(request.query.offset ?? "0", 10) || 0);
        const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit ?? "48", 10) || 48));
        const page = filtered.slice(offset, offset + limit);
        return { models: page, pagination: { offset, limit, returned: page.length, total: filtered.length, hasMore: offset + page.length < filtered.length } };
      } catch (error) { return sendError(reply, error); }
    },
  );

  app.post<{ Params: { providerId: string }; Body: { apiKey?: string; name?: string; baseUrl?: string; providerSpecificData?: Record<string, unknown> } }>(
    "/ai/providers/:providerId/connect",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
      apiKey: { type: "string", maxLength: 100000 }, name: { type: "string", maxLength: 200 },
      baseUrl: { type: "string", maxLength: 2000 }, providerSpecificData: { type: "object", additionalProperties: true },
    } } } },
    async (request, reply) => {
      try { return await marketplace.connect(request.params.providerId, request.body); }
      catch (error) { return sendError(reply, error); }
    },
  );

  app.delete<{ Params: { providerId: string } }>("/ai/providers/:providerId", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:write");
      const result = await marketplace.disconnect(request.params.providerId);
      const before = await preferences.get(scope);
      const updated = await preferences.removeProvider(scope, request.params.providerId);
      return { ...result, removedModels: before.addedModels.length - updated.addedModels.length };
    }
    catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { providerId: string } }>("/ai/providers/:providerId/test", async (request, reply) => {
    try { return await marketplace.test(request.params.providerId); }
    catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { providerId: string } }>("/ai/providers/:providerId/refresh-models", async (request, reply) => {
    try { return await marketplace.refreshModels(request.params.providerId); }
    catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { providerId: string } }>("/ai/providers/:providerId/oauth/start", async (request, reply) => {
    try { return await marketplace.startOAuth(request.params.providerId); }
    catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { flowId: string } }>("/ai/oauth/:flowId/poll", async (request, reply) => {
    try { return await marketplace.pollOAuth(request.params.flowId); }
    catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { flowId: string }; Body: { code: string } }>("/ai/oauth/:flowId/complete", {
    schema: { body: { type: "object", required: ["code"], additionalProperties: false, properties: { code: { type: "string", minLength: 1, maxLength: 10000 } } } },
  }, async (request, reply) => {
    try { return await marketplace.completeOAuth(request.params.flowId, request.body.code); }
    catch (error) { return sendError(reply, error); }
  });

  app.get("/ai/models/added", async (request) => {
    const scope = await authorize(auth, request, "workspace:read");
    return (await preferences.get(scope)).addedModels;
  });

  app.post<{ Body: { providerId: string; modelId: string } }>("/ai/models/add", {
    schema: { body: { type: "object", required: ["providerId", "modelId"], additionalProperties: false, properties: {
      providerId: { type: "string", minLength: 1, maxLength: 100 }, modelId: { type: "string", minLength: 1, maxLength: 500 },
    } } },
  }, async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:write");
      const stored = await preferences.get(scope);
      const models = await marketplace.models(request.body.providerId, stored.addedModels.map((model) => model.id));
      const model = models.find((item) => item.id === request.body.modelId);
      if (!model) return reply.code(404).send({ error: { code: "MODEL_NOT_FOUND", message: "Model not found in the current provider catalog" } });
      return await preferences.add(scope, model);
    } catch (error) { return sendError(reply, error); }
  });

  app.delete<{ Body: { modelId: string } }>("/ai/models", {
    schema: { body: { type: "object", required: ["modelId"], additionalProperties: false, properties: { modelId: { type: "string", minLength: 1, maxLength: 500 } } } },
  }, async (request, reply) => {
    try { return await preferences.remove(await authorize(auth, request, "workspace:write"), request.body.modelId); }
    catch (error) { return sendError(reply, error); }
  });

  app.put<{ Body: { modelId: string } }>("/ai/models/default", {
    schema: { body: { type: "object", required: ["modelId"], additionalProperties: false, properties: { modelId: { type: "string", minLength: 1, maxLength: 500 } } } },
  }, async (request, reply) => {
    try { return await preferences.setDefault(await authorize(auth, request, "workspace:write"), request.body.modelId); }
    catch (error) { return sendError(reply, error); }
  });

  app.get("/ai/routing", async (request) => {
    const scope = await authorize(auth, request, "workspace:read");
    return (await preferences.get(scope)).routing;
  });
  app.put<{ Body: {
    mode: AIMode; defaultModelId?: string | null; preferFree?: boolean; fallbackOnFailure?: boolean;
    balanceQualityCost?: boolean; compression?: AICompressionMode; monthlyBudgetUsd?: number;
    warningPercent?: number; stopPaidWhenLimitReached?: boolean;
  } }>("/ai/routing", {
    schema: { body: { type: "object", required: ["mode"], additionalProperties: false, properties: {
      mode: { type: "string", enum: ["automatic", "manual"] }, defaultModelId: { anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }] },
      preferFree: { type: "boolean" }, fallbackOnFailure: { type: "boolean" }, balanceQualityCost: { type: "boolean" },
      compression: { type: "string", enum: ["stacked", "off"] },
      monthlyBudgetUsd: { type: "number", minimum: 0, maximum: 1000000 },
      warningPercent: { type: "number", minimum: 1, maximum: 100 },
      stopPaidWhenLimitReached: { type: "boolean" },
    } } },
  }, async (request, reply) => {
    try {
      const { mode, defaultModelId, ...policy } = request.body;
      const routing = (await preferences.setRouting(await authorize(auth, request, "workspace:write"), mode, defaultModelId, policy)).routing;
      return routing;
    }
    catch (error) { return sendError(reply, error); }
  });
}
