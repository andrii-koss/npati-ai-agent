import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore, type AuthContext } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { isAdministrator } from "./admin-access";
import {
  type RoutingStrategyName,
  type StrategyResolutionResult,
} from "./routing-strategies";
import { A2AProtocolV03, type A2AAgentEndpoint, type A2AEnvelope } from "./a2a-protocol";
import {
  type AgentDescriptor,
  type DagTaskNode,
} from "./a2a-smart-conductor";
import {
  type DiscoveredAgentProfile,
} from "./a2a-protocol-extensions";
import {
  globalRoutingManager,
  globalLkgpManager,
  globalSmartRouter,
  globalHealthRegistry,
  globalOmniConductor,
  globalQuotaManager,
  globalProviderDiscovery,
  globalCostAnalyzer,
  globalMessageBus,
  globalContextManager,
  globalSubagentManager,
  globalSwarmOrchestrator,
  SUPPORTED_STRATEGIES,
  hasPermission,
} from "./a2a-control-plane-state";
import { registerA2ALifecycleRoutes } from "./a2a-control-plane-lifecycle-routes";

export * from "./a2a-control-plane-state";

export function registerA2AControlPlaneRoutes(
  app: FastifyInstance,
  deps: {
    auth?: AuthProvider;
    store?: WorkspaceStore;
  }
) {
  const requireAuth = async (req: FastifyRequest): Promise<AuthContext> => {
    if (!deps.auth) {
      return {
        userId: "dev-user",
        workspaceId: "ws-dev",

        permissions: ["*"],
      };
    }
    const scope = await deps.auth.authenticate(req);
    // The control plane (routing, quotas, message bus, registries) is one shared, process-wide state: the code-run
    // quota and every registry here serve all accounts. On a hosted installation any account could otherwise read or
    // change it for everyone, so only the installation owner and NPATI administrators may use it.
    if (!isAdministrator(scope)) {
      throw new AuthenticationError("The orchestration control plane is limited to administrators.", 403, "ADMIN_REQUIRED");
    }
    return scope;
  };

  // -------------------------------------------------------------
  // 1. Orchestration Routing Strategies & LKGP
  // -------------------------------------------------------------

  app.get("/orchestration/strategies", async (req, reply) => {
    await requireAuth(req);
    return reply.send({
      supportedStrategies: SUPPORTED_STRATEGIES,
      count: SUPPORTED_STRATEGIES.length,
      protocolVersion: A2AProtocolV03.PROTOCOL_VERSION,
    });
  });

  app.post<{
    Body: {
      strategy: string;
      options?: {
        promptTokens?: number;
        estimatedCachedTokens?: number;
        estimatedCompletionTokens?: number;
        priorityList?: string[];
        healthyProviders?: string[];
        capacities?: Array<{ provider: string; currentRpm: number; maxRpm: number }>;
        weights?: Record<string, number>;
        loads?: Array<{ provider: string; activeRequests: number; latencyMs?: number }>;
        headrooms?: Array<{ provider: string; remainingHeadroomRpm: number }>;
        resetStates?: Array<{ provider: string; resetInSeconds: number; isLimited: boolean }>;
        recoveryStates?: Array<{ provider: string; timeSinceResetSeconds: number; maxRpm: number }>;
        randomValue?: number;
        preferredProvider?: string;
      };
    };
  }>("/orchestration/resolve-strategy", async (req, reply) => {
    await requireAuth(req);
    const { strategy, options } = req.body ?? {};

    if (!strategy || !SUPPORTED_STRATEGIES.includes(strategy as RoutingStrategyName)) {
      return reply.code(400).send({
        error: {
          code: "INVALID_ROUTING_STRATEGY",
          message: `Unknown strategy '${strategy}'. Supported: ${SUPPORTED_STRATEGIES.join(", ")}`,
        },
      });
    }

    if (strategy === "lkgp") {
      const companyId = (req.body as any).companyId || "default";
      const taskType = (req.body as any).taskType || "general";
      const fallback = (req.body as any).fallbackModelId || "google/gemini-2.5-flash";
      const lkgpResult = globalLkgpManager.resolveLkgp(companyId, taskType, fallback);
      return reply.send({ result: lkgpResult });
    }

    const result = globalRoutingManager.resolveStrategy(strategy as RoutingStrategyName, options ?? {});
    return reply.send({ result });
  });

  app.post<{
    Body: {
      companyId: string;
      taskType: string;
      modelId: string;
      provider?: string;
      success: boolean;
    };
  }>("/orchestration/lkgp/record", async (req, reply) => {
    await requireAuth(req);
    const { companyId, taskType, modelId, provider, success } = req.body ?? {};

    if (!companyId || !taskType || !modelId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "companyId, taskType, and modelId are required." },
      });
    }

    if (success) {
      globalLkgpManager.recordSuccess(companyId, taskType, modelId, provider || "generic");
    } else {
      globalLkgpManager.recordFailure(companyId, taskType, modelId);
    }

    return reply.send({ recorded: true, companyId, taskType, modelId, success });
  });

  app.get<{
    Querystring: {
      companyId?: string;
      taskType?: string;
      fallbackModelId?: string;
    };
  }>("/orchestration/lkgp/resolve", async (req, reply) => {
    await requireAuth(req);
    const companyId = req.query.companyId || "default";
    const taskType = req.query.taskType || "general";
    const fallback = req.query.fallbackModelId || "google/gemini-2.5-flash";

    const result = globalLkgpManager.resolveLkgp(companyId, taskType, fallback);
    return reply.send({ result });
  });

  // -------------------------------------------------------------
  // 2. A2A Protocol v0.3 Envelopes
  // -------------------------------------------------------------

  app.post<{
    Body: {
      type: string;
      sender: A2AAgentEndpoint;
      recipient: A2AAgentEndpoint;
      payload: Record<string, unknown>;
      correlationId?: string;
      traceId?: string;
      metadata?: Record<string, unknown>;
    };
  }>("/a2a/envelope/create", async (req, reply) => {
    await requireAuth(req);
    const { type, sender, recipient, payload, correlationId, traceId, metadata } = req.body ?? {};

    if (!type || !sender || !recipient) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "type, sender, and recipient are required." },
      });
    }

    const envelope = A2AProtocolV03.createEnvelope(
      type as any,
      sender,
      recipient,
      payload ?? {},
      { correlationId, traceId, metadata }
    );

    return reply.send({ envelope });
  });

  app.post<{
    Body: {
      envelope: unknown;
    };
  }>("/a2a/envelope/validate", async (req, reply) => {
    await requireAuth(req);
    const validation = A2AProtocolV03.validateEnvelope(req.body?.envelope);
    if (!validation.valid) {
      return reply.code(400).send({
        valid: false,
        error: { code: "INVALID_A2A_ENVELOPE", message: validation.error },
      });
    }
    return reply.send({ valid: true, envelope: validation.envelope });
  });

  app.post<{
    Body: {
      incomingEnvelope: unknown;
      resultPayload: Record<string, unknown>;
    };
  }>("/a2a/envelope/response", async (req, reply) => {
    await requireAuth(req);
    const { incomingEnvelope, resultPayload } = req.body ?? {};
    const validation = A2AProtocolV03.validateEnvelope(incomingEnvelope);

    if (!validation.valid) {
      return reply.code(400).send({
        valid: false,
        error: { code: "INVALID_A2A_ENVELOPE", message: validation.error },
      });
    }

    const responseEnvelope = A2AProtocolV03.createResponseEnvelope(validation.envelope, resultPayload ?? {});
    return reply.send({ responseEnvelope });
  });

  // -------------------------------------------------------------
  // 3. A2A Smart Routing, Health Report & OmniConductor
  // -------------------------------------------------------------

  app.post<{
    Body: AgentDescriptor;
  }>("/a2a/router/register", async (req, reply) => {
    await requireAuth(req);
    const agent = req.body;
    if (!agent || !agent.agentId || !agent.companyId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "agentId and companyId are required." },
      });
    }
    globalSmartRouter.registerAgent(agent);
    return reply.send({ registered: true, agent });
  });

  app.post<{
    Body: {
      capability: "coding" | "research" | "math" | "writing" | "qa" | "general";
      companyId: string;
    };
  }>("/a2a/router/route", async (req, reply) => {
    await requireAuth(req);
    const { capability, companyId } = req.body ?? {};
    if (!capability || !companyId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "capability and companyId are required." },
      });
    }

    try {
      const routed = globalSmartRouter.routeTask(capability, companyId);
      return reply.send({ routed });
    } catch (err: any) {
      return reply.code(400).send({
        error: { code: "A2A_ROUTING_FAILED", message: err?.message || String(err) },
      });
    }
  });

  app.post<{
    Body: {
      agentId: string;
      metrics?: {
        cpuLoadPercent?: number;
        activeTasks?: number;
        memoryUsageMb?: number;
        errorRatePercent?: number;
      };
    };
  }>("/a2a/health/heartbeat", async (req, reply) => {
    await requireAuth(req);
    const { agentId, metrics } = req.body ?? {};
    if (!agentId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "agentId is required." },
      });
    }
    globalHealthRegistry.recordHeartbeat(agentId, metrics);
    return reply.send({ recorded: true, agentId });
  });

  app.get("/a2a/health/report", async (req, reply) => {
    await requireAuth(req);
    const report = globalHealthRegistry.getHealthReport();
    return reply.send({ report });
  });

  app.post<{
    Body: {
      workflowId: string;
      title: string;
      companyId: string;
      tasks: DagTaskNode[];
    };
  }>("/a2a/conductor/execute", async (req, reply) => {
    await requireAuth(req);
    const { workflowId, title, companyId, tasks } = req.body ?? {};
    if (!workflowId || !title || !companyId || !Array.isArray(tasks)) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "workflowId, title, companyId, and tasks are required." },
      });
    }

    try {
      const result = await globalOmniConductor.executeWorkflow(workflowId, title, companyId, tasks);
      return reply.send({ result });
    } catch (err: any) {
      return reply.code(400).send({
        error: { code: "OMNICONDUCTOR_WORKFLOW_FAILED", message: err?.message || String(err) },
      });
    }
  });

  // -------------------------------------------------------------
  // 4. A2A Quota Management, Provider Discovery, Cost Analysis & Capabilities
  // -------------------------------------------------------------

  app.post<{
    Body: {
      sessionId: string;
      maxTokens?: number;
      maxCostUsd?: number;
      maxDepth?: number;
    };
  }>("/a2a/quota/budget", async (req, reply) => {
    await requireAuth(req);
    const { sessionId, maxTokens, maxCostUsd, maxDepth } = req.body ?? {};
    if (!sessionId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "sessionId is required." },
      });
    }
    const budget = globalQuotaManager.setSessionBudget(sessionId, maxTokens, maxCostUsd, maxDepth);
    return reply.send({ budget });
  });

  app.post<{
    Body: {
      sessionId: string;
      requestedTokens: number;
      estimatedCostUsd: number;
      currentDepth?: number;
    };
  }>("/a2a/quota/check", async (req, reply) => {
    await requireAuth(req);
    const { sessionId, requestedTokens, estimatedCostUsd, currentDepth } = req.body ?? {};
    if (!sessionId || requestedTokens === undefined || estimatedCostUsd === undefined) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "sessionId, requestedTokens, and estimatedCostUsd are required." },
      });
    }

    const check = globalQuotaManager.checkAllowance(sessionId, requestedTokens, estimatedCostUsd, currentDepth ?? 1);
    if (!check.allowed) {
      return reply.code(400).send({
        allowed: false,
        error: { code: "A2A_QUOTA_EXCEEDED", message: check.error },
        remainingTokens: check.remainingTokens,
        remainingCostUsd: check.remainingCostUsd,
      });
    }
    return reply.send({ allowed: true, check });
  });

  app.post<{
    Body: {
      sessionId: string;
      tokens: number;
      costUsd: number;
    };
  }>("/a2a/quota/record", async (req, reply) => {
    await requireAuth(req);
    const { sessionId, tokens, costUsd } = req.body ?? {};
    if (!sessionId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "sessionId is required." },
      });
    }
    globalQuotaManager.recordUsage(sessionId, tokens, costUsd);
    return reply.send({ recorded: true, sessionId, tokens, costUsd });
  });

  app.post<{
    Body: DiscoveredAgentProfile;
  }>("/a2a/discovery/register", async (req, reply) => {
    await requireAuth(req);
    const profile = req.body;
    if (!profile || !profile.agentId || !profile.capabilities) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "agentId and capabilities are required." },
      });
    }
    globalProviderDiscovery.registerAgent(profile);
    return reply.send({ registered: true, profile });
  });

  app.get<{
    Querystring: {
      capability: string;
      minHealth?: string;
      limit?: string;
    };
  }>("/a2a/discovery", async (req, reply) => {
    await requireAuth(req);
    const capability = req.query.capability || "";
    const minHealth = req.query.minHealth ? parseFloat(req.query.minHealth) : 0.5;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 5;

    const agents = globalProviderDiscovery.discoverAgents(capability, { minHealth, limit });
    return reply.send({ agents, count: agents.length });
  });

  app.post<{
    Body: {
      traceId: string;
      agentId: string;
      parentAgentId?: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      durationMs: number;
    };
  }>("/a2a/costs/record", async (req, reply) => {
    await requireAuth(req);
    const item = req.body;
    if (!item || !item.traceId || !item.agentId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "traceId and agentId are required." },
      });
    }
    globalCostAnalyzer.recordDelegation({
      ...item,
      timestamp: new Date().toISOString(),
    });
    return reply.send({ recorded: true, traceId: item.traceId, agentId: item.agentId });
  });

  app.get<{
    Params: { traceId: string };
  }>("/a2a/costs/analyze/:traceId", async (req, reply) => {
    await requireAuth(req);
    const { traceId } = req.params;
    const summary = globalCostAnalyzer.analyzeTraceCosts(traceId);
    return reply.send({ summary });
  });

  app.get("/a2a/capabilities", async (req, reply) => {
    await requireAuth(req);
    return reply.send({
      protocolVersion: A2AProtocolV03.PROTOCOL_VERSION,
      capabilities: [
        { id: "orchestration.a2a_protocol_v03", name: "A2A Protocol v0.3", status: "VERIFIED_EXISTING" },
        { id: "orchestration.a2a_smart_routing", name: "A2A: Smart Routing", status: "VERIFIED_EXISTING" },
        { id: "orchestration.a2a_health_report", name: "A2A: Health Report", status: "VERIFIED_EXISTING" },
        { id: "system.omniconductor", name: "OmniConductor", status: "VERIFIED_EXISTING" },
        { id: "security.a2a_quota_management", name: "A2A: Quota Management", status: "VERIFIED_EXISTING" },
        { id: "orchestration.a2a_provider_discovery", name: "A2A: Provider Discovery", status: "VERIFIED_EXISTING" },
        { id: "orchestration.a2a_cost_analysis", name: "A2A: Cost Analysis", status: "VERIFIED_EXISTING" },
        { id: "orchestration.a2a_list_capabilities", name: "A2A: List Capabilities", status: "VERIFIED_EXISTING" },
        { id: "system.isolated_vs_forked_context", name: "Isolated vs Forked Context", status: "VERIFIED_EXISTING" },
        { id: "system.agent_send_session_messaging", name: "Agent Send / Session Messaging", status: "VERIFIED_EXISTING" },
        { id: "system.nested_sub-agents", name: "Nested Sub-agents", status: "VERIFIED_EXISTING" },
        { id: "system.swarm", name: "Swarm", status: "VERIFIED_EXISTING" },
      ],
      routingStrategies: SUPPORTED_STRATEGIES,
    });
  });

  // -------------------------------------------------------------
  // 5-8. Lifecycle, Context, Sub-Agents & Swarm
  // -------------------------------------------------------------
  registerA2ALifecycleRoutes(app, requireAuth);
}

