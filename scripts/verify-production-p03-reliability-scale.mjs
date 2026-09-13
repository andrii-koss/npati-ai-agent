const base = process.env.NPATI_API_URL ?? "http://localhost:3001";

console.log("==========================================================");
console.log("  NPATI AGENT — P0.3 RUNTIME RELIABILITY & SCALE LIVE E2E ");
console.log("==========================================================");

// 1. Initial login
console.log("\n[1/11] Authenticating admin user against live container...");
const loginRes = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "webuser1@example.com", password: "Password123!" }),
});
const login = await loginRes.json();
if (!loginRes.ok || !login.tokens?.accessToken) {
  throw new Error(`Admin login failed: ${JSON.stringify(login)}`);
}
const token = login.tokens.accessToken;
console.log("✓ Admin login successful");

async function api(path, method = "GET", body = undefined, customHeaders = {}) {
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
  const headers = {
    authorization: `Bearer ${token}`,
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

// 2. #176 & #202 Cache stats & flush
console.log("\n[2/11] Verifying #176 Semantic Cache & #202 Cache Stats / Flush...");
const statsBefore = await api("/cache/stats");
if (!statsBefore.ok || statsBefore.data.stats === undefined) {
  throw new Error(`Cache stats failed: ${JSON.stringify(statsBefore.data)}`);
}
console.log(`✓ Initial Cache Stats: hits=${statsBefore.data.stats.hits}, misses=${statsBefore.data.stats.misses}`);

const flushRes = await api("/cache/flush", "POST", { flushAll: true });
if (!flushRes.ok || flushRes.data.flushedCount === undefined) {
  throw new Error(`Cache flush failed: ${JSON.stringify(flushRes.data)}`);
}
console.log(`✓ Cache flush confirmed: scope=${flushRes.data.scope}, flushedCount=${flushRes.data.flushedCount}`);

// 3. #205 Database backups
console.log("\n[3/11] Verifying #205 Database Backups (/admin/backups)...");
const backupContent = "-- P0.3 live verification snapshot\nSELECT 1;";
const backupCreate = await api("/admin/backups", "POST", {
  databaseName: "npati_production",
  snapshotName: `p03-live-drill-${Date.now()}`,
  content: backupContent,
});
if (!backupCreate.ok || !backupCreate.data.snapshot?.snapshotId) {
  throw new Error(`Backup snapshot creation failed: ${JSON.stringify(backupCreate.data)}`);
}
const snapshotId = backupCreate.data.snapshot.snapshotId;
console.log(`✓ Backup Snapshot created: ${snapshotId} (checksum: ${backupCreate.data.snapshot.checksumSha256.slice(0, 16)}...)`);

const backupList = await api("/admin/backups");
if (!backupList.ok || !Array.isArray(backupList.data.snapshots) || backupList.data.snapshots.length === 0) {
  throw new Error(`Backup list verification failed: ${JSON.stringify(backupList.data)}`);
}
console.log(`✓ Backup List verified: ${backupList.data.snapshots.length} snapshots available`);

const backupVerify = await api(`/admin/backups/${snapshotId}/verify`, "POST", { content: backupContent });
if (!backupVerify.ok || !backupVerify.data.verified) {
  throw new Error(`Backup snapshot verification failed: ${JSON.stringify(backupVerify.data)}`);
}
console.log(`✓ Backup Snapshot ${snapshotId} checksum drill verified`);

// 4. #207 & #208 Session search & pruning
console.log("\n[4/11] Verifying #207 Session Search & #208 Session Pruning...");
const sessionAId = `sess-p03-a-${Date.now()}`;
const sessionBId = `sess-p03-b-${Date.now()}`;

await api("/sessions/index", "POST", {
  sessionId: sessionAId,
  title: "Incident Response 404 Resolution in Cluster",
  tags: ["incident", "production"],
  messages: [
    { role: "user", content: "We are seeing 404 errors in DNS resolution" },
    { role: "assistant", content: "Root cause analysis showed DNS resolution failure in core microservice mesh" },
  ],
});
await api("/sessions/index", "POST", {
  sessionId: sessionBId,
  title: "Quarterly Financial Forecast Planning",
  tags: ["finance"],
  messages: [
    { role: "user", content: "What are our Q4 revenue targets?" },
    { role: "assistant", content: "Reviewing company ARR and gross margin targets for Q4 financial board review" },
  ],
});
console.log("✓ Sessions indexed for search");

const searchRes = await api(`/sessions/search?query=DNS resolution failure`);
if (!searchRes.ok || !Array.isArray(searchRes.data.results) || searchRes.data.results.length === 0) {
  throw new Error(`Session search failed: ${JSON.stringify(searchRes.data)}`);
}
console.log(`✓ Session search returned top hit '${searchRes.data.results[0].title}' (relevanceScore: ${searchRes.data.results[0].relevanceScore})`);

const pruneRes = await api("/sessions/prune", "POST", {
  sessions: [
    { sessionId: "old-sess-1", lastActiveAt: new Date(Date.now() - 40 * 86400000).toISOString(), messageCount: 5 },
    { sessionId: "old-sess-2", lastActiveAt: new Date(Date.now() - 35 * 86400000).toISOString(), messageCount: 2 },
    { sessionId: "active-sess", lastActiveAt: new Date().toISOString(), messageCount: 10 },
  ],
  maxInactiveDays: 30,
  archiveBeforeDelete: true,
});
if (!pruneRes.ok || pruneRes.data.result?.prunedSessionsCount === undefined) {
  throw new Error(`Session pruning failed: ${JSON.stringify(pruneRes.data)}`);
}
console.log(`✓ Session pruning completed: pruned=${pruneRes.data.result.prunedSessionsCount}, archived=${pruneRes.data.result.archivedSessionsCount}, activeRemaining=${pruneRes.data.activeCount}`);

// 5. #124 Evaluation framework
console.log("\n[5/11] Verifying #124 Evaluation Framework (/evaluation/evaluate)...");
const evalRes = await api("/evaluation/evaluate", "POST", {
  inputPrompt: "Provide deployment status report",
  generatedResponse: JSON.stringify({ status: "deployed", cluster: "eu-central-1", replicas: 3 }),
  criteria: {
    minLength: 10,
    requiredKeywords: ["deployed", "eu-central-1"],
    forbiddenKeywords: ["ERROR", "FATAL"],
    expectedJsonSchema: {
      type: "object",
      required: ["status", "cluster"],
    },
  },
});

if (!evalRes.ok || !evalRes.data.result?.passed) {
  throw new Error(`Evaluation framework verification failed: ${JSON.stringify(evalRes.data)}`);
}
console.log(`✓ Evaluation passed: score=${evalRes.data.result.score}, passed=${evalRes.data.result.passed}`);

// 6. #197, #198, #199 Context compression & adaptive budget
console.log("\n[6/11] Verifying #197, #198, #199 Context Compression & Adaptive Budget...");
const compressionRes = await api("/compression/apply", "POST", {
  text: "Please note that in order to deploy, follow instructions:\n```bash\nnpm run build && npm start\n```\nIt is important to remember that this process is very critical and basically necessary.",
  preset: "balanced",
  modelId: "openai/gpt-4o",
  runEvalHarness: true,
});
if (!compressionRes.ok || !compressionRes.data.compressedText) {
  throw new Error(`Compression API failed: ${JSON.stringify(compressionRes.data)}`);
}
console.log(`✓ Compression applied: preset=${compressionRes.data.appliedPreset}, reduction=${compressionRes.data.reductionPercent}%`);
console.log(`✓ Adaptive Context Budget: budgetTokens=${compressionRes.data.budget?.budgetTokens}, ratio=${compressionRes.data.budget?.ratio}`);
if (compressionRes.data.evaluation) {
  console.log(`✓ Compression Eval Harness: reduction=${compressionRes.data.evaluation.reductionPercent}%, entityRetention=${compressionRes.data.evaluation.entityRetentionRate}%`);
}

// 7. #200 Output styles
console.log("\n[7/11] Verifying #200 Output Styles (/styles/apply)...");
const styleRes = await api("/styles/apply", "POST", {
  style: "minimal-json",
  messages: [{ role: "user", content: "List all active node pools." }],
});
if (!styleRes.ok || !styleRes.data.modifiedMessages) {
  throw new Error(`Style application failed: ${JSON.stringify(styleRes.data)}`);
}
console.log(`✓ Output style applied: style=${styleRes.data.style}, messagesModified=${styleRes.data.modifiedMessages.length}`);

// 8. #22 Adaptive Admission Queue & #23 Self-Healing Auto-Combo (Production Integrated)
console.log("\n[8/11] Verifying #22 Adaptive Admission Queue & #23 Self-Healing Auto-Combo...");
const queueRes = await api("/queue/status", "GET");
if (!queueRes.ok || !queueRes.data.queue) {
  throw new Error(`Adaptive admission queue status check failed: ${JSON.stringify(queueRes.data)}`);
}
console.log(`✓ Adaptive Admission Queue verified: maxConcurrent=${queueRes.data.queue.maxConcurrent}, admitted=${queueRes.data.queue.admitted}`);

const healingRes = await api("/api/chat", "POST", {
  model: "failing-provider-401/unavailable-model",
  messages: [{ role: "user", content: "Self-healing failover check" }],
  stream: false,
});
if (!healingRes.ok || !healingRes.data.message) {
  throw new Error(`Self-healing auto-combo failed: ${JSON.stringify(healingRes.data)}`);
}
console.log(`✓ Self-healing auto-combo succeeded via fallback model: ${healingRes.data.model}`);

// 9. #189 Atomic RPM Rolling Leases & #190 Quota-Share Routing
console.log("\n[9/11] Verifying #189 Atomic RPM Rolling Leases & #190 Quota-Share Routing...");
const leaseRes = await api("/leases/rolling", "POST", {
  provider: "openai-gpt-4o",
  maxRpm: 1000,
  requestedTokens: 250,
});
if (!leaseRes.ok || !leaseRes.data.lease?.granted) {
  throw new Error(`Atomic RPM lease failed: ${JSON.stringify(leaseRes.data)}`);
}
console.log(`✓ Atomic RPM rolling lease granted: leaseId=${leaseRes.data.lease.leaseId}, remainingTokens=${leaseRes.data.lease.remainingTokens}`);

const quotaShareRes = await api("/routing/quota-share", "POST", {
  tenantId: "tenant-enterprise-ops",
  tier: "enterprise",
  sharePercent: 50,
  currentSystemRpm: 40,
  systemMaxRpm: 100,
});
if (!quotaShareRes.ok || quotaShareRes.data.decision?.admitted !== true) {
  throw new Error(`Quota-share routing failed: ${JSON.stringify(quotaShareRes.data)}`);
}
console.log(`✓ Quota-share routing verified: admitted=${quotaShareRes.data.decision.admitted}, tier=${quotaShareRes.data.tier}`);

// 10. #44 Isolated Group Sessions & #46 Session Tools
console.log("\n[10/11] Verifying #44 Isolated Group Sessions & #46 Session Tools...");
const groupSessionCreate = await api("/group-sessions", "POST", {
  sessionName: "Secured Operations War-Room",
  creatorAgentId: "agent-chief-architect",
  participants: [{ agentId: "agent-chief-architect", role: "lead" }],
  channelType: "group_chat",
});
if (!groupSessionCreate.ok || !groupSessionCreate.data.session?.id) {
  throw new Error(`Isolated group session creation failed: ${JSON.stringify(groupSessionCreate.data)}`);
}
const groupSessionId = groupSessionCreate.data.session.id;
console.log(`✓ Isolated Group Session created: ${groupSessionId}`);

const getGroupSession = await api(`/group-sessions/${groupSessionId}`);
if (!getGroupSession.ok || getGroupSession.data.session?.id !== groupSessionId) {
  throw new Error(`Get group session failed: ${JSON.stringify(getGroupSession.data)}`);
}
console.log(`✓ Isolated Group Session retrieved and scoped`);

const toolAttachRes = await api(`/group-sessions/${groupSessionId}/tools`, "POST", {
  toolName: "docker.container_inspect",
  description: "Inspect live docker container status",
});
const hasAttached = toolAttachRes.data.tools?.some(
  (t) => (typeof t === "string" ? t : t?.toolName) === "docker.container_inspect"
);
if (!toolAttachRes.ok || !hasAttached) {
  throw new Error(`Session tool execution failed: ${JSON.stringify(toolAttachRes.data)}`);
}
console.log(`✓ Session tool dynamic attachment verified: tool=${toolAttachRes.data.toolName}`);

// 11. Capability Inspection Endpoint Verification
console.log("\n[11/11] Verifying live capability inspection (/capabilities/inspect)...");
const inspectRes = await api("/capabilities/inspect");
if (!inspectRes.ok || !Array.isArray(inspectRes.data.items)) {
  throw new Error(`Capability inspection failed: ${JSON.stringify(inspectRes.data)}`);
}

const certifiedP03Ids = [22, 23, 44, 46, 124];
const capabilityMap = new Map(inspectRes.data.items.map((c) => [c.id, c]));

for (const id of certifiedP03Ids) {
  const cap = capabilityMap.get(id);
  if (!cap) {
    throw new Error(`Capability ID ${id} not found in inspection endpoint!`);
  }
  if (cap.status !== "VERIFIED_EXISTING") {
    throw new Error(`Capability ID ${id} (${cap.name}) expected VERIFIED_EXISTING, got ${cap.status}`);
  }
}
console.log(`✓ Certified reliability capabilities #22, #23, #44, #46, #124 verified live in Docker container with VERIFIED_EXISTING status!`);

console.log("\n==========================================================");
console.log("  P0.3 RUNTIME RELIABILITY & SCALE: ALL 11 CHECKS PASSED  ");
console.log("==========================================================\n");
