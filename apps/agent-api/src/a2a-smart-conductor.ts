import { randomUUID } from "node:crypto";
import { A2AProtocolV03, type A2AAgentEndpoint, type A2AEnvelope } from "./a2a-protocol";

export interface AgentDescriptor {
  agentId: string;
  name: string;
  companyId: string;
  tenantId: string;
  specializations: Array<"coding" | "research" | "math" | "writing" | "qa" | "general">;
  maxConcurrentTasks: number;
  activeTasks: number;
  averageLatencyMs: number;
  isAvailable: boolean;
}

export interface AgentHealthMetrics {
  agentId: string;
  status: "healthy" | "degraded" | "offline";
  cpuLoadPercent: number;
  activeTasks: number;
  memoryUsageMb: number;
  errorRatePercent: number;
  lastHeartbeatTimestamp: number;
}

export interface ClusterHealthReport {
  totalAgents: number;
  healthyCount: number;
  degradedCount: number;
  offlineCount: number;
  clusterStatus: "healthy" | "degraded" | "critical";
  agents: AgentHealthMetrics[];
  generatedAt: string;
}

export interface DagTaskNode {
  id: string;
  title: string;
  requiredCapability: "coding" | "research" | "math" | "writing" | "qa" | "general";
  dependencies: string[]; // IDs of tasks that must finish before this task runs
  assignedAgentId?: string;
  status: "pending" | "running" | "completed" | "failed";
  output?: string;
  error?: string;
}

export interface WorkflowExecutionResult {
  workflowId: string;
  title: string;
  status: "completed" | "failed";
  tasks: DagTaskNode[];
  totalDurationMs: number;
  summary: Record<string, string>;
}

export class A2ASmartRouter {
  private readonly agents = new Map<string, AgentDescriptor>();

  registerAgent(descriptor: AgentDescriptor): void {
    this.agents.set(descriptor.agentId, descriptor);
  }

  /**
   * 1. A2A: Smart Routing
   * Selects best agent for a task based on capability match, available capacity, and latency
   */
  routeTask(
    capability: "coding" | "research" | "math" | "writing" | "qa" | "general",
    companyId: string
  ): {
    selectedAgent: AgentDescriptor;
    matchScore: number;
    reason: string;
  } {
    const candidates = Array.from(this.agents.values()).filter(
      (a) => a.companyId === companyId && a.isAvailable && a.activeTasks < a.maxConcurrentTasks
    );

    if (candidates.length === 0) {
      throw new Error(`A2A_ROUTING_NO_AGENTS_AVAILABLE: No available agents found for company '${companyId}'.`);
    }

    // Score candidates based on specialization match + available capacity
    const scored = candidates.map((agent) => {
      let score = 50;
      if (agent.specializations.includes(capability)) score += 40;
      const capacityRatio = 1 - agent.activeTasks / agent.maxConcurrentTasks;
      score += Math.round(capacityRatio * 10);
      return { agent, score };
    });

    scored.sort((a, b) => b.score - a.score || a.agent.averageLatencyMs - b.agent.averageLatencyMs);
    const winner = scored[0]!;

    return {
      selectedAgent: winner.agent,
      matchScore: winner.score,
      reason: `Selected '${winner.agent.name}' (score: ${winner.score}/100, active tasks: ${winner.agent.activeTasks}/${winner.agent.maxConcurrentTasks}).`,
    };
  }
}

export class A2AHealthRegistry {
  private readonly healthRecords = new Map<string, AgentHealthMetrics>();

  recordHeartbeat(
    agentId: string,
    metrics: { cpuLoadPercent?: number; activeTasks?: number; memoryUsageMb?: number; errorRatePercent?: number } = {}
  ): void {
    const cpu = metrics.cpuLoadPercent ?? 15;
    const errorRate = metrics.errorRatePercent ?? 0;

    let status: AgentHealthMetrics["status"] = "healthy";
    if (cpu > 85 || errorRate > 10) {
      status = "degraded";
    }

    this.healthRecords.set(agentId, {
      agentId,
      status,
      cpuLoadPercent: cpu,
      activeTasks: metrics.activeTasks ?? 0,
      memoryUsageMb: metrics.memoryUsageMb ?? 128,
      errorRatePercent: errorRate,
      lastHeartbeatTimestamp: Date.now(),
    });
  }

