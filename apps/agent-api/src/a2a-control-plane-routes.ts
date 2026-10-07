import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import {
  RoutingStrategiesManager,
  type RoutingStrategyName,
  type StrategyResolutionResult,
} from "./routing-strategies";
import { LkgpStrategyManager } from "./lkgp-router";
import { A2AProtocolV03, type A2AAgentEndpoint, type A2AEnvelope } from "./a2a-protocol";
import {
  A2ASmartRouter,
  A2AHealthRegistry,
  OmniConductor,
  type AgentDescriptor,
  type DagTaskNode,
} from "./a2a-smart-conductor";
import {
  A2AQuotaManager,
  A2AProviderDiscovery,
  A2ACostAnalyzer,
  type DiscoveredAgentProfile,
} from "./a2a-protocol-extensions";
import { MultiAgentMessageBus } from "./multi-agent-message-bus";
import {
  ContextLifecycleManager,
  NestedSubagentManager,
} from "./context-and-subagent-lifecycle";
import { SwarmOrchestrator } from "./swarm-audio-translation-video";

export const globalRoutingManager = new RoutingStrategiesManager();
export const globalLkgpManager = new LkgpStrategyManager();
export const globalSmartRouter = new A2ASmartRouter();
export const globalHealthRegistry = new A2AHealthRegistry();
export const globalOmniConductor = new OmniConductor(globalSmartRouter, globalHealthRegistry);
export const globalQuotaManager = new A2AQuotaManager();
export const globalProviderDiscovery = new A2AProviderDiscovery();
export const globalCostAnalyzer = new A2ACostAnalyzer();
export const globalMessageBus = new MultiAgentMessageBus();
export const globalContextManager = new ContextLifecycleManager();
export const globalSubagentManager = new NestedSubagentManager();
export const globalSwarmOrchestrator = new SwarmOrchestrator();

export const SUPPORTED_STRATEGIES: RoutingStrategyName[] = [
  "cost-optimized",
  "context-optimized",
  "cache-optimized",
  "priority",
  "fill-first",
  "weighted",
  "round-robin",
  "p2c",
  "least-used",
  "random",
  "strict-random",
  "headroom",
  "reset-window",
  "reset-aware",
  "context-relay",
  "lkgp",
];

