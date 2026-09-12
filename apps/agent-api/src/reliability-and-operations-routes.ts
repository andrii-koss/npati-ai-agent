import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AuthProvider } from "./auth";
import type { WorkspaceStore } from "@npati/workspace";
import { AuthenticationError } from "./auth";
import { CacheManagementService } from "./output-styles-eval-and-cache";
import { DatabaseBackupManager, SessionSearchEngine } from "./telemetry-backups-and-session-search";
import { SessionPruningManager, type PrunableSession } from "./sessions-custom-models-and-chunking";
import { AgentEvaluationFramework, type EvalCriteria } from "./evaluation-and-webhook-retries";
import {
  CompressionPresetManager,
  AdaptiveContextBudgetManager,
  PerRequestCompressionOverrideManager,
  type CompressionPresetName,
} from "./context-compression-presets-and-budget";
import { OutputStyleModifier, CompressionEvalHarness, type OutputStyleType } from "./output-styles-eval-and-cache";
import { AdaptiveAdmissionQueue, SelfHealingAutoCombo, type PriorityTier } from "./resilience-admission-queue";
import { QuotaShareRouter } from "./routing-transparency-and-dedup";
import { AtomicRpmLeaseManager } from "./atomic-rpm-rolling-leases";
import { GroupSessionManager } from "./group-sessions";
import { SessionToolRegistry } from "./session-tools";