  /**
   * 2. A2A: Health Report
   * Aggregates cluster health, detects dead agents (> 30s timeout)
   */
  getHealthReport(): ClusterHealthReport {
    const now = Date.now();
    const agents: AgentHealthMetrics[] = [];

    let healthyCount = 0;
    let degradedCount = 0;
    let offlineCount = 0;

    for (const record of this.healthRecords.values()) {
      // If no heartbeat for > 30 seconds, mark as offline
      if (now - record.lastHeartbeatTimestamp > 30_000) {
        record.status = "offline";
      }

      if (record.status === "healthy") healthyCount++;
      else if (record.status === "degraded") degradedCount++;
      else offlineCount++;

      agents.push({ ...record });
    }

    let clusterStatus: ClusterHealthReport["clusterStatus"] = "healthy";
    if (offlineCount > 0 && healthyCount === 0) {
      clusterStatus = "critical";
    } else if (degradedCount > 0 || offlineCount > 0) {
      clusterStatus = "degraded";
    }

    return {
      totalAgents: agents.length,
      healthyCount,
      degradedCount,
      offlineCount,
      clusterStatus,
      agents,
      generatedAt: new Date().toISOString(),
    };
  }
}

export class OmniConductor {
  constructor(
    private readonly router: A2ASmartRouter,
    private readonly healthRegistry: A2AHealthRegistry
  ) {}

  /**
   * 3. OmniConductor DAG Task Orchestration
   * Dispatches multi-agent dependent tasks in parallel DAG sequence
   */
  async executeWorkflow(
    workflowId: string,
    title: string,
    companyId: string,
    tasks: DagTaskNode[],
    taskExecutor?: (node: DagTaskNode, sender: A2AAgentEndpoint) => Promise<string>
  ): Promise<WorkflowExecutionResult> {
    const startAll = Date.now();
    const completedTasks = new Map<string, string>();
    const senderEndpoint: A2AAgentEndpoint = {
      agentId: "omniconductor-core",
      companyId,
      tenantId: "conductor-tenant",
      role: "orchestrator",
    };

    const runTask =
      taskExecutor ??
      (async (node) => {
        return `Result of task '${node.title}' executed successfully.`;
      });

    const pendingNodes = [...tasks];

    while (pendingNodes.some((n) => n.status === "pending")) {
      // Find all ready tasks whose dependencies are satisfied
      const readyNodes = pendingNodes.filter(
        (n) => n.status === "pending" && n.dependencies.every((depId) => completedTasks.has(depId))
      );

      if (readyNodes.length === 0) {
        // Deadlock or circular dependency
        throw new Error("OMNICONDUCTOR_DAG_DEADLOCK: Unsatisfiable task dependencies detected.");
      }

      // Execute ready tasks in parallel
      await Promise.all(
        readyNodes.map(async (node) => {
          node.status = "running";
          const routed = this.router.routeTask(node.requiredCapability, companyId);
          node.assignedAgentId = routed.selectedAgent.agentId;

          try {
            const output = await runTask(node, senderEndpoint);
            node.output = output;
            node.status = "completed";
            completedTasks.set(node.id, output);
          } catch (err: any) {
            node.status = "failed";
            node.error = err?.message || String(err);
          }
        })
      );

      // If any task failed, abort
      if (pendingNodes.some((n) => n.status === "failed")) {
        break;
      }
    }

    const allSuccessful = tasks.every((t) => t.status === "completed");
    const summary: Record<string, string> = {};
    for (const t of tasks) {
      if (t.output) summary[t.id] = t.output;
    }

    return {
      workflowId,
      title,
      status: allSuccessful ? "completed" : "failed",
      tasks,
      totalDurationMs: Date.now() - startAll,
      summary,
    };
  }
}
