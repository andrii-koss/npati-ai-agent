import { describe, expect, it } from "vitest";
import {
  RoutingStrategiesManager,
  RoutingStrategyEngine,
} from "../apps/agent-api/src/routing-strategies";
import { LkgpStrategyManager } from "../apps/agent-api/src/lkgp-router";
import { A2AProtocolV03, type A2AAgentEndpoint } from "../apps/agent-api/src/a2a-protocol";
import {
  A2ASmartRouter,
  A2AHealthRegistry,
  OmniConductor,
  type DagTaskNode,
} from "../apps/agent-api/src/a2a-smart-conductor";
import {
  A2AQuotaManager,
  A2AProviderDiscovery,
  A2ACostAnalyzer,
} from "../apps/agent-api/src/a2a-protocol-extensions";
import { MultiAgentMessageBus } from "../apps/agent-api/src/multi-agent-message-bus";
import {
  ContextLifecycleManager,
  NestedSubagentManager,
} from "../apps/agent-api/src/context-and-subagent-lifecycle";
import { SwarmOrchestrator } from "../apps/agent-api/src/swarm-audio-translation-video";
import { buildApp } from "../apps/agent-api/src/app";
import { LocalDevAuthProvider } from "../apps/agent-api/src/auth";

describe("P1.4 — Multi-agent, MCP & A2A Control Plane", () => {
  const router = new RoutingStrategiesManager();

  // -------------------------------------------------------------
  // Capabilities #94, #95, #96: AI Optimization Strategies
  // -------------------------------------------------------------

  it("1. #94 orchestration.cost-optimized: selects cheapest model and calculates savings", () => {
    const res = router.resolveCostOptimized(10_000, 2_000);
    expect(res.strategy).toBe("cost-optimized");
    expect(res.selectedModelId).toBe("google/gemini-2.5-flash");
    expect(res.estimatedCostUsd).toBeGreaterThan(0);
    expect(res.estimatedCostUsd).toBeLessThan(0.01);
    expect(res.estimatedSavingsPercent).toBeGreaterThan(90);
    expect(res.reason).toContain("savings");
  });

  it("2. #95 orchestration.context-optimized: selects window tier based on token size", () => {
    // Massive prompt > 100k -> 1M Gemini
    const huge = router.resolveContextOptimized(120_000);
    expect(huge.strategy).toBe("context-optimized");
    expect(huge.selectedModelId).toBe("google/gemini-2.5-flash");
    expect(huge.reason).toContain("1M context window");

    // Medium prompt > 30k -> 200k Claude 3.7
    const medium = router.resolveContextOptimized(45_000);
    expect(medium.selectedModelId).toBe("anthropic/claude-3-7-sonnet");
    expect(medium.reason).toContain("200k context window");

    // Compact prompt -> fast tier
    const compact = router.resolveContextOptimized(4_000);
    expect(compact.selectedModelId).toBe("google/gemini-2.5-flash");
    expect(compact.reason).toContain("Compact prompt");
  });

  it("3. #96 orchestration.cache-optimized: applies prompt cache discounts and enables cacheControl", () => {
    const res = router.resolveCacheOptimized(20_000, 16_000); // 80% cached
    expect(res.strategy).toBe("cache-optimized");
    expect(res.cacheControlEnabled).toBe(true);
    expect(res.estimatedSavingsPercent).toBeGreaterThan(50);
    expect(res.reason).toContain("Prompt-cache routing active");
  });

  // -------------------------------------------------------------
  // Capabilities #177 to #188: Orchestration Routing Strategies
  // -------------------------------------------------------------

  it("4. #177 orchestration.priority: routes along priority order and fails over when unhealthy", () => {
    // Both healthy -> anthropic
    const res1 = router.resolvePriority(["anthropic", "openai"], ["anthropic", "openai"]);
    expect(res1.strategy).toBe("priority");
    expect(res1.provider).toBe("anthropic");

    // Anthropic offline -> falls over to openai
    const res2 = router.resolvePriority(["anthropic", "openai"], ["openai"]);
    expect(res2.provider).toBe("openai");
  });

  it("5. #178 orchestration.fill-first: saturates primary capacity before overflowing", () => {
    // Below 90% -> anthropic
    const res1 = router.resolveFillFirst([
      { provider: "anthropic", currentRpm: 60, maxRpm: 100 },
      { provider: "openai", currentRpm: 10, maxRpm: 100 },
    ]);
    expect(res1.provider).toBe("anthropic");

    // Saturated (95%) -> overflows to openai
    const res2 = router.resolveFillFirst([
      { provider: "anthropic", currentRpm: 95, maxRpm: 100 },
      { provider: "openai", currentRpm: 10, maxRpm: 100 },
    ]);
    expect(res2.provider).toBe("openai");
  });

  it("6. #179 orchestration.weighted: routes probabilistically by weight ratio", () => {
    const weights = { anthropic: 75, openai: 25 };
    const res1 = router.resolveWeighted(weights, 0.4);
    expect(res1.strategy).toBe("weighted");
    expect(res1.provider).toBe("anthropic");

    const res2 = router.resolveWeighted(weights, 0.85);
    expect(res2.provider).toBe("openai");
  });

  it("7. #180 orchestration.round-robin: evenly cycles through provider list", () => {
    const providers = ["anthropic", "openai", "google"];
    const r1 = router.resolveRoundRobin(providers);
    const r2 = router.resolveRoundRobin(providers);
    const r3 = router.resolveRoundRobin(providers);
    const r4 = router.resolveRoundRobin(providers);

    expect(r1.provider).toBe("anthropic");
    expect(r2.provider).toBe("openai");
    expect(r3.provider).toBe("google");
    expect(r4.provider).toBe("anthropic"); // Rotated
  });

  it("8. #181 orchestration.p2c: picks better candidate using Power of Two Choices", () => {
    const loads = [
      { provider: "anthropic", activeRequests: 20, latencyMs: 350 },
      { provider: "openai", activeRequests: 5, latencyMs: 140 },
      { provider: "google", activeRequests: 30, latencyMs: 500 },
    ];
    const res = router.resolveP2c(loads, 0, 1);
    expect(res.strategy).toBe("p2c");
    expect(res.provider).toBe("openai");
  });

  it("9. #182 orchestration.least-used: routes to provider with minimum active load", () => {
    const loads = [
      { provider: "anthropic", activeRequests: 14 },
      { provider: "openai", activeRequests: 7 },
      { provider: "deepseek", activeRequests: 2 },
    ];
    const res = router.resolveLeastUsed(loads);
    expect(res.strategy).toBe("least-used");
    expect(res.provider).toBe("deepseek");
  });

  it("10. #183 browser.random: uniform random distribution across healthy providers", () => {
    const res = router.resolveRandom(["anthropic", "openai", "google"], 0.2);
    expect(res.strategy).toBe("random");
    expect(res.provider).toBe("anthropic");
  });

  it("11. #184 browser.strict-random: CSPRNG distribution with zero predictable bias", () => {
    const res = router.resolveStrictRandom(["anthropic", "openai", "google"], 2);
    expect(res.strategy).toBe("strict-random");
    expect(res.provider).toBe("google");
  });

  it("12. #185 orchestration.headroom: selects provider with largest burst capacity buffer", () => {
    const headrooms = [
      { provider: "anthropic", remainingHeadroomRpm: 20 },
      { provider: "openai", remainingHeadroomRpm: 120 },
      { provider: "google", remainingHeadroomRpm: 80 },
    ];
    const res = router.resolveHeadroom(headrooms);
    expect(res.strategy).toBe("headroom");
    expect(res.provider).toBe("openai");
  });

  it("13. #186 orchestration.reset-window: selects provider resetting soonest or unconstrained", () => {
    const states = [
      { provider: "anthropic", resetInSeconds: 50, isLimited: true },
      { provider: "openai", resetInSeconds: 5, isLimited: false },
      { provider: "google", resetInSeconds: 25, isLimited: false },
    ];
    const res = router.resolveResetWindow(states);
    expect(res.strategy).toBe("reset-window");
    expect(res.provider).toBe("openai");
  });

  it("14. #187 orchestration.reset-aware: selects provider with highest recovery curve score", () => {
    const recoveryStates = [
      { provider: "anthropic", timeSinceResetSeconds: 10, maxRpm: 100 }, // score = (10/60)*100 = 16.7
      { provider: "openai", timeSinceResetSeconds: 55, maxRpm: 100 },    // score = (55/60)*100 = 91.7
    ];
    const res = router.resolveResetAware(recoveryStates);
    expect(res.strategy).toBe("reset-aware");
    expect(res.provider).toBe("openai");
  });

  it("15. #188 orchestration.context-relay: selects model capable of absorbing accumulated context", () => {
    const res = router.resolveContextRelay(60_000);
    expect(res.strategy).toBe("context-relay");
    expect(res.selectedModelId).toBeDefined();
    expect(res.reason.toLowerCase()).toContain("context-relay");
  });

  // -------------------------------------------------------------
  // Capability #97: LKGP (Last Known Good Provider)
  // -------------------------------------------------------------

  it("16. #97 orchestration.lkgp: remembers successful providers and falls back on consecutive failures", () => {
    const lkgp = new LkgpStrategyManager();
    const companyId = "company-fintech";

    // Initial state -> un-cached fallback
    const init = lkgp.resolveLkgp(companyId, "reports", "google/gemini-2.5-flash");
    expect(init.isCachedLkgp).toBe(false);

    // Record success
    lkgp.recordSuccess(companyId, "reports", "anthropic/claude-3-7-sonnet", "anthropic");
    const cached = lkgp.resolveLkgp(companyId, "reports");
    expect(cached.isCachedLkgp).toBe(true);
    expect(cached.selectedModelId).toBe("anthropic/claude-3-7-sonnet");

    // Record 2 failures -> triggers degraded fallback
    lkgp.recordFailure(companyId, "reports", "anthropic/claude-3-7-sonnet");
    lkgp.recordFailure(companyId, "reports", "anthropic/claude-3-7-sonnet");
    const fallback = lkgp.resolveLkgp(companyId, "reports", "google/gemini-2.5-flash");
    expect(fallback.isCachedLkgp).toBe(false);
    expect(fallback.selectedModelId).toBe("google/gemini-2.5-flash");
  });

  // -------------------------------------------------------------
  // Capability #103: A2A Protocol v0.3
  // -------------------------------------------------------------

  it("17. #103 orchestration.a2a_protocol_v03: creates, validates, and responds with v0.3 envelopes", () => {
    const sender: A2AAgentEndpoint = { agentId: "lead-agent", companyId: "c-1", tenantId: "t-1", role: "coordinator" };
    const recipient: A2AAgentEndpoint = { agentId: "worker-agent", companyId: "c-1", tenantId: "t-1", role: "worker" };

    const envelope = A2AProtocolV03.createEnvelope("task_delegate", sender, recipient, { task: "calculate_mrr" });
    expect(envelope.version).toBe("0.3");
    expect(envelope.correlationId).toBeDefined();

    const val = A2AProtocolV03.validateEnvelope(envelope);
    expect(val.valid).toBe(true);

    // Negative: version mismatch
    const badVersion = { ...envelope, version: "0.2" };
    const badVal = A2AProtocolV03.validateEnvelope(badVersion);
    expect(badVal.valid).toBe(false);

    // Create response envelope
    const resp = A2AProtocolV03.createResponseEnvelope(envelope, { mrr: 15400 });
    expect(resp.type).toBe("task_result");
    expect(resp.sender.agentId).toBe("worker-agent");
    expect(resp.recipient.agentId).toBe("lead-agent");
    expect(resp.correlationId).toBe(envelope.correlationId);
  });

  // -------------------------------------------------------------
  // Capabilities #104, #105, #106: Smart Routing, Health Report & OmniConductor
  // -------------------------------------------------------------

  it("18. #104 orchestration.a2a_smart_routing: scores agent specializations and capacity", () => {
    const router = new A2ASmartRouter();
    router.registerAgent({
      agentId: "agent-research",
      name: "Researcher",
      companyId: "comp-1",
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
      companyId: "comp-1",
      tenantId: "t-1",
      specializations: ["coding"],
      maxConcurrentTasks: 5,
      activeTasks: 1,
      averageLatencyMs: 350,
      isAvailable: true,
    });

    const route = router.routeTask("coding", "comp-1");
    expect(route.selectedAgent.agentId).toBe("agent-coder");
    expect(route.matchScore).toBeGreaterThan(80);
  });

  it("19. #105 orchestration.a2a_health_report: tracks heartbeats and flags degraded/offline agents", () => {
    const health = new A2AHealthRegistry();
    health.recordHeartbeat("agent-healthy", { cpuLoadPercent: 15, errorRatePercent: 0 });
    health.recordHeartbeat("agent-degraded", { cpuLoadPercent: 92, errorRatePercent: 15 });

    const report = health.getHealthReport();
    expect(report.totalAgents).toBe(2);
    expect(report.healthyCount).toBe(1);
    expect(report.degradedCount).toBe(1);
    expect(report.clusterStatus).toBe("degraded");
  });

  it("20. #106 system.omniconductor: orchestrates multi-agent dependent DAG workflows and detects deadlock", async () => {
    const sRouter = new A2ASmartRouter();
    const sHealth = new A2AHealthRegistry();
    sRouter.registerAgent({
      agentId: "agent-worker",
      name: "All-Rounder",
      companyId: "c-dag",
      tenantId: "t-1",
      specializations: ["general", "research", "writing"],
      maxConcurrentTasks: 10,
      activeTasks: 0,
      averageLatencyMs: 100,
      isAvailable: true,
    });

    const conductor = new OmniConductor(sRouter, sHealth);
    const tasks: DagTaskNode[] = [
      { id: "task-1", title: "Fetch market data", requiredCapability: "research", dependencies: [], status: "pending" },
      { id: "task-2", title: "Synthesize report", requiredCapability: "writing", dependencies: ["task-1"], status: "pending" },
    ];

    const result = await conductor.executeWorkflow("wf-1", "Market Analysis", "c-dag", tasks);
    expect(result.status).toBe("completed");
    expect(result.summary["task-1"]).toBeDefined();
    expect(result.summary["task-2"]).toBeDefined();

    // Deadlock negative test (circular dependency)
    const cyclicTasks: DagTaskNode[] = [
      { id: "c-1", title: "A", requiredCapability: "general", dependencies: ["c-2"], status: "pending" },
      { id: "c-2", title: "B", requiredCapability: "general", dependencies: ["c-1"], status: "pending" },
    ];
    await expect(conductor.executeWorkflow("wf-deadlock", "Cyclic", "c-dag", cyclicTasks)).rejects.toThrow("OMNICONDUCTOR_DAG_DEADLOCK");
  });

  // -------------------------------------------------------------
  // Capability #112: Isolated vs Forked Context
  // -------------------------------------------------------------

  it("21. #112 system.isolated_vs_forked_context: supports clean isolated sandboxes & copy-on-write forks", () => {
    const ctxManager = new ContextLifecycleManager();

    // 1. Isolated context: clean slate
    const isolated = ctxManager.createIsolatedContext({
      agentId: "agent-sandbox",
      sessionId: "sess-iso",
      systemPrompt: "Pristine instructions",
      inputParameters: { safeMode: true },
    });
    expect(isolated.mode).toBe("isolated");
    expect(isolated.messages.length).toBe(1);
    expect(isolated.variables.safeMode).toBe(true);

    // 2. Forked context: copy-on-write snapshot
    ctxManager.mutateContext(isolated.id, {
      message: { role: "user", content: "Parent message" },
      variables: { parentVar: "v1" },
    });

    const forked = ctxManager.forkContext({
      parentContextId: isolated.id,
      agentId: "agent-child",
    });
    expect(forked.mode).toBe("forked");
    expect(forked.parentContextId).toBe(isolated.id);
    expect(forked.messages.length).toBe(2);

    // Mutate child -> parent must NOT be affected
    ctxManager.mutateContext(forked.id, {
      message: { role: "assistant", content: "Child reply" },
      variables: { parentVar: "v1-mutated", childVar: "c1" },
    });

    const parentAfterChildMutation = ctxManager.getContext(isolated.id)!;
    expect(parentAfterChildMutation.messages.length).toBe(2);
    expect(parentAfterChildMutation.variables.parentVar).toBe("v1");

    // 3. Explicit merge back
    const merged = ctxManager.mergeContext(forked.id, isolated.id, { strategy: "full" });
    expect(merged.messages.length).toBe(3);
    expect(merged.variables.parentVar).toBe("v1-mutated");
    expect(merged.variables.childVar).toBe("c1");
  });

  // -------------------------------------------------------------
  // Capability #113: Agent Send / Session Messaging
  // -------------------------------------------------------------

  it("22. #113 system.agent_send_session_messaging: direct messaging, inbox delivery ack, and session broadcast", () => {
    const bus = new MultiAgentMessageBus();
    const sessionId = "sess-messaging";

    // Direct message
    const msg = bus.sendMessage({
      sessionId,
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      content: "Hello Agent B",
    });
    expect(msg.isDelivered).toBe(false);

    const inbox = bus.getInbox("agent-b", sessionId);
    expect(inbox.length).toBe(1);
    expect(inbox[0].content).toBe("Hello Agent B");

    // Ack delivery
    const ack = bus.markDelivered(msg.id, "agent-b");
    expect(ack).toBe(true);

    // Session broadcast
    const broadcasts = bus.broadcastToSession(sessionId, "agent-a", "Sync state", ["agent-a", "agent-b", "agent-c"]);
    expect(broadcasts.length).toBe(2); // Delivered to b and c, excluding sender a

    const history = bus.getSessionHistory(sessionId);
    expect(history.length).toBe(3);
  });

  // -------------------------------------------------------------
  // Capabilities #120, #121, #122, #123: Quota, Discovery, Cost & Capabilities
  // -------------------------------------------------------------

  it("23. #120 security.a2a_quota_management: enforces session token, cost, and recursion depth limits", () => {
    const quota = new A2AQuotaManager();
    quota.setSessionBudget("sess-quota", 10_000, 0.5, 3);

    // Normal check -> allowed
    const chk1 = quota.checkAllowance("sess-quota", 2_000, 0.05, 1);
    expect(chk1.allowed).toBe(true);

    // Exceed depth > 3 -> denied
    const chkDepth = quota.checkAllowance("sess-quota", 500, 0.01, 4);
    expect(chkDepth.allowed).toBe(false);
    expect(chkDepth.error).toContain("A2A_MAX_DEPTH_EXCEEDED");

    // Record usage to exhaust budget
    quota.recordUsage("sess-quota", 9_500, 0.48);

    // Token quota exhaustion
    const chkToken = quota.checkAllowance("sess-quota", 1_000, 0.01, 2);
    expect(chkToken.allowed).toBe(false);
    expect(chkToken.error).toContain("A2A_TOKEN_QUOTA_EXCEEDED");

    // Cost quota exhaustion
    const chkCost = quota.checkAllowance("sess-quota", 100, 0.1, 2);
    expect(chkCost.allowed).toBe(false);
    expect(chkCost.error).toContain("A2A_COST_QUOTA_EXCEEDED");
  });

  it("24. #121 orchestration.a2a_provider_discovery: registers agents and queries by capability and health", () => {
    const disc = new A2AProviderDiscovery();
    disc.registerAgent({
      agentId: "agent-doc-qa",
      name: "Doc QA Specialist",
      capabilities: ["document_parsing", "ocr", "search"],
      preferredModel: "openai/gpt-4o",
      healthScore: 0.95,
      avgLatencyMs: 180,
      isAvailable: true,
    });
    disc.registerAgent({
      agentId: "agent-doc-legacy",
      name: "Legacy Doc",
      capabilities: ["document_parsing"],
      preferredModel: "anthropic/claude-3-7-sonnet",
      healthScore: 0.4, // degraded
      avgLatencyMs: 600,
      isAvailable: true,
    });

    const discovered = disc.discoverAgents("document_parsing", { minHealth: 0.8 });
    expect(discovered.length).toBe(1);
    expect(discovered[0].agentId).toBe("agent-doc-qa");
  });

  it("25. #122 orchestration.a2a_cost_analysis: aggregates multi-agent delegation tree costs and breakdowns", () => {
    const analyzer = new A2ACostAnalyzer();
    const traceId = "tr_multi_agent_tree";

    analyzer.recordDelegation({
      traceId,
      agentId: "agent-parent",
      model: "openai/gpt-4o",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.0075,
      durationMs: 400,
      timestamp: new Date().toISOString(),
    });
    analyzer.recordDelegation({
      traceId,
      agentId: "agent-child",
      parentAgentId: "agent-parent",
      model: "google/gemini-2.5-flash",
      inputTokens: 3000,
      outputTokens: 1000,
      costUsd: 0.0005,
      durationMs: 250,
      timestamp: new Date().toISOString(),
    });

    const summary = analyzer.analyzeTraceCosts(traceId);
    expect(summary.totalTokens).toBe(5500);
    expect(summary.totalCostUsd).toBeCloseTo(0.008, 4);
    expect(summary.agentBreakdown["agent-parent"].callsCount).toBe(1);
    expect(summary.agentBreakdown["agent-child"].callsCount).toBe(1);
  });

  // -------------------------------------------------------------
  // Capability #125: Nested Sub-agents
  // -------------------------------------------------------------

  it("26. #125 system.nested_sub-agents: bounds recursion depth, blocks cycles, and propagates cancellation", () => {
    const subManager = new NestedSubagentManager({ maxDepth: 3, maxChildrenPerAgent: 2 });

    // Root agent
    const root = subManager.spawnSubagent({ agentId: "agent-root", name: "Root Manager" });
    expect(root.depth).toBe(1);

    // Child
    const child = subManager.spawnSubagent({
      agentId: "agent-mid",
      name: "Mid Manager",
      parentAgentId: "agent-root",
      parentAllowedTools: ["search", "calculator"],
      requestedTools: ["search"],
    });
    expect(child.depth).toBe(2);

    // Grandchild
    const grandchild = subManager.spawnSubagent({
      agentId: "agent-leaf",
      name: "Leaf Worker",
      parentAgentId: "agent-mid",
      parentAllowedTools: ["search"],
      requestedTools: ["search"],
    });
    expect(grandchild.depth).toBe(3);

    // Negative: Exceed max depth (depth 4 > 3)
    expect(() =>
      subManager.spawnSubagent({
        agentId: "agent-leaf-too-deep",
        name: "Deep Worker",
        parentAgentId: "agent-leaf",
      })
    ).toThrow("NESTED_SUBAGENT_DEPTH_EXCEEDED");

    // Negative: Cycle protection (attempting to spawn agent-root under agent-mid)
    expect(() =>
      subManager.spawnSubagent({
        agentId: "agent-root",
        name: "Cycle Worker",
        parentAgentId: "agent-mid",
      })
    ).toThrow("RECURSIVE_CYCLE_DETECTED");

    // Negative: Privilege escalation (child requests tool parent doesn't have)
    expect(() =>
      subManager.spawnSubagent({
        agentId: "agent-hacker",
        name: "Escalation",
        parentAgentId: "agent-mid",
        parentAllowedTools: ["search"],
        requestedTools: ["execute_shell_code"],
      })
    ).toThrow("PRIVILEGE_ESCALATION_BLOCKED");

    // Cancellation propagation: cancel root -> child and grandchild are cancelled
    const cancelled = subManager.cancelAgent("agent-root", "Task aborted by user");
    expect(cancelled.cancelledAgentIds).toContain("agent-root");
    expect(cancelled.cancelledAgentIds).toContain("agent-mid");
    expect(cancelled.cancelledAgentIds).toContain("agent-leaf");

    expect(subManager.getNode("agent-leaf")?.status).toBe("cancelled");
    expect(subManager.getNode("agent-leaf")?.abortController.signal.aborted).toBe(true);
  });

  // -------------------------------------------------------------
  // Capability #127: Swarm
  // -------------------------------------------------------------

  it("27. #127 system.swarm: coordinates client-side multi-agent routines with dynamic handoff", () => {
    const swarm = new SwarmOrchestrator();
    swarm.registerAgent({
      name: "TriageAgent",
      instructions: "Route refund requests to BillingAgent.",
      handoffs: ["BillingAgent"],
    });
    swarm.registerAgent({
      name: "BillingAgent",
      instructions: "Issue refunds.",
      handoffs: ["TriageAgent"],
    });

    const turn = swarm.executeTurn("TriageAgent", "Please process my billing refund");
    expect(turn.handoffOccurred).toBe(true);
    expect(turn.activeAgent).toBe("BillingAgent");
    expect(turn.messages.some((m) => m.content.includes("[Handoff] Delegating task to BillingAgent"))).toBe(true);
  });

  // -------------------------------------------------------------
  // Fastify HTTP Control Plane Integration Tests
  // -------------------------------------------------------------

  it("28. HTTP API: routes, validates, and exposes control plane endpoints under authentication", async () => {
    const app = buildApp({ authProvider: new LocalDevAuthProvider() });
    await app.ready();

    // 1. Strategies list
    const strategiesRes = await app.inject({
      method: "GET",
      url: "/orchestration/strategies",
      headers: { authorization: "Bearer dev-token" },
    });
    expect(strategiesRes.statusCode).toBe(200);
    const stratBody = JSON.parse(strategiesRes.body);
    expect(stratBody.supportedStrategies.length).toBe(16);
    expect(stratBody.protocolVersion).toBe("0.3");

    // 2. Resolve strategy endpoint
    const resolveRes = await app.inject({
      method: "POST",
      url: "/orchestration/resolve-strategy",
      headers: { authorization: "Bearer dev-token" },
      payload: { strategy: "cost-optimized", options: { promptTokens: 5000 } },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(JSON.parse(resolveRes.body).result.strategy).toBe("cost-optimized");

    // 3. Reject invalid strategy
    const invalidStratRes = await app.inject({
      method: "POST",
      url: "/orchestration/resolve-strategy",
      headers: { authorization: "Bearer dev-token" },
      payload: { strategy: "unsupported-magic-strategy" },
    });
    expect(invalidStratRes.statusCode).toBe(400);
    expect(JSON.parse(invalidStratRes.body).error.code).toBe("INVALID_ROUTING_STRATEGY");

    // 4. A2A Envelope create & validate
    const envCreateRes = await app.inject({
      method: "POST",
      url: "/a2a/envelope/create",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        type: "task_delegate",
        sender: { agentId: "lead", companyId: "c-1", tenantId: "t-1" },
        recipient: { agentId: "sub", companyId: "c-1", tenantId: "t-1" },
        payload: { action: "summarize" },
      },
    });
    expect(envCreateRes.statusCode).toBe(200);
    const createdEnv = JSON.parse(envCreateRes.body).envelope;

    const envValRes = await app.inject({
      method: "POST",
      url: "/a2a/envelope/validate",
      headers: { authorization: "Bearer dev-token" },
      payload: { envelope: createdEnv },
    });
    expect(envValRes.statusCode).toBe(200);
    expect(JSON.parse(envValRes.body).valid).toBe(true);

    // 5. A2A List Capabilities
    const capsRes = await app.inject({
      method: "GET",
      url: "/a2a/capabilities",
      headers: { authorization: "Bearer dev-token" },
    });
    expect(capsRes.statusCode).toBe(200);
    const capsBody = JSON.parse(capsRes.body);
    expect(capsBody.capabilities.length).toBeGreaterThan(10);
    expect(capsBody.routingStrategies.length).toBe(16);

    await app.close();
  });
});
