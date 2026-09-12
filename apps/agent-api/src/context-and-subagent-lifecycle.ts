import { randomUUID } from "node:crypto";
import { SubagentToolPolicyGuard, type SubagentDelegationScope } from "./subagent-tool-policy";

export interface ContextMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
}

export interface AgentExecutionContext {
  id: string;
  agentId: string;
  sessionId: string;
  mode: "isolated" | "forked";
  parentContextId?: string;
  forkTimestamp?: string;
  systemPrompt?: string;
  messages: ContextMessage[];
  variables: Record<string, unknown>;
  memorySnapshots: string[];
  allowedTools: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SubagentNode {
  agentId: string;
  name: string;
  parentAgentId?: string;
  rootAgentId: string;
  depth: number;
  ancestorIds: string[];
  allowedTools: string[];
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  cancellationReason?: string;
  createdAt: string;
  children: string[]; // IDs of child sub-agents
  abortController: AbortController;
}

export class ContextLifecycleManager {
  private readonly contexts = new Map<string, AgentExecutionContext>();

  /**
   * 1. Create a pristine, isolated execution context.
   * Zero leakage from any parent state.
   */
  createIsolatedContext(options: {
    agentId: string;
    sessionId: string;
    systemPrompt?: string;
    inputParameters?: Record<string, unknown>;
    allowedTools?: string[];
  }): AgentExecutionContext {
    const id = `ctx_iso_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    const context: AgentExecutionContext = {
      id,
      agentId: options.agentId,
      sessionId: options.sessionId,
      mode: "isolated",
      systemPrompt: options.systemPrompt,
      messages: options.systemPrompt
        ? [
            {
              id: `msg_${randomUUID().slice(0, 8)}`,
              role: "system",
              content: options.systemPrompt,
              timestamp: now,
            },
          ]
        : [],
      variables: options.inputParameters ? { ...options.inputParameters } : {},
      memorySnapshots: [],
      allowedTools: options.allowedTools ? [...options.allowedTools] : ["*"],
      createdAt: now,
      updatedAt: now,
    };

    this.contexts.set(id, context);
    return context;
  }

  /**
   * 2. Fork an existing parent context.
   * Copy-on-write snapshot of messages, variables, and memory.
   * Mutations in the forked context do not alter the parent.
   */
  forkContext(options: {
    parentContextId: string;
    agentId: string;
    sessionId?: string;
    allowedTools?: string[];
  }): AgentExecutionContext {
    const parent = this.contexts.get(options.parentContextId);
    if (!parent) {
      throw new Error(`PARENT_CONTEXT_NOT_FOUND: Context '${options.parentContextId}' does not exist.`);
    }

    const id = `ctx_fork_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    const forked: AgentExecutionContext = {
      id,
      agentId: options.agentId,
      sessionId: options.sessionId ?? parent.sessionId,
      mode: "forked",
      parentContextId: parent.id,
      forkTimestamp: now,
      systemPrompt: parent.systemPrompt,
      // Deep-copy messages to ensure copy-on-write
      messages: parent.messages.map((m) => ({ ...m })),
      // Deep-copy variables
      variables: JSON.parse(JSON.stringify(parent.variables)),
      // Snapshot memory
      memorySnapshots: [...parent.memorySnapshots],
      allowedTools: options.allowedTools ? [...options.allowedTools] : [...parent.allowedTools],
      createdAt: now,
      updatedAt: now,
    };

    this.contexts.set(id, forked);
    return forked;
  }

  /**
   * Mutate context locally (append message, update variable, or add memory snapshot)
   */
  mutateContext(
    contextId: string,
    mutation: {
      message?: { role: "system" | "user" | "assistant" | "tool"; content: string };
      variables?: Record<string, unknown>;
      memorySnippet?: string;
    }
  ): AgentExecutionContext {
    const context = this.contexts.get(contextId);
    if (!context) {
      throw new Error(`CONTEXT_NOT_FOUND: Context '${contextId}' does not exist.`);
    }

    const now = new Date().toISOString();

    if (mutation.message) {
      context.messages.push({
        id: `msg_${randomUUID().slice(0, 8)}`,
        role: mutation.message.role,
        content: mutation.message.content,
        timestamp: now,
      });
    }

    if (mutation.variables) {
      Object.assign(context.variables, mutation.variables);
    }

    if (mutation.memorySnippet) {
      context.memorySnapshots.push(mutation.memorySnippet);
    }

    context.updatedAt = now;
    return context;
  }

  /**
   * Explicitly merge child context back into parent context
   */
  mergeContext(
    sourceContextId: string,
    targetContextId: string,
    options: {
      strategy?: "append_messages" | "overwrite_vars" | "full";
    } = {}
  ): AgentExecutionContext {
    const source = this.contexts.get(sourceContextId);
    const target = this.contexts.get(targetContextId);

    if (!source || !target) {
      throw new Error("CONTEXT_NOT_FOUND: Source or target context does not exist.");
    }

    const strategy = options.strategy ?? "full";
    const now = new Date().toISOString();

    if (strategy === "append_messages" || strategy === "full") {
      // Find new messages added after fork
      const targetMessageIds = new Set(target.messages.map((m) => m.id));
      for (const msg of source.messages) {
        if (!targetMessageIds.has(msg.id)) {
          target.messages.push({ ...msg });
        }
      }
    }

    if (strategy === "overwrite_vars" || strategy === "full") {
      Object.assign(target.variables, source.variables);
      target.memorySnapshots = Array.from(new Set([...target.memorySnapshots, ...source.memorySnapshots]));
    }

    target.updatedAt = now;
    return target;
  }

