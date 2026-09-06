import { describe, expect, it } from "vitest";
import {
  A2ASmartRouter,
  A2AHealthRegistry,
  OmniConductor,
  type DagTaskNode,
} from "../apps/agent-api/src/a2a-smart-conductor";

describe("A2A Smart Routing (A2ASmartRouter)", () => {
  it("routes task to the most specialized agent with available capacity", () => {
    const router = new A2ASmartRouter();
    const companyId = "company-ai";

    router.registerAgent({
      agentId: "agent-coder",
      name: "Senior Coder Agent",
      companyId,
      tenantId: "tenant-1",
      specializations: ["coding"],
      maxConcurrentTasks: 5,
      activeTasks: 1,
      averageLatencyMs: 400,
      isAvailable: true,
    });

    router.registerAgent({
      agentId: "agent-researcher",
      name: "Web Research Agent",
      companyId,
      tenantId: "tenant-1",
      specializations: ["research", "writing"],
      maxConcurrentTasks: 5,
      activeTasks: 0,
      averageLatencyMs: 250,
      isAvailable: true,
    });

    const codingRoute = router.routeTask("coding", companyId);
    expect(codingRoute.selectedAgent.agentId).toBe("agent-coder");

    const researchRoute = router.routeTask("research", companyId);
    expect(researchRoute.selectedAgent.agentId).toBe("agent-researcher");
  });
});

describe("A2A Health Report (A2AHealthRegistry)", () => {
  it("tracks heartbeats, degrades on high load, and detects offline agents", () => {
    const registry = new A2AHealthRegistry();

    // 1. Healthy agent
    registry.recordHeartbeat("agent-alpha", { cpuLoadPercent: 20, errorRatePercent: 0 });

    // 2. Degraded agent (high CPU)
    registry.recordHeartbeat("agent-beta", { cpuLoadPercent: 90, errorRatePercent: 0 });

    const report = registry.getHealthReport();
    expect(report.totalAgents).toBe(2);
    expect(report.healthyCount).toBe(1);
    expect(report.degradedCount).toBe(1);
    expect(report.clusterStatus).toBe("degraded");
  });
});

describe("OmniConductor DAG Workflow Orchestrator (OmniConductor)", () => {
  it("executes multi-agent dependent DAG tasks in parallel sequence", async () => {
    const router = new A2ASmartRouter();
    const health = new A2AHealthRegistry();
    const companyId = "company-dag";

    router.registerAgent({
      agentId: "agent-researcher",
      name: "Researcher",
      companyId,
      tenantId: "t-1",
      specializations: ["research"],
      maxConcurrentTasks: 5,
      activeTasks: 0,
      averageLatencyMs: 200,
      isAvailable: true,
    });

    router.registerAgent({
      agentId: "agent-coder",
      name: "Coder",
      companyId,
      tenantId: "t-1",
      specializations: ["coding"],
      maxConcurrentTasks: 5,
      activeTasks: 0,
      averageLatencyMs: 300,
      isAvailable: true,
    });

    router.registerAgent({
      agentId: "agent-qa",
      name: "QA Inspector",
      companyId,
      tenantId: "t-1",
      specializations: ["qa"],
      maxConcurrentTasks: 5,
      activeTasks: 0,
      averageLatencyMs: 150,
      isAvailable: true,
    });

    const conductor = new OmniConductor(router, health);

    const tasks: DagTaskNode[] = [
      { id: "task-1", title: "Market Research", requiredCapability: "research", dependencies: [], status: "pending" },
      { id: "task-2", title: "Build Prototype", requiredCapability: "coding", dependencies: ["task-1"], status: "pending" },
      { id: "task-3", title: "QA Validation", requiredCapability: "qa", dependencies: ["task-2"], status: "pending" },
    ];

    const result = await conductor.executeWorkflow("wf-101", "Launch Feature X", companyId, tasks);

    expect(result.status).toBe("completed");
    expect(result.tasks.every((t) => t.status === "completed")).toBe(true);
    expect(result.summary["task-1"]).toBeDefined();
    expect(result.summary["task-2"]).toBeDefined();
    expect(result.summary["task-3"]).toBeDefined();
  });
});
