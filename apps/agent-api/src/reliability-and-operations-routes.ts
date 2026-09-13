import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AuthProvider } from "./auth";
import type { WorkspaceStore } from "@npati/workspace";
import { AuthenticationError } from "./auth";
import { CacheManagementService } from "./output-styles-eval-and-cache";
import { SemanticCache } from "./semantic-cache";
import { DatabaseBackupManager, SessionSearchEngine } from "./telemetry-backups-and-session-search";
import { SessionPruningManager, type PrunableSession } from "./sessions-custom-models-and-chunking";
import { AgentEvaluationFramework, type EvalCriteria } from "./evaluation-and-webhook-retries";
import {
  CompressionPresetManager,
  AdaptiveContextBudgetManager,
  PerRequestCompressionOverrideManager,
  type CompressionPresetName,
  type RequestCompressionOverrideOptions,
} from "./context-compression-presets-and-budget";
import {
  OutputStyleModifier,
  CompressionEvalHarness,
  type OutputStyleType,
  type CompressionEvalOptions,
  type CompressionEvalReport,
} from "./output-styles-eval-and-cache";
import { AdaptiveAdmissionQueue, AdmissionError, SelfHealingAutoCombo, type PriorityTier } from "./resilience-admission-queue";
import { QuotaShareRouter } from "./routing-transparency-and-dedup";
import { AtomicRpmLeaseManager } from "./atomic-rpm-rolling-leases";
import { GroupSessionManager } from "./group-sessions";
import { SessionToolRegistry } from "./session-tools";
import { ToolPolicyEngine } from "./tool-policy-engine";

// Shared singletons for production runtime operational components
export const globalCacheService = new CacheManagementService();
export const globalSemanticCache = new SemanticCache<string>(3600_000, 1000);
export const globalBackupManager = new DatabaseBackupManager();
export const globalSessionSearch = new SessionSearchEngine();
export const globalAdmissionQueue = new AdaptiveAdmissionQueue({
  maxConcurrent: Number.parseInt(process.env.NPATI_ADMISSION_MAX_CONCURRENT ?? "20", 10),
  maxConcurrentPerTenant: Number.parseInt(process.env.NPATI_ADMISSION_MAX_CONCURRENT_PER_TENANT ?? "10", 10),
  maxQueueLength: Number.parseInt(process.env.NPATI_ADMISSION_MAX_QUEUE_LENGTH ?? "200", 10),
  freeShedThreshold: Number.parseFloat(process.env.NPATI_ADMISSION_FREE_SHED_THRESHOLD ?? "0.75"),
});
export const globalQuotaRouter = new QuotaShareRouter();
export const globalLeaseManager = new AtomicRpmLeaseManager(60_000);
export const globalGroupSessions = new GroupSessionManager();
export const globalToolPolicyEngine = new ToolPolicyEngine([
  { id: "deny-dangerous", effect: "deny", toolPattern: "dangerous.*", reason: "Dangerous system tools are restricted" },
  { id: "deny-rm", effect: "deny", toolPattern: "fs.delete.*", reason: "Destructive file operations are restricted" },
]);
export const globalSessionTools = new SessionToolRegistry(globalToolPolicyEngine);

async function authorize(auth: AuthProvider, request: FastifyRequest, permission = "chat:use") {
  const scope = await auth.authenticate(request);
  if (!scope.permissions.includes(permission as any)) {
    throw new AuthenticationError(`Missing permission: ${permission}`, 403, "FORBIDDEN");
  }
  return scope;
}