  getContext(contextId: string): AgentExecutionContext | undefined {
    return this.contexts.get(contextId);
  }
}

export class NestedSubagentManager {
  private readonly nodes = new Map<string, SubagentNode>();
  private readonly toolGuard: SubagentToolPolicyGuard;
  private readonly maxDepth: number;
  private readonly maxChildrenPerAgent: number;

  constructor(options: { maxDepth?: number; maxChildrenPerAgent?: number; toolGuard?: SubagentToolPolicyGuard } = {}) {
    this.maxDepth = options.maxDepth ?? 4;
    this.maxChildrenPerAgent = options.maxChildrenPerAgent ?? 5;
    this.toolGuard = options.toolGuard ?? new SubagentToolPolicyGuard();
  }

  /**
   * Spawn a nested sub-agent under a parent agent with depth, cycle, and privilege escalation guards
   */
  spawnSubagent(params: {
    agentId: string;
    name: string;
    parentAgentId?: string;
    parentAllowedTools?: string[];
    requestedTools?: string[];
  }): SubagentNode {
    let depth = 1;
    let rootAgentId = params.agentId;
    let ancestorIds: string[] = [];

    if (params.parentAgentId) {
      const parent = this.nodes.get(params.parentAgentId);
      if (!parent) {
        throw new Error(`PARENT_AGENT_NOT_FOUND: Parent agent '${params.parentAgentId}' not found.`);
      }

      rootAgentId = parent.rootAgentId;
      ancestorIds = [...parent.ancestorIds, parent.agentId];

      // Check cycle protection first
      if (ancestorIds.includes(params.agentId)) {
        throw new Error(
          `RECURSIVE_CYCLE_DETECTED: Agent '${params.agentId}' already exists in delegation chain [${ancestorIds.join(" -> ")}].`
        );
      }

      // Check fan-out limit
      if (parent.children.length >= this.maxChildrenPerAgent) {
        throw new Error(
          `MAX_CHILDREN_EXCEEDED: Parent agent '${params.parentAgentId}' reached max child limit of ${this.maxChildrenPerAgent}.`
        );
      }

      // Check depth limit
      depth = parent.depth + 1;
      if (depth > this.maxDepth) {
        throw new Error(
          `NESTED_SUBAGENT_DEPTH_EXCEEDED: Delegation depth ${depth} exceeds max permissible depth of ${this.maxDepth}.`
        );
      }

      // Privilege escalation check
      const parentTools = params.parentAllowedTools ?? parent.allowedTools;
      const evaluation = this.toolGuard.evaluateSubagentTools({
        parentAgentId: parent.agentId,
        parentAllowedTools: parentTools,
        childAgentId: params.agentId,
        childBaseTools: params.requestedTools ?? parentTools,
        delegationAllowedTools: params.requestedTools,
      });

      if (evaluation.escalationAttempts.length > 0) {
        throw new Error(
          `PRIVILEGE_ESCALATION_BLOCKED: Child requested tools [${evaluation.escalationAttempts.join(", ")}] not possessed by parent.`
        );
      }
    }

    const node: SubagentNode = {
      agentId: params.agentId,
      name: params.name,
      parentAgentId: params.parentAgentId,
      rootAgentId,
      depth,
      ancestorIds,
      allowedTools: params.requestedTools ?? ["*"],
      status: "running",
      createdAt: new Date().toISOString(),
      children: [],
      abortController: new AbortController(),
    };

    this.nodes.set(params.agentId, node);

    if (params.parentAgentId) {
      const parent = this.nodes.get(params.parentAgentId)!;
      parent.children.push(params.agentId);
    }

    return node;
  }

  /**
   * Cancel an agent and propagate cancellation down the entire descendant tree
   */
  cancelAgent(agentId: string, reason = "Parent delegation cancelled"): { cancelledAgentIds: string[] } {
    const root = this.nodes.get(agentId);
    if (!root) {
      throw new Error(`AGENT_NOT_FOUND: Agent '${agentId}' does not exist.`);
    }

    const cancelledAgentIds: string[] = [];

    const cancelRecursive = (currentId: string) => {
      const node = this.nodes.get(currentId);
      if (!node) return;

      if (node.status === "running" || node.status === "pending") {
        node.status = "cancelled";
        node.cancellationReason = reason;
        node.abortController.abort();
        cancelledAgentIds.push(node.agentId);
      }

      for (const childId of node.children) {
        cancelRecursive(childId);
      }
    };

    cancelRecursive(agentId);
    return { cancelledAgentIds };
  }

  getNode(agentId: string): SubagentNode | undefined {
    return this.nodes.get(agentId);
  }

  getTree(rootAgentId: string): SubagentNode[] {
    const results: SubagentNode[] = [];
    const collect = (id: string) => {
      const node = this.nodes.get(id);
      if (!node) return;
      results.push(node);
      for (const childId of node.children) {
        collect(childId);
      }
    };
    collect(rootAgentId);
    return results;
  }
}
