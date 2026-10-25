// scripts/verify-production-p14-orchestration-a2a.mjs
// E2E Verification of P1.4 Multi-agent, MCP & A2A Control Plane against live Docker runtime

const base = process.env.NPATI_API_URL ?? "http://localhost:3001";
const stamp = Date.now();
let token = "";

console.log("==========================================================");
console.log("  NPATI AGENT — P1.4 MULTI-AGENT & A2A LIVE DOCKER E2E    ");
console.log("==========================================================\n");

function assert(condition, message, extra = "") {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`, extra);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

async function api(path, method = "GET", body = undefined, customHeaders = {}) {
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
  const headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(isMutating ? { "idempotency-key": `idem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...customHeaders,
  };
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, data: json };
}

async function run() {
  // 1. Auth Guard
  console.log("[1/18] Verifying Auth Guards on /orchestration endpoints...");
  const unauthRes = await fetch(`${base}/orchestration/strategies`);
  assert(unauthRes.status === 401, "Unauthenticated access rejected with 401");

  // 2. Admin Login
  console.log("\n[2/18] Authenticating admin user against live container...");
  const loginRes = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "webuser1@example.com", password: "Password123!" }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.tokens?.accessToken) {
    throw new Error(`Admin login failed: ${JSON.stringify(login)}`);
  }
  token = login.tokens.accessToken;
  console.log("✓ Admin login successful, JWT obtained");

  // 3. Routing Strategies Catalog
  console.log("\n[3/18] Verifying Routing Strategies catalog (GET /orchestration/strategies)...");
  const stratRes = await api("/orchestration/strategies");
  assert(stratRes.ok, `Strategies retrieved: ${stratRes.status}`);
  assert(stratRes.data.supportedStrategies?.length === 16, "All 16 routing strategies listed");
  assert(stratRes.data.protocolVersion === "0.3", "Protocol version 0.3 verified");

  // 4. Strategy Resolution (#94-#96, #177-#188)
  console.log("\n[4/18] Verifying Strategy Resolution (POST /orchestration/resolve-strategy)...");
  const costRes = await api("/orchestration/resolve-strategy", "POST", {
    strategy: "cost-optimized",
    options: { promptTokens: 6000 },
  });
  assert(costRes.ok, "Cost-optimized resolved successfully");
  assert(costRes.data.result.strategy === "cost-optimized", "Returned cost-optimized strategy");
  assert(costRes.data.result.selectedModelId === "google/gemini-2.5-flash", "Cheapest model selected");

  const contextRes = await api("/orchestration/resolve-strategy", "POST", {
    strategy: "context-optimized",
    options: { promptTokens: 150_000 },
  });
  assert(contextRes.ok, "Context-optimized resolved successfully");
  assert(contextRes.data.result.selectedModelId === "google/gemini-2.5-flash", "1M context window model selected");

  const cacheRes = await api("/orchestration/resolve-strategy", "POST", {
    strategy: "cache-optimized",
    options: { promptTokens: 10_000, estimatedCachedTokens: 8000 },
  });
  assert(cacheRes.ok, "Cache-optimized resolved successfully");
  assert(cacheRes.data.result.cacheControlEnabled === true, "Cache control enabled");

  // 5. Rejection of invalid strategy
  console.log("\n[5/18] Verifying Rejection of invalid strategy...");
  const invalidStrat = await api("/orchestration/resolve-strategy", "POST", {
    strategy: "invalid-magic-router",
  });
  assert(invalidStrat.status === 400, "Invalid strategy rejected with 400");
  assert(invalidStrat.data.error?.code === "INVALID_ROUTING_STRATEGY", "Error code INVALID_ROUTING_STRATEGY");

  // 6. LKGP Routing (#97)
  console.log("\n[6/18] Verifying LKGP Strategy Manager (#97)...");
  const compId = `comp-${stamp}`;
  await api("/orchestration/lkgp/record", "POST", {
    companyId: compId,
    taskType: "finance",
    modelId: "anthropic/claude-3-7-sonnet",
    provider: "anthropic",
    success: true,
  });
  const lkgpResolve = await api(`/orchestration/lkgp/resolve?companyId=${compId}&taskType=finance`);
  assert(lkgpResolve.ok, "LKGP resolved successfully");
  assert(lkgpResolve.data.result.isCachedLkgp === true, "LKGP fast-path resolved cached model");
  assert(lkgpResolve.data.result.selectedModelId === "anthropic/claude-3-7-sonnet", "Claude 3.7 Sonnet resolved");

  // 7. A2A Protocol v0.3 Envelopes (#103)
  console.log("\n[7/18] Verifying A2A Protocol v0.3 Envelopes (#103)...");
  const envCreate = await api("/a2a/envelope/create", "POST", {
    type: "task_delegate",
    sender: { agentId: "lead", companyId: compId, tenantId: "t-1" },
    recipient: { agentId: "worker", companyId: compId, tenantId: "t-1" },
    payload: { task: "evaluate_risk" },
  });
  assert(envCreate.ok, "A2A envelope created successfully");
  assert(envCreate.data.envelope.version === "0.3", "Envelope version is 0.3");

  const envVal = await api("/a2a/envelope/validate", "POST", { envelope: envCreate.data.envelope });
  assert(envVal.ok && envVal.data.valid === true, "A2A envelope validated successfully");

  const badVal = await api("/a2a/envelope/validate", "POST", { envelope: { version: "0.1" } });
  assert(badVal.status === 400, "Malformed envelope rejected with 400");

  const envResp = await api("/a2a/envelope/response", "POST", {
    incomingEnvelope: envCreate.data.envelope,
    resultPayload: { riskScore: 0.12 },
  });
  assert(envResp.ok, "A2A response envelope created");
  assert(envResp.data.responseEnvelope.type === "task_result", "Response type is task_result");
  assert(envResp.data.responseEnvelope.correlationId === envCreate.data.envelope.correlationId, "Correlation ID matches");

  // 8. A2A Smart Routing (#104)
  console.log("\n[8/18] Verifying A2A Smart Routing (#104)...");
  await api("/a2a/router/register", "POST", {
    agentId: `agent-qa-${stamp}`,
    name: "QA Specialist",
    companyId: compId,
    tenantId: "t-1",
    specializations: ["qa", "coding"],
    maxConcurrentTasks: 5,
    activeTasks: 0,
    averageLatencyMs: 150,
    isAvailable: true,
  });
  const routeRes = await api("/a2a/router/route", "POST", {
    capability: "qa",
    companyId: compId,
  });
  assert(routeRes.ok, "A2A task routed successfully");
  assert(routeRes.data.routed.selectedAgent.agentId === `agent-qa-${stamp}`, "Routed to QA Specialist");

  // 9. A2A Health Registry (#105)
  console.log("\n[9/18] Verifying A2A Health Registry (#105)...");
  await api("/a2a/health/heartbeat", "POST", {
    agentId: `agent-qa-${stamp}`,
    metrics: { cpuLoadPercent: 25, activeTasks: 1 },
  });
  const healthRes = await api("/a2a/health/report");
  assert(healthRes.ok, "Health report retrieved");
  assert(healthRes.data.report.totalAgents >= 1, "Active agents tracked");
  assert(healthRes.data.report.clusterStatus === "healthy" || healthRes.data.report.clusterStatus === "degraded", "Cluster status present");

  // 10. OmniConductor DAG Orchestration (#106)
  console.log("\n[10/18] Verifying OmniConductor DAG Orchestration (#106)...");
  const condRes = await api("/a2a/conductor/execute", "POST", {
    workflowId: `wf-${stamp}`,
    title: "Live QA Flow",
    companyId: compId,
    tasks: [
      { id: "t-1", title: "Unit Test", requiredCapability: "qa", dependencies: [], status: "pending" },
      { id: "t-2", title: "Integration Test", requiredCapability: "qa", dependencies: ["t-1"], status: "pending" },
    ],
  });
  assert(condRes.ok, "OmniConductor executed workflow successfully");
  assert(condRes.data.result.status === "completed", "Workflow completed");
  assert(condRes.data.result.tasks.length === 2, "2 tasks completed in DAG sequence");

  // 11. A2A Quota Management (#120)
  console.log("\n[10/18] Verifying A2A Quota Management (#120)...");
  const sessQuota = `sess-quota-${stamp}`;
  await api("/a2a/quota/budget", "POST", {
    sessionId: sessQuota,
    maxTokens: 5000,
    maxCostUsd: 0.1,
    maxDepth: 3,
  });
  const qChk1 = await api("/a2a/quota/check", "POST", {
    sessionId: sessQuota,
    requestedTokens: 1000,
    estimatedCostUsd: 0.01,
    currentDepth: 1,
  });
  assert(qChk1.ok && qChk1.data.allowed === true, "Quota allowance granted within limits");

  const qChkExceed = await api("/a2a/quota/check", "POST", {
    sessionId: sessQuota,
    requestedTokens: 10_000,
    estimatedCostUsd: 0.5,
    currentDepth: 1,
  });
  assert(qChkExceed.ok && qChkExceed.data.allowed === true, "Legacy token/cost allowance cannot block execution");
  assert(!qChkExceed.data.error, "No platform quota error");

  // 12. A2A Provider Discovery (#121)
  console.log("\n[12/18] Verifying A2A Provider Discovery (#121)...");
  await api("/a2a/discovery/register", "POST", {
    agentId: `agent-disc-${stamp}`,
    name: "Discovery Worker",
    capabilities: ["audio_processing", "translation"],
    preferredModel: "openai/gpt-4o",
    healthScore: 0.98,
    avgLatencyMs: 140,
    isAvailable: true,
  });
  const discRes = await api("/a2a/discovery?capability=translation&minHealth=0.8");
  assert(discRes.ok, "Provider discovery query succeeded");
  assert(discRes.data.agents.some((a) => a.agentId === `agent-disc-${stamp}`), "Discovered registered agent");

  // 13. A2A Cost Analysis (#122)
  console.log("\n[13/18] Verifying A2A Cost Analysis (#122)...");
  const traceId = `tr-live-${stamp}`;
  await api("/a2a/costs/record", "POST", {
    traceId,
    agentId: "agent-root",
    model: "openai/gpt-4o",
    inputTokens: 1200,
    outputTokens: 400,
    costUsd: 0.006,
    durationMs: 320,
  });
  const costAnalysis = await api(`/a2a/costs/analyze/${traceId}`);
  assert(costAnalysis.ok, "Cost analysis calculated successfully");
  assert(costAnalysis.data.summary.totalTokens === 1600, "Tokens aggregated");
  assert(costAnalysis.data.summary.totalCostUsd > 0, "Cost USD aggregated");

  // 14. A2A Capabilities Catalog (#123)
  console.log("\n[14/18] Verifying A2A List Capabilities (#123)...");
  const caps = await api("/a2a/capabilities");
  assert(caps.ok, "Capabilities catalog fetched");
  assert(caps.data.capabilities.length >= 12, "All A2A capabilities listed");

  // 15. Agent Send / Session Messaging (#113)
  console.log("\n[15/18] Verifying Agent Send / Session Messaging (#113)...");
  const sessMsg = `sess-msg-${stamp}`;
  const sendRes = await api("/orchestration/messages/send", "POST", {
    sessionId: sessMsg,
    fromAgentId: "agent-sender",
    toAgentId: "agent-receiver",
    content: "Live cluster message test",
  });
  assert(sendRes.ok, "Agent message sent successfully");
  const msgId = sendRes.data.message.id;

  const inboxRes = await api(`/orchestration/messages/inbox/agent-receiver?sessionId=${sessMsg}`);
  assert(inboxRes.ok && inboxRes.data.messages.length === 1, "Message delivered to receiver inbox");

  const ackRes = await api("/orchestration/messages/mark-delivered", "POST", {
    messageId: msgId,
    agentId: "agent-receiver",
  });
  assert(ackRes.ok && ackRes.data.delivered === true, "Message marked delivered");

  // 16. Context Lifecycle: Isolated vs Forked (#112)
  console.log("\n[16/18] Verifying Isolated vs Forked Context (#112)...");
  const isoRes = await api("/orchestration/context/isolated", "POST", {
    agentId: "agent-iso",
    sessionId: `sess-ctx-${stamp}`,
    systemPrompt: "Isolated prompt",
    inputParameters: { p1: "v1" },
  });
  assert(isoRes.ok, "Isolated context created");
  const isoId = isoRes.data.context.id;

  const forkRes = await api("/orchestration/context/fork", "POST", {
    parentContextId: isoId,
    agentId: "agent-child",
  });
  assert(forkRes.ok, "Forked context created");
  const forkId = forkRes.data.context.id;

  await api("/orchestration/context/mutate", "POST", {
    contextId: forkId,
    message: { role: "assistant", content: "Child thought" },
    variables: { p1: "v1-mutated", childVar: 100 },
  });

  const parentCheck = await api(`/orchestration/context/${isoId}`);
  assert(parentCheck.data.context.variables.p1 === "v1", "Parent context remained immutable (copy-on-write)");

  const mergeRes = await api("/orchestration/context/merge", "POST", {
    sourceContextId: forkId,
    targetContextId: isoId,
    strategy: "full",
  });
  assert(mergeRes.ok, "Merged child context back to parent");
  assert(mergeRes.data.merged.variables.childVar === 100, "Child variables integrated after explicit merge");

  // 17. Nested Sub-agents (#125)
  console.log("\n[17/18] Verifying Nested Sub-agents (#125)...");
  const rootSpawn = await api("/orchestration/subagents/spawn", "POST", {
    agentId: `root-${stamp}`,
    name: "Root Lead",
  });
  assert(rootSpawn.ok, "Root agent spawned");

  const childSpawn = await api("/orchestration/subagents/spawn", "POST", {
    agentId: `child-${stamp}`,
    name: "Child Worker",
    parentAgentId: `root-${stamp}`,
  });
  assert(childSpawn.ok, "Child sub-agent spawned with parent delegation");

  // Cancellation propagation
  const cancelRes = await api(`/orchestration/subagents/root-${stamp}/cancel`, "POST", {
    reason: "E2E teardown",
  });
  assert(cancelRes.ok, "Root cancelled");
  assert(cancelRes.data.cancelledAgentIds.includes(`child-${stamp}`), "Cancellation propagated to child sub-agent");

  // 18. Swarm Multi-Agent Routines (#127)
  console.log("\n[18/18] Verifying Swarm Multi-Agent Routines (#127)...");
  await api("/orchestration/swarm/register", "POST", {
    name: "SupportAgent",
    instructions: "General support. Route billing issues to BillingAgent.",
    handoffs: ["BillingAgent"],
  });
  await api("/orchestration/swarm/register", "POST", {
    name: "BillingAgent",
    instructions: "Billing resolutions.",
    handoffs: ["SupportAgent"],
  });

  const swarmRes = await api("/orchestration/swarm/turn", "POST", {
    startingAgent: "SupportAgent",
    userMessage: "Can you help me with billing charges?",
  });
  assert(swarmRes.ok, "Swarm turn executed");
  assert(swarmRes.data.result.handoffOccurred === true, "Dynamic intent handoff occurred");
  assert(swarmRes.data.result.activeAgent === "BillingAgent", "Active agent transferred to BillingAgent");

  console.log("\n==========================================================");
  console.log("  ALL 18 LIVE DOCKER E2E CHECKS PASSED SUCCESSFULLY!     ");
  console.log("==========================================================");
}

run().catch((err) => {
  console.error("FATAL ERROR IN LIVE VERIFICATION:", err);
  process.exit(1);
});
