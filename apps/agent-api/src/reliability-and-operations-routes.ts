import type { FastifyInstance } from "fastify";
import type { AuthProvider } from "./auth";
import type { WorkspaceStore } from "@npati/workspace";
import {
  OutputStyleModifier,
  CompressionEvalHarness,
  type OutputStyleType,
  type CompressionEvalOptions,
  type CompressionEvalReport,
} from "./output-styles-eval-and-cache";
import {
  AdaptiveAdmissionQueue,
  AdmissionError,
  SelfHealingAutoCombo,
  type PriorityTier,
} from "./resilience-admission-queue";
import {
  globalAdmissionQueue,
  globalQuotaRouter,
  globalLeaseManager,
  globalGroupSessions,
  globalSessionTools,
  authorize,
  sendError,
} from "./reliability-operations-singletons";
import { registerReliabilityCacheAndBackupRoutes } from "./reliability-cache-and-backup-routes";
import { registerReliabilitySessionAndEvalRoutes } from "./reliability-session-and-eval-routes";

export * from "./reliability-operations-singletons";

export function registerReliabilityAndOperationsRoutes(
  app: FastifyInstance,
  auth: AuthProvider,
  store?: WorkspaceStore
) {
  if ((store as any)?.pool) {
    globalGroupSessions.setPool((store as any).pool);
  }

  registerReliabilityCacheAndBackupRoutes(app, auth);
  registerReliabilitySessionAndEvalRoutes(app, auth);

  app.get("/runtime/admission", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      return globalAdmissionQueue.snapshot();
    } catch (error) { return sendError(reply, error); }
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

  const ownGroupSession = async (scope: { workspaceId: string }, request: { params: { id: string }; query?: unknown }) =>
    Boolean(await globalGroupSessions.getSession(request.params.id, (request.query as { companyId?: string } | undefined)?.companyId || scope.workspaceId, scope.workspaceId));

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
      const scope = await authorize(auth, request, "chat:use");
      // Session tools live in one process-wide map: only the session's own workspace may read or change them.
      if (!(await ownGroupSession(scope, request))) return reply.code(404).send({ error: { code: "SESSION_NOT_FOUND", message: "Group session not found" } });
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
      const scope = await authorize(auth, request, "workspace:read");
      // Session tools live in one process-wide map: only the session's own workspace may read or change them.
      if (!(await ownGroupSession(scope, request))) return reply.code(404).send({ error: { code: "SESSION_NOT_FOUND", message: "Group session not found" } });
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
        const scope = await authorize(auth, request, "chat:use");
        // Session tools live in one process-wide map: only the session's own workspace may read or change them.
        if (!(await ownGroupSession(scope, request))) return reply.code(404).send({ error: { code: "SESSION_NOT_FOUND", message: "Group session not found" } });
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
      const scope = await authorize(auth, request, "chat:use");
      // Session tools live in one process-wide map: only the session's own workspace may read or change them.
      if (!(await ownGroupSession(scope, request))) return reply.code(404).send({ error: { code: "SESSION_NOT_FOUND", message: "Group session not found" } });
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
