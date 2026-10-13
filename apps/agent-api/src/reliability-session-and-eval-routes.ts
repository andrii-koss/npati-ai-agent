import type { FastifyInstance } from "fastify";
import type { AuthProvider } from "./auth";
import {
  globalSessionSearch,
  authorize,
  sendError,
} from "./reliability-operations-singletons";
import { SessionPruningManager, type PrunableSession } from "./sessions-custom-models-and-chunking";
import { AgentEvaluationFramework, type EvalCriteria } from "./evaluation-and-webhook-retries";
import {
  CompressionPresetManager,
  AdaptiveContextBudgetManager,
  PerRequestCompressionOverrideManager,
  type CompressionPresetName,
  type RequestCompressionOverrideOptions,
} from "./context-compression-presets-and-budget";
import { CompressionEvalHarness } from "./output-styles-eval-and-cache";

export function registerReliabilitySessionAndEvalRoutes(app: FastifyInstance, auth: AuthProvider): void {
  // 3. #207: Session Search
  app.get<{ Querystring: { query: string; limit?: string; tenantId?: string } }>("/sessions/search", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      const query = request.query.query;
      if (!query) {
        return reply.code(400).send({ error: { code: "QUERY_REQUIRED", message: "query parameter is required" } });
      }
      const limit = Number(request.query.limit || 20);
      const targetTenant = scope.permissions.includes("admin:all") && request.query.tenantId
        ? request.query.tenantId
        : scope.workspaceId;
      const results = globalSessionSearch.search(query, { tenantId: targetTenant, limit });
      return { query, results, count: results.length, tenantId: targetTenant };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      sessionId: string;
      title: string;
      tags?: string[];
      messages: Array<{ role: string; content: string }>;
    };
  }>("/sessions/index", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "chat:use");
      const { sessionId, title, tags, messages } = request.body || {};
      if (!sessionId || !title || !messages) {
        return reply.code(400).send({ error: { code: "INVALID_BODY", message: "sessionId, title, messages are required" } });
      }
      globalSessionSearch.indexSession({
        sessionId,
        tenantId: scope.workspaceId,
        title,
        tags: tags || [],
        messages,
        createdAt: new Date().toISOString(),
      });
      return reply.code(201).send({ indexed: true, sessionId, tenantId: scope.workspaceId });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { sessionId: string } }>("/sessions/:sessionId", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "chat:use");
      const session = globalSessionSearch.getSession(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Session not found" } });
      }
      if (session.tenantId !== scope.workspaceId && !scope.permissions.includes("admin:all")) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Cannot delete session belonging to another tenant" } });
      }
      globalSessionSearch.deleteSession(request.params.sessionId);
      return { sessionId: request.params.sessionId, deleted: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 4. #208: Session Pruning
  app.post<{
    Body: {
      sessions: PrunableSession[];
      maxInactiveDays?: number;
      maxMessagesPerSession?: number;
      archiveBeforeDelete?: boolean;
    };
  }>("/sessions/prune", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "business:manage");
      const { sessions, maxInactiveDays, maxMessagesPerSession, archiveBeforeDelete } = request.body || {};
      if (!Array.isArray(sessions)) {
        return reply.code(400).send({ error: { code: "SESSIONS_REQUIRED", message: "sessions array is required" } });
      }
      const isAdmin = scope.permissions.includes("admin:all");
      const normalizedSessions: PrunableSession[] = sessions.map((s: any) => ({
        sessionId: String(s.sessionId || ""),
        tenantId: isAdmin && s.tenantId ? String(s.tenantId) : scope.workspaceId,
        lastActiveAt: typeof s.lastActiveAt === "string" ? new Date(s.lastActiveAt).getTime() : Number(s.lastActiveAt || Date.now()),
        messages: Array.isArray(s.messages) ? s.messages : [],
        isArchived: Boolean(s.isArchived),
      }));
      const pruned = SessionPruningManager.prune(normalizedSessions, {
        maxInactiveDays,
        maxMessagesPerSession,
        archiveBeforeDelete,
      });
      return { result: pruned.result, activeCount: pruned.activeSessions.length, activeSessions: pruned.activeSessions };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 5. #124: Evaluation Framework
  app.post<{
    Body: {
      inputPrompt: string;
      generatedResponse: string;
      criteria?: EvalCriteria;
    };
  }>("/evaluation/evaluate", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { inputPrompt, generatedResponse, criteria } = request.body || {};
      if (typeof generatedResponse !== "string") {
        return reply.code(400).send({ error: { code: "RESPONSE_REQUIRED", message: "generatedResponse is required" } });
      }
      const result = AgentEvaluationFramework.evaluate(inputPrompt || "", generatedResponse, criteria);
      return { result };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 6. #197: Compression Presets Catalog
  app.get("/compression/presets", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const presets = CompressionPresetManager.getAvailablePresets();
      return { presets, count: presets.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 6b. #198: Adaptive Context Budget Evaluation
  app.post<{
    Body: {
      currentTokens?: number;
      text?: string;
      messages?: Array<{ role: string; content: string }>;
      maxContextTokens?: number;
      modelId?: string;
    };
  }>("/compression/budget", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { currentTokens, text, messages, maxContextTokens, modelId } = request.body || {};
      let calculatedTokens = currentTokens;
      if (calculatedTokens === undefined) {
        if (text) {
          calculatedTokens = Math.ceil(text.length / 4);
        } else if (Array.isArray(messages)) {
          calculatedTokens = Math.ceil(
            messages.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0) / 4
          );
        } else {
          calculatedTokens = 0;
        }
      }
      const budget = AdaptiveContextBudgetManager.evaluateBudget(
        calculatedTokens,
        maxContextTokens,
        modelId
      );
      return { budget, modelId, effectiveLimit: budget.maxContextTokens };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 6c. #199: Per-Request Compression Override Resolver
  app.post<{
    Body: {
      options?: RequestCompressionOverrideOptions;
    };
  }>("/compression/override/resolve", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const override = PerRequestCompressionOverrideManager.resolveOverride(
        request.headers as any,
        request.body?.options
      );
      return { override };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 6d. #197, #198, #199, #201: Context Compression Presets, Budget & Eval Harness
  app.post<{
    Body: {
      text?: string;
      messages?: Array<{ role: string; content: string }>;
      preset?: CompressionPresetName;
      options?: RequestCompressionOverrideOptions;
      modelId?: string;
      maxContextTokens?: number;
      runEvalHarness?: boolean;
    };
  }>("/compression/apply", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { text, messages, preset, options, modelId, maxContextTokens, runEvalHarness } = request.body || {};
      if (!text && (!Array.isArray(messages) || messages.length === 0)) {
        return reply.code(400).send({ error: { code: "INPUT_REQUIRED", message: "text or messages array is required" } });
      }

      // Check header override or body options override (#199)
      const override = PerRequestCompressionOverrideManager.resolveOverride(
        request.headers as any,
        options || (preset ? { preset: preset as any } : undefined)
      );
      const effectivePreset = override.bypass ? "minimal" : override.preset;

      let compressedText = "";
      let compressedMessages: Array<{ role: string; content: string }> | undefined;
      let tokensSaved = 0;
      let originalTokens = 0;
      let estimatedCompressedTokens = 0;

      if (text) {
        const compressed = CompressionPresetManager.applyPreset(text, effectivePreset as any);
        compressedText = compressed.compressedText;
        tokensSaved = compressed.tokensSaved;
        originalTokens = Math.ceil(text.length / 4);
        estimatedCompressedTokens = Math.ceil(compressedText.length / 4);
      } else if (messages) {
        const compressed = CompressionPresetManager.applyPresetToMessages(messages, effectivePreset as any);
        compressedMessages = compressed.compressedMessages;
        tokensSaved = compressed.tokensSaved;
        originalTokens = Math.ceil(messages.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0) / 4);
        estimatedCompressedTokens = Math.ceil(compressedMessages.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0) / 4);
        compressedText = compressedMessages.map((m) => `${m.role}: ${m.content}`).join("\n");
      }

      // Adaptive budget calculation (#198)
      const budget = AdaptiveContextBudgetManager.evaluateBudget(
        originalTokens,
        maxContextTokens,
        modelId
      );

      // Optional compression eval harness (#201)
      let evalResult;
      if (runEvalHarness && text) {
        evalResult = CompressionEvalHarness.evaluate(text, compressedText);
      }

      const reductionPercent =
        originalTokens > 0
          ? Math.max(0, Math.round(((originalTokens - estimatedCompressedTokens) / originalTokens) * 100))
          : 0;

      return {
        originalTokens,
        compressedTokens: estimatedCompressedTokens,
        reductionPercent,
        appliedPreset: effectivePreset,
        tokensSaved,
        override,
        budget,
        compressedText,
        compressedMessages,
        evaluation: evalResult,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

}