function hasPermission(scope: AuthContext, permission: string): boolean {
  if (
    scope.permissions.includes("*") ||
    scope.permissions.includes("admin:all") ||
    scope.permissions.includes("owner")
  ) {
    return true;
  }
  if (scope.permissions.includes(permission)) return true;
  if (permission === "workspace:read") {
    return (
      scope.permissions.includes("workspace:read") ||
      scope.permissions.includes("workspace:write") ||
      scope.permissions.includes("business:manage")
    );
  }
  return false;
}

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
    return deps.auth.authenticate(req);
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
  // 5. Multi-Agent Message Bus & Session Messaging
  // -------------------------------------------------------------

  app.post<{
    Body: {
      sessionId: string;
      threadId?: string;
      fromAgentId: string;
      toAgentId: string;
      messageType?: "text" | "task_request" | "task_response" | "state_sync" | "event";
      content: string;
      data?: Record<string, unknown>;
    };
  }>("/orchestration/messages/send", async (req, reply) => {
    await requireAuth(req);
    const { sessionId, threadId, fromAgentId, toAgentId, messageType, content, data } = req.body ?? {};

    if (!sessionId || !fromAgentId || !toAgentId || !content) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "sessionId, fromAgentId, toAgentId, and content are required." },
      });
    }

    const message = globalMessageBus.sendMessage({
      sessionId,
      threadId,
      fromAgentId,
      toAgentId,
      messageType,
      content,
      data,
    });

    return reply.send({ message });
  });

  app.post<{
    Body: {
      sessionId: string;
      fromAgentId: string;
      content: string;
      allSessionAgentIds: string[];
      data?: Record<string, unknown>;
    };
  }>("/orchestration/messages/broadcast", async (req, reply) => {
    await requireAuth(req);
    const { sessionId, fromAgentId, content, allSessionAgentIds, data } = req.body ?? {};

    if (!sessionId || !fromAgentId || !content || !Array.isArray(allSessionAgentIds)) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "sessionId, fromAgentId, content, and allSessionAgentIds are required." },
      });
    }

    const messages = globalMessageBus.broadcastToSession(sessionId, fromAgentId, content, allSessionAgentIds, data);
    return reply.send({ messages, count: messages.length });
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { sessionId?: string };
  }>("/orchestration/messages/inbox/:agentId", async (req, reply) => {
    await requireAuth(req);
    const { agentId } = req.params;
    const { sessionId } = req.query;

    const messages = globalMessageBus.getInbox(agentId, sessionId);
    return reply.send({ agentId, messages, count: messages.length });
  });

  app.post<{
    Body: { messageId: string; agentId: string };
  }>("/orchestration/messages/mark-delivered", async (req, reply) => {
    await requireAuth(req);
    const { messageId, agentId } = req.body ?? {};
    if (!messageId || !agentId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "messageId and agentId are required." },
      });
    }
    const delivered = globalMessageBus.markDelivered(messageId, agentId);
    return reply.send({ delivered, messageId, agentId });
  });

  app.get<{
    Params: { sessionId: string };
  }>("/orchestration/messages/history/:sessionId", async (req, reply) => {
    await requireAuth(req);
    const { sessionId } = req.params;
    const history = globalMessageBus.getSessionHistory(sessionId);
    return reply.send({ sessionId, history, count: history.length });
  });

  // -------------------------------------------------------------
  // 6. Context Isolation & Forking
  // -------------------------------------------------------------

  app.post<{
    Body: {
      agentId: string;
      sessionId: string;
      systemPrompt?: string;
      inputParameters?: Record<string, unknown>;
      allowedTools?: string[];
    };
  }>("/orchestration/context/isolated", async (req, reply) => {
    await requireAuth(req);
    const { agentId, sessionId, systemPrompt, inputParameters, allowedTools } = req.body ?? {};
    if (!agentId || !sessionId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "agentId and sessionId are required." },
      });
    }

    const context = globalContextManager.createIsolatedContext({
      agentId,
      sessionId,
      systemPrompt,
      inputParameters,
      allowedTools,
    });
    return reply.send({ context });
  });

  app.post<{
    Body: {
      parentContextId: string;
      agentId: string;
      sessionId?: string;
      allowedTools?: string[];
    };
  }>("/orchestration/context/fork", async (req, reply) => {
    await requireAuth(req);
    const { parentContextId, agentId, sessionId, allowedTools } = req.body ?? {};
    if (!parentContextId || !agentId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "parentContextId and agentId are required." },
      });
    }

    try {
      const context = globalContextManager.forkContext({ parentContextId, agentId, sessionId, allowedTools });
      return reply.send({ context });
    } catch (err: any) {
      return reply.code(400).send({
        error: { code: "CONTEXT_FORK_FAILED", message: err?.message || String(err) },
      });
    }
  });

  app.post<{
    Body: {
      contextId: string;
      message?: { role: "system" | "user" | "assistant" | "tool"; content: string };
      variables?: Record<string, unknown>;
      memorySnippet?: string;
    };
  }>("/orchestration/context/mutate", async (req, reply) => {
    await requireAuth(req);
    const { contextId, message, variables, memorySnippet } = req.body ?? {};
    if (!contextId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "contextId is required." },
      });
    }

    try {
      const context = globalContextManager.mutateContext(contextId, { message, variables, memorySnippet });
      return reply.send({ context });
    } catch (err: any) {
      return reply.code(400).send({
        error: { code: "CONTEXT_MUTATION_FAILED", message: err?.message || String(err) },
      });
    }
  });

  app.post<{
    Body: {
      sourceContextId: string;
      targetContextId: string;
      strategy?: "append_messages" | "overwrite_vars" | "full";
    };
  }>("/orchestration/context/merge", async (req, reply) => {
    await requireAuth(req);
    const { sourceContextId, targetContextId, strategy } = req.body ?? {};
    if (!sourceContextId || !targetContextId) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "sourceContextId and targetContextId are required." },
      });
    }

    try {
      const merged = globalContextManager.mergeContext(sourceContextId, targetContextId, { strategy });
      return reply.send({ merged });
    } catch (err: any) {
      return reply.code(400).send({
        error: { code: "CONTEXT_MERGE_FAILED", message: err?.message || String(err) },
      });
    }
  });

  app.get<{
    Params: { contextId: string };
  }>("/orchestration/context/:contextId", async (req, reply) => {
    await requireAuth(req);
    const { contextId } = req.params;
    const context = globalContextManager.getContext(contextId);
    if (!context) {
      return reply.code(404).send({
        error: { code: "CONTEXT_NOT_FOUND", message: `Context '${contextId}' not found.` },
      });
    }
    return reply.send({ context });
  });

  // -------------------------------------------------------------
  // 7. Nested Sub-Agents with Bounded Depth & Cancellation Propagation
  // -------------------------------------------------------------

  app.post<{
    Body: {
      agentId: string;
      name: string;
      parentAgentId?: string;
      parentAllowedTools?: string[];
      requestedTools?: string[];
    };
  }>("/orchestration/subagents/spawn", async (req, reply) => {
    await requireAuth(req);
    const { agentId, name, parentAgentId, parentAllowedTools, requestedTools } = req.body ?? {};
    if (!agentId || !name) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "agentId and name are required." },
      });
    }

    try {
      const node = globalSubagentManager.spawnSubagent({
        agentId,
        name,
        parentAgentId,
        parentAllowedTools,
        requestedTools,
      });
      return reply.send({
        spawned: true,
        subagent: {
          agentId: node.agentId,
          name: node.name,
          parentAgentId: node.parentAgentId,
          rootAgentId: node.rootAgentId,
          depth: node.depth,
          ancestorIds: node.ancestorIds,
          allowedTools: node.allowedTools,
          /**
           * C12: `false` means the grant contained a `*`/`all` with no canonical universe supplied on this route,
           * so `allowedTools` is deliberately empty rather than "everything". Reported instead of hidden: a node
           * whose scope could not be resolved is a delegation record that needs a real tool list.
           */
          capabilityScopeResolved: node.capabilityScopeResolved,
          status: node.status,
          createdAt: node.createdAt,
        },
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      let code = "SUBAGENT_SPAWN_FAILED";
      if (msg.includes("DEPTH_EXCEEDED")) code = "NESTED_SUBAGENT_DEPTH_EXCEEDED";
      else if (msg.includes("CYCLE_DETECTED")) code = "RECURSIVE_CYCLE_DETECTED";
      else if (msg.includes("PRIVILEGE_ESCALATION")) code = "PRIVILEGE_ESCALATION_BLOCKED";
      else if (msg.includes("MAX_CHILDREN")) code = "MAX_CHILDREN_EXCEEDED";

      return reply.code(400).send({
        error: { code, message: msg },
      });
    }
  });

  app.post<{
    Params: { agentId: string };
    Body: { reason?: string };
  }>("/orchestration/subagents/:agentId/cancel", async (req, reply) => {
    await requireAuth(req);
    const { agentId } = req.params;
    const { reason } = req.body ?? {};

    try {
      const result = globalSubagentManager.cancelAgent(agentId, reason);
      return reply.send({
        cancelled: true,
        agentId,
        cancelledCount: result.cancelledAgentIds.length,
        cancelledAgentIds: result.cancelledAgentIds,
      });
    } catch (err: any) {
      return reply.code(404).send({
        error: { code: "AGENT_NOT_FOUND", message: err?.message || String(err) },
      });
    }
  });

  app.get<{
    Params: { agentId: string };
  }>("/orchestration/subagents/:agentId/tree", async (req, reply) => {
    await requireAuth(req);
    const { agentId } = req.params;
    const tree = globalSubagentManager.getTree(agentId);
    return reply.send({
      rootAgentId: agentId,
      nodesCount: tree.length,
      tree: tree.map((n) => ({
        agentId: n.agentId,
        name: n.name,
        parentAgentId: n.parentAgentId,
        depth: n.depth,
        children: n.children,
        status: n.status,
        cancellationReason: n.cancellationReason,
      })),
    });
  });

  // -------------------------------------------------------------
  // 8. Swarm Multi-Agent Routines & Dynamic Handoff
  // -------------------------------------------------------------

  app.post<{
    Body: {
      name: string;
      instructions: string;
      handoffs: string[];
    };
  }>("/orchestration/swarm/register", async (req, reply) => {
    await requireAuth(req);
    const { name, instructions, handoffs } = req.body ?? {};
    if (!name || !instructions) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "name and instructions are required." },
      });
    }

    globalSwarmOrchestrator.registerAgent({
      name,
      instructions,
      handoffs: handoffs ?? [],
    });

    return reply.send({ registered: true, name, handoffs });
  });

  app.post<{
    Body: {
      startingAgent: string;
      userMessage: string;
    };
  }>("/orchestration/swarm/turn", async (req, reply) => {
    await requireAuth(req);
    const { startingAgent, userMessage } = req.body ?? {};
    if (!startingAgent || !userMessage) {
      return reply.code(400).send({
        error: { code: "MISSING_REQUIRED_FIELDS", message: "startingAgent and userMessage are required." },
      });
    }

    try {
      const result = globalSwarmOrchestrator.executeTurn(startingAgent, userMessage);
      return reply.send({ result });
    } catch (err: any) {
      return reply.code(400).send({
        error: { code: "SWARM_EXECUTION_FAILED", message: err?.message || String(err) },
      });
    }
  });
}