// Shared singletons for production runtime operational components
export const globalCacheService = new CacheManagementService();
export const globalBackupManager = new DatabaseBackupManager();
export const globalSessionSearch = new SessionSearchEngine();
export const globalAdmissionQueue = new AdaptiveAdmissionQueue({ maxConcurrent: 20, maxQueueLength: 200 });
export const globalQuotaRouter = new QuotaShareRouter();
export const globalLeaseManager = new AtomicRpmLeaseManager(60_000);
export const globalGroupSessions = new GroupSessionManager();
export const globalSessionTools = new SessionToolRegistry();

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
  _store?: WorkspaceStore
) {
  // 1. #176 & #202: Semantic Cache Stats & Flush
  app.get("/cache/stats", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      const stats = globalCacheService.getStats(scope.workspaceId);
      return { stats };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: { prefix?: string; flushAll?: boolean } }>("/cache/flush", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "business:manage");
      const flushAll = Boolean(request.body?.flushAll && scope.permissions.includes("admin:all"));
      const result = globalCacheService.flush(
        flushAll ? undefined : { tenantId: scope.workspaceId, prefix: request.body?.prefix }
      );
      return { ...result, scope: flushAll ? "global" : scope.workspaceId };
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

  app.get("/admin/backups", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const snapshots = globalBackupManager.listSnapshots();
      return { snapshots, count: snapshots.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { snapshotId: string }; Body: { content: string } }>(
    "/admin/backups/:snapshotId/verify",
    async (request, reply) => {
      try {
        await authorize(auth, request, "business:manage");
        const verified = globalBackupManager.verifySnapshot(
          request.params.snapshotId,
          request.body?.content || ""
        );
        return { snapshotId: request.params.snapshotId, verified };
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  // 3. #207: Session Search
  app.get<{ Querystring: { query: string; limit?: string } }>("/sessions/search", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      const query = request.query.query;
      if (!query) {
        return reply.code(400).send({ error: { code: "QUERY_REQUIRED", message: "query parameter is required" } });
      }
      const limit = Number(request.query.limit || 20);
      const results = globalSessionSearch.search(query, { tenantId: scope.workspaceId, limit });
      return { query, results, count: results.length };
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
      return reply.code(201).send({ indexed: true, sessionId });
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
      const normalizedSessions: PrunableSession[] = sessions.map((s: any) => ({
        sessionId: String(s.sessionId || ""),
        tenantId: String(s.tenantId || scope.workspaceId),
        lastActiveAt: typeof s.lastActiveAt === "string" ? new Date(s.lastActiveAt).getTime() : Number(s.lastActiveAt || Date.now()),
        messages: Array.isArray(s.messages) ? s.messages : [],
        isArchived: Boolean(s.isArchived),
      }));
      const pruned = SessionPruningManager.prune(normalizedSessions, {
        maxInactiveDays,
        maxMessagesPerSession,
        archiveBeforeDelete,
      });
      return { result: pruned.result, activeCount: pruned.activeSessions.length };
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

  // 6. #197, #198, #199, #201: Context Compression Presets, Budget & Eval Harness
  app.post<{
    Body: {
      text: string;
      preset?: CompressionPresetName;
      modelId?: string;
      headerOverride?: string;
      runEvalHarness?: boolean;
    };
  }>("/compression/apply", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { text, preset, modelId, headerOverride, runEvalHarness } = request.body || {};
      if (!text) {
        return reply.code(400).send({ error: { code: "TEXT_REQUIRED", message: "text is required" } });
      }

      // Check header override or body override (#199)
      const override = PerRequestCompressionOverrideManager.resolveOverride(
        request.headers as any,
        preset ? { preset: preset as any } : undefined
      );
      const effectivePreset = override.bypass ? "minimal" : override.preset;

      // Apply preset (#197)
      const compressed = CompressionPresetManager.applyPreset(text, effectivePreset as any);

      // Adaptive budget calculation (#198)
      const budget = AdaptiveContextBudgetManager.evaluateBudget(
        Math.ceil(text.length / 4),
        128_000
      );

      // Optional compression eval harness (#201)
      let evalResult;
      if (runEvalHarness) {
        evalResult = CompressionEvalHarness.evaluate(text, compressed.compressedText);
      }

      const originalTokens = Math.ceil(text.length / 4);
      const estimatedCompressedTokens = Math.ceil(compressed.compressedText.length / 4);
      const reductionPercent = originalTokens > 0 ? Math.max(0, Math.round(((originalTokens - estimatedCompressedTokens) / originalTokens) * 100)) : 0;

      return {
        originalTokens,
        compressedTokens: estimatedCompressedTokens,
        reductionPercent,
        appliedPreset: effectivePreset,
        tokensSaved: compressed.tokensSaved,
        budget,
        compressedText: compressed.compressedText,
        evaluation: evalResult,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 7. #200: Output Styles
  app.post<{
    Body: {
      messages: Array<{ role: string; content: string }>;
      style: OutputStyleType;
    };
  }>("/styles/apply", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { messages, style } = request.body || {};
      if (!Array.isArray(messages) || !style) {
        return reply.code(400).send({ error: { code: "INPUT_REQUIRED", message: "messages array and style are required" } });
      }
      const modified = OutputStyleModifier.applyOutputStyle(messages, style);
      return { style, modifiedMessages: modified };
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
      tenantId: string;
      tier: "enterprise" | "pro" | "starter";
      sharePercent: number;
      currentSystemRpm: number;
      systemMaxRpm: number;
    };
  }>("/routing/quota-share", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const { tenantId, tier, sharePercent, currentSystemRpm, systemMaxRpm } = request.body || {};
      if (!tenantId || !tier) {
        return reply.code(400).send({ error: { code: "INPUT_REQUIRED", message: "tenantId and tier are required" } });
      }
      globalQuotaRouter.setTenantShare(tenantId, tier, sharePercent || 30);
      const decision = globalQuotaRouter.isAdmitted(tenantId, currentSystemRpm || 50, systemMaxRpm || 100);
      return { tenantId, tier, decision };
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
    };
  }>("/leases/rolling", async (request, reply) => {
    try {
      await authorize(auth, request, "chat:use");
      const { provider, maxRpm, requestedTokens } = request.body || {};
      if (!provider) {
        return reply.code(400).send({ error: { code: "PROVIDER_REQUIRED", message: "provider is required" } });
      }
      const lease = globalLeaseManager.acquireLease({
        provider,
        maxRpm: Number(maxRpm) || 60,
        tokens: Number(requestedTokens) || 100,
      });
      return { provider, lease };
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
}