function sendError(reply: FastifyReply, error: unknown, defaultStatus = 400) {
  if (error instanceof AuthenticationError) {
    return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof AdmissionError) {
    if (error.retryAfterMs > 0) reply.header("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
    return reply.code(error.code === "ADMISSION_CANCELLED" ? 499 : 429).send({ error: { code: error.code, message: error.message } });
  }
  const status = Number((error as any)?.status ?? defaultStatus);
  return reply.code(status).send({
    error: {
      code: (error as any)?.code ?? "OPERATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

export function registerReliabilityAndOperationsRoutes(
  app: FastifyInstance,
  auth: AuthProvider,
  store?: WorkspaceStore
) {
  if ((store as any)?.pool) {
    globalGroupSessions.setPool((store as any).pool);
  }
  app.get("/runtime/admission", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      return globalAdmissionQueue.snapshot();
    } catch (error) { return sendError(reply, error); }
  });
  // 1. #176 & #202: Semantic & KV Cache Stats, Query, Store, Invalidate & Flush
  app.get("/cache/stats", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      const kv = globalCacheService.getStats(scope.workspaceId);
      const semantic = globalSemanticCache.stats();
      const totalHits = kv.hits + semantic.hits;
      const totalMisses = kv.misses + semantic.misses;
      const totalRequests = totalHits + totalMisses;
      const combinedHitRatio = totalRequests > 0 ? Number((totalHits / totalRequests).toFixed(2)) : 0;

      return {
        stats: kv,
        semantic,
        combined: {
          totalHits,
          totalMisses,
          combinedHitRatio,
          totalKeys: kv.totalKeys + semantic.entriesCount,
          memoryBytesEstimate: kv.memoryBytesEstimate,
        },
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: { prefix?: string; flushAll?: boolean; target?: "all" | "kv" | "semantic" } }>("/cache/flush", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "business:manage");
      const { prefix, flushAll, target = "all" } = request.body || {};
      const isGlobal = Boolean(flushAll && scope.permissions.includes("admin:all"));

      let kvResult = { flushedCount: 0, remainingKeys: 0 };
      let semanticFlushed = 0;

      if (target === "all" || target === "kv") {
        kvResult = globalCacheService.flush(
          isGlobal ? undefined : { tenantId: scope.workspaceId, prefix }
        );
      }

      if (target === "all" || target === "semantic") {
        semanticFlushed = globalSemanticCache.invalidate(isGlobal ? "" : scope.workspaceId);
      }

      return {
        ...kvResult,
        semanticFlushed,
        totalFlushed: kvResult.flushedCount + semanticFlushed,
        target,
        scope: isGlobal ? "global" : scope.workspaceId,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: { key: string; value: unknown } }>("/cache/kv/set", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:write");
      const { key, value } = request.body || {};
      if (!key) return reply.code(400).send({ error: { code: "KEY_REQUIRED", message: "key is required" } });
      const tenantKey = `${scope.workspaceId}:${key}`;
      globalCacheService.set(tenantKey, value);
      return { ok: true, key: tenantKey };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { key: string } }>("/cache/kv/get/:key", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      const { key } = request.params;
      const tenantKey = `${scope.workspaceId}:${key}`;
      const value = globalCacheService.get(tenantKey);
      return { hit: value !== undefined, value };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      query: string;
      scopeKey?: string;
    };
  }>("/cache/semantic/query", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "chat:use");
      const { query, scopeKey } = request.body || {};
      if (!query) {
        return reply.code(400).send({ error: { code: "QUERY_REQUIRED", message: "query is required" } });
      }
      const targetScope = scope.permissions.includes("admin:all") && scopeKey ? scopeKey : scope.workspaceId;
      const data = globalSemanticCache.get(query, targetScope);
      return {
        hit: data !== null,
        data,
        scope: targetScope,
        stats: globalSemanticCache.stats(),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      query: string;
      data: string;
      ttlMs?: number;
      scopeKey?: string;
    };
  }>("/cache/semantic/store", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "chat:use");
      const { query, data, ttlMs, scopeKey } = request.body || {};
      if (!query || data === undefined) {
        return reply.code(400).send({ error: { code: "INPUT_REQUIRED", message: "query and data are required" } });
      }
      const targetScope = scope.permissions.includes("admin:all") && scopeKey ? scopeKey : scope.workspaceId;
      globalSemanticCache.set(query, data, targetScope, ttlMs);
      return {
        stored: true,
        query,
        scope: targetScope,
        ttlMs: ttlMs || 3600_000,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      scopeKey?: string;
      flushAll?: boolean;
    };
  }>("/cache/semantic/invalidate", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "business:manage");
      const flushAll = Boolean(request.body?.flushAll && scope.permissions.includes("admin:all"));
      const targetScope = flushAll ? "" : (scope.permissions.includes("admin:all") && request.body?.scopeKey ? request.body.scopeKey : scope.workspaceId);
      const flushedCount = globalSemanticCache.invalidate(targetScope);
      return {
        flushedCount,
        scope: flushAll ? "global" : targetScope,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 2. #205: Database Backups
  app.post<{ Body: { databaseName?: string; snapshotName?: string; retentionDays?: number; content?: string } }>(
    "/admin/backups",
    async (request, reply) => {
      try {
        await authorize(auth, request, "business:manage");
        const { databaseName, snapshotName, retentionDays, content } = request.body || {};
        const snapshot = globalBackupManager.createSnapshot({
          databaseName: databaseName || "npati_production",
          snapshotName: snapshotName || `manual-backup-${Date.now()}`,
          simulatedContent: content,
          retentionDays,
        });
        return reply.code(201).send({ snapshot });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.get<{ Querystring: { database?: string } }>("/admin/backups", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const { database } = request.query || {};
      const snapshots = globalBackupManager.listSnapshots(database);
      return { snapshots, count: snapshots.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { snapshotId: string } }>("/admin/backups/:snapshotId", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const snapshot = globalBackupManager.getSnapshot(request.params.snapshotId);
      if (!snapshot) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Snapshot '${request.params.snapshotId}' not found` } });
      }
      return { snapshot };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { snapshotId: string } }>("/admin/backups/:snapshotId", async (request, reply) => {
    try {
      await authorize(auth, request, "business:manage");
      const deleted = globalBackupManager.deleteSnapshot(request.params.snapshotId);
      if (!deleted) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Snapshot '${request.params.snapshotId}' not found` } });
      }
      return { snapshotId: request.params.snapshotId, deleted: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/admin/backups/prune", async (request, reply) => {
    try {
      await authorize(auth, request, "business:manage");
      const prunedCount = globalBackupManager.pruneExpired();
      return { prunedCount, remainingCount: globalBackupManager.listSnapshots().length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { snapshotId: string }; Body: { content: string } }>(
    "/admin/backups/:snapshotId/verify",
    async (request, reply) => {
      try {
        await authorize(auth, request, "business:manage");
        const verification = globalBackupManager.verifySnapshotDetails(
          request.params.snapshotId,
          request.body?.content || ""
        );
        if (!verification.snapshot) {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Snapshot '${request.params.snapshotId}' not found` } });
        }
        return {
          snapshotId: request.params.snapshotId,
          verified: verification.verified,
          expectedChecksum: verification.expectedChecksum,
          actualChecksum: verification.actualChecksum,
          status: verification.snapshot.status,
        };
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

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

  // 7a. #200: Output Styles Catalog
  app.get("/styles", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      return {
        styles: OutputStyleModifier.getAvailableStyles(),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 7b. #200: Output Styles Apply (Messages & Prompt)
  app.post<{
    Body: {
      messages?: Array<{ role: string; content: string }>;
      prompt?: string;
      style: OutputStyleType;
    };
  }>("/styles/apply", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { messages, prompt, style } = request.body || {};
      if (!style) {
        return reply.code(400).send({ error: { code: "STYLE_REQUIRED", message: "style is required" } });
      }
      if (!OutputStyleModifier.isValidStyle(style)) {
        return reply.code(400).send({
          error: {
            code: "INVALID_STYLE",
            message: `Invalid output style '${style}'. Supported: concise, bulleted, minimal-json, executive`,
          },
        });
      }
      if (!Array.isArray(messages) && typeof prompt !== "string") {
        return reply.code(400).send({
          error: { code: "INPUT_REQUIRED", message: "Either 'messages' array or 'prompt' string must be provided" },
        });
      }

      const instruction = OutputStyleModifier.getInstruction(style);

      if (Array.isArray(messages)) {
        const modified = OutputStyleModifier.applyOutputStyle(messages, style);
        return { style, instruction, modifiedMessages: modified };
      } else {
        const modifiedPrompt = OutputStyleModifier.applyOutputStyleToPrompt(prompt!, style);
        return { style, instruction, modifiedPrompt };
      }
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 7c. #201: Dedicated Compression Eval Harness
  app.post<{
    Body: {
      original?: string;
      compressed?: string;
      originalMessages?: Array<{ role: string; content: string }>;
      compressedMessages?: Array<{ role: string; content: string }>;
      options?: CompressionEvalOptions;
    };
  }>("/compression/eval", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const { original, compressed, originalMessages, compressedMessages, options } = request.body || {};

      let report: CompressionEvalReport;
      if (Array.isArray(originalMessages) && Array.isArray(compressedMessages)) {
        report = CompressionEvalHarness.evaluateMessages(originalMessages, compressedMessages, options);
      } else if (typeof original === "string" && typeof compressed === "string") {
        report = CompressionEvalHarness.evaluate(original, compressed, options);
      } else {
        return reply.code(400).send({
          error: {
            code: "INPUT_REQUIRED",
            message: "Provide either { original, compressed } text or { originalMessages, compressedMessages } arrays",
          },
        });
      }

      return { report };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 7b. #22 Live Queue Status & Metrics Inspection
  app.get("/queue/status", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      return {
        status: "ok",
        queue: globalAdmissionQueue.snapshot(),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 8. #22: Adaptive Admission Queue
  app.post<{
    Body: {
      tier?: PriorityTier;
      simulatedPayload: string;
      delayMs?: number;
    };
  }>("/queue/admission", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { tier, simulatedPayload, delayMs } = request.body || {};
      const result = await globalAdmissionQueue.enqueue(async () => {
        if (delayMs) await new Promise((r) => setTimeout(r, Math.min(delayMs, 500)));
        return `Processed: ${simulatedPayload}`;
      }, tier || "pro");

      return { result, queueLength: globalAdmissionQueue.queueLength, inFlight: globalAdmissionQueue.inFlightCount };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 9. #23: Self-Healing Auto-Combo
  app.post<{
    Body: {
      candidates: Array<{ modelId: string; provider: string; shouldFail?: boolean; responseText?: string }>;
    };
  }>("/queue/healing", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const rawCandidates = request.body?.candidates || [];
      if (!rawCandidates.length) {
        return reply.code(400).send({ error: { code: "CANDIDATES_REQUIRED", message: "candidates array is required" } });
      }

      const executableCandidates = rawCandidates.map((c) => ({
        modelId: c.modelId,
        provider: c.provider,
        execute: async () => {
          if (c.shouldFail) {
            throw new Error(`503 Provider ${c.provider} unavailable`);
          }
          return c.responseText || `Response from ${c.modelId}`;
        },
      }));

      const healingResult = await SelfHealingAutoCombo.executeWithHealing(executableCandidates);
      return healingResult;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 10. #190: Quota-Share Routing
  app.post<{
    Body: {
      tenantId?: string;
      tier?: "enterprise" | "pro" | "starter";
      sharePercent?: number;
      currentSystemRpm?: number;
      systemMaxRpm?: number;
    };
  }>("/routing/quota-share", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      const { tenantId, tier, sharePercent, currentSystemRpm, systemMaxRpm } = request.body || {};
      const targetTenant =
        scope.permissions.includes("admin:all") && tenantId ? tenantId : scope.workspaceId;
      if (tier) {
        globalQuotaRouter.setTenantShare(targetTenant, tier, sharePercent || 30);
      }
      const decision = globalQuotaRouter.isAdmitted(
        targetTenant,
        currentSystemRpm !== undefined ? Number(currentSystemRpm) : 50,
        systemMaxRpm !== undefined ? Number(systemMaxRpm) : 100
      );
      const configured = globalQuotaRouter.getTenantShare(targetTenant);
      return { tenantId: targetTenant, tier: configured?.tier || tier || "unknown", decision };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      tenantId?: string;
      tier: "enterprise" | "pro" | "starter";
      sharePercent: number;
    };
  }>("/routing/quota-share/config", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "business:manage");
      const { tenantId, tier, sharePercent } = request.body || {};
      if (!tier || sharePercent === undefined) {
        return reply.code(400).send({ error: { code: "INPUT_REQUIRED", message: "tier and sharePercent are required" } });
      }
      const targetTenant =
        scope.permissions.includes("admin:all") && tenantId ? tenantId : scope.workspaceId;
      globalQuotaRouter.setTenantShare(targetTenant, tier, Number(sharePercent));
      return { configured: true, tenantId: targetTenant, tier, sharePercent };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { tenantId?: string } }>("/routing/quota-share", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      if (scope.permissions.includes("admin:all")) {
        if (request.query?.tenantId) {
          const share = globalQuotaRouter.getTenantShare(request.query.tenantId);
          return { shares: share ? [share] : [] };
        }
        return { shares: globalQuotaRouter.getAllShares() };
      }
      const share = globalQuotaRouter.getTenantShare(scope.workspaceId);
      return { shares: share ? [share] : [] };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 11. #189: Atomic RPM Rolling Leases
  app.post<{
    Body: {
      provider: string;
      maxRpm: number;
      requestedTokens?: number;
      tokens?: number;
      windowMs?: number;
    };
  }>("/leases/rolling", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { provider, maxRpm, requestedTokens, tokens, windowMs } = request.body || {};
      if (!provider) {
        return reply.code(400).send({ error: { code: "PROVIDER_REQUIRED", message: "provider is required" } });
      }
      const tokenCount = Number(tokens ?? requestedTokens ?? 1);
      const lease = globalLeaseManager.acquireLease({
        provider,
        maxRpm: Number(maxRpm) || 60,
        tokens: tokenCount,
        windowMs: windowMs ? Number(windowMs) : undefined,
      });
      return { provider, lease };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      leaseId: string;
    };
  }>("/leases/rolling/release", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { leaseId } = request.body || {};
      if (!leaseId) {
        return reply.code(400).send({ error: { code: "LEASE_ID_REQUIRED", message: "leaseId is required" } });
      }
      const released = globalLeaseManager.releaseLease(leaseId);
      return { leaseId, released };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { provider?: string } }>("/leases/rolling", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const leases = globalLeaseManager.getActiveLeases(request.query?.provider);
      return { leases, count: leases.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 12. #44: Isolated Group Sessions
  app.post<{
    Body: {
      title?: string;
      sessionName?: string;
      companyId?: string;
      participants?: Array<{ agentId: string; role: string; permissions?: string[] }>;
      initialTools?: string[];
      isIsolated?: boolean;
    };
  }>("/group-sessions", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "chat:use");
      const { title, sessionName, companyId, participants, initialTools, isIsolated } = request.body || {};
      const sessionTitle = title || sessionName || "Untitled Group Session";
      const session = await globalGroupSessions.createSession({
        companyId: companyId || scope.workspaceId,
        tenantId: scope.workspaceId,
        title: sessionTitle,
        participants: (participants || []).map((participant) => ({ id: participant.agentId, name: participant.agentId, type: "agent" as const, role: participant.role, joinedAt: new Date().toISOString() })),
        initialTools: initialTools || [],
        isIsolated: isIsolated ?? true,
      });
      return reply.code(201).send({ session });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { companyId?: string } }>(
    "/group-sessions/:id",
    async (request, reply) => {
      try {
        const scope = await authorize(auth, request, "workspace:read");
        const companyId = request.query?.companyId || scope.workspaceId;
        const session = await globalGroupSessions.getSession(request.params.id, companyId, scope.workspaceId);
        if (!session) {
          return reply.code(404).send({ error: { code: "SESSION_NOT_FOUND", message: "Group session not found" } });
        }
        return { session };
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.get<{ Querystring: { companyId?: string } }>("/group-sessions", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      const companyId = request.query?.companyId || scope.workspaceId;
      const sessions = await globalGroupSessions.listSessions(companyId, scope.workspaceId);
      return { sessions, count: sessions.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Params: { id: string };
    Body: {
      agentId?: string;
      userId?: string;
      name?: string;
      role?: string;
      type?: "user" | "agent";
      companyId?: string;
    };
  }>("/group-sessions/:id/participants", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "chat:use");
      const { agentId, userId, name, role, type, companyId } = request.body || {};
      const participantId = agentId || userId || name;
      if (!participantId) {
        return reply.code(400).send({ error: { code: "PARTICIPANT_ID_REQUIRED", message: "agentId or userId is required" } });
      }
      const targetCompanyId = companyId || scope.workspaceId;
      const updated = await globalGroupSessions.addParticipant(
        request.params.id,
        targetCompanyId,
        scope.workspaceId,
        {
          id: participantId,
          name: name || participantId,
          type: type || (agentId ? "agent" : "user"),
          role: role || "member",
        }
      );
      if (!updated) {
        return reply.code(404).send({ error: { code: "SESSION_NOT_FOUND", message: "Group session not found" } });
      }
      return { session: updated };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Params: { id: string };
    Body: {
      key: string;
      value: string;
      companyId?: string;
    };
  }>("/group-sessions/:id/memory", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "chat:use");
      const { key, value, companyId } = request.body || {};
      if (!key || value === undefined) {
        return reply.code(400).send({ error: { code: "KEY_VALUE_REQUIRED", message: "key and value are required" } });
      }
      const targetCompanyId = companyId || scope.workspaceId;
      const updated = await globalGroupSessions.updateIsolatedMemory(
        request.params.id,
        targetCompanyId,
        scope.workspaceId,
        key,
        String(value)
      );
      if (!updated) {
        return reply.code(404).send({ error: { code: "SESSION_NOT_FOUND", message: "Group session not found" } });
      }
      const session = await globalGroupSessions.getSession(request.params.id, targetCompanyId, scope.workspaceId);
      return { success: true, isolatedMemory: session?.sessionState?.isolatedMemory ?? {} };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 13. #46: Session Tools
  app.post<{
    Params: { id: string };
    Body: {
      toolName: string;
      description?: string;
      ttlSeconds?: number;
      metadata?: Record<string, unknown>;
    };
  }>("/group-sessions/:id/tools", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { toolName, description, ttlSeconds, metadata } = request.body || {};
      if (!toolName) {
        return reply.code(400).send({ error: { code: "TOOL_NAME_REQUIRED", message: "toolName is required" } });
      }

      const attachment = globalSessionTools.attachTool(request.params.id, toolName, {
        description,
        ttlSeconds,
        metadata,
      });
      const activeTools = globalSessionTools.getActiveTools(request.params.id);

      return { sessionId: request.params.id, toolName, attachment, tools: activeTools };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/group-sessions/:id/tools", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const tools = globalSessionTools.getActiveTools(request.params.id);
      return { sessionId: request.params.id, tools, count: tools.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string; toolName: string } }>(
    "/group-sessions/:id/tools/:toolName",
    async (request, reply) => {
      try {
        await authorize(auth, request, "chat:use");
        const detached = globalSessionTools.detachTool(request.params.id, request.params.toolName);
        const activeTools = globalSessionTools.getActiveTools(request.params.id);
        return { sessionId: request.params.id, toolName: request.params.toolName, detached, tools: activeTools };
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: {
      baseTools?: string[];
      agentRole?: string;
    };
  }>("/group-sessions/:id/tools/resolve", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { baseTools, agentRole } = request.body || {};
      const resolution = globalSessionTools.resolveEffectiveTools(
        request.params.id,
        baseTools || [],
        agentRole
      );
      return { sessionId: request.params.id, ...resolution };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
