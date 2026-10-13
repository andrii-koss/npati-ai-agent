import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthContext } from "@npati/workspace";
import {
  globalMessageBus,
  globalContextManager,
  globalSubagentManager,
  globalSwarmOrchestrator,
} from "./a2a-control-plane-state";

export function registerA2ALifecycleRoutes(
  app: FastifyInstance,
  requireAuth: (req: FastifyRequest) => Promise<AuthContext>
) {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        error: { code: "CONTEXT_FORK_FAILED", message: msg },
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        error: { code: "CONTEXT_MUTATION_FAILED", message: msg },
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        error: { code: "CONTEXT_MERGE_FAILED", message: msg },
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
          capabilityScopeResolved: node.capabilityScopeResolved,
          status: node.status,
          createdAt: node.createdAt,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(404).send({
        error: { code: "AGENT_NOT_FOUND", message: msg },
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        error: { code: "SWARM_EXECUTION_FAILED", message: msg },
      });
    }
  });
}
