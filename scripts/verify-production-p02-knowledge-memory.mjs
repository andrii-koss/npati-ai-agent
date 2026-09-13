import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const base = process.env.NPATI_API_URL ?? "http://localhost:3001";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("==========================================================");
console.log("  NPATI AGENT — P0.2 PRODUCTION KNOWLEDGE & MEMORY SUITE  ");
console.log("==========================================================");

// 1. Initial login
console.log("\n[1/7] Authenticating admin user against live container...");
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

// 2. #64 Embeddings API
console.log("\n[2/7] Verifying #64 Embeddings API (/ai/embeddings)...");
const embedRes = await api("/ai/embeddings", "POST", {
  input: [
    "Enterprise AI orchestration with multi-tenant company knowledge",
    "PostgreSQL pgvector cosine distance similarity search",
  ],
  dimensions: 1536,
});

if (!embedRes.ok) {
  throw new Error(`Embeddings API failed: ${JSON.stringify(embedRes.data)}`);
}
if (embedRes.data.object !== "list" || embedRes.data.data.length !== 2) {
  throw new Error(`Invalid embeddings response structure: ${JSON.stringify(embedRes.data)}`);
}

for (const item of embedRes.data.data) {
  if (item.embedding.length !== 1536) {
    throw new Error(`Expected 1536 dimensions, got ${item.embedding.length}`);
  }
  const normSq = item.embedding.reduce((sum, v) => sum + v * v, 0);
  if (normSq < 0.98 || normSq > 1.02) {
    throw new Error(`Embedding vector is not L2-normalized: normSq=${normSq}`);
  }
}
console.log("✓ #64 Embeddings generated, validated L2-normalization (unit sphere), dimensions=1536");

// 3. #65 Rerank & #302 OmniRoute Rerank API
console.log("\n[3/7] Verifying honest #65 Rerank behavior (/ai/rerank)...");
const rerankRes = await api("/ai/rerank", "POST", {
  query: "What is your refund and warranty policy?",
  documents: [
    "Our microservices run in Docker and Kubernetes clusters.",
    "Customers receive a full refund within 30 calendar days under warranty.",
    "The weekly company engineering all-hands happens on Thursday afternoon.",
  ],
  topN: 2,
  minScore: 0.1,
});
let liveRerankAvailable = false;
if (rerankRes.ok) {
  if (!Array.isArray(rerankRes.data.results) || rerankRes.data.results[0]?.index !== 1) {
    throw new Error(`Real rerank returned invalid ordering: ${JSON.stringify(rerankRes.data)}`);
  }
  if (String(rerankRes.data.model).includes("local-cross-encoder")) {
    throw new Error("Production rerank must not masquerade a lexical heuristic as a cross-encoder model");
  }
  liveRerankAvailable = true;
  console.log(`✓ #65 real provider available: model=${rerankRes.data.model}`);
} else {
  const code = rerankRes.data?.error?.code;
  if (![400, 404, 503].includes(rerankRes.status) || !code) {
    throw new Error(`Rerank failed without an explicit provider error: ${JSON.stringify(rerankRes)}`);
  }
  console.log(`✓ #65 remains Partial honestly: live provider unavailable (${rerankRes.status} ${code}); no synthetic fallback returned`);
}
// 4. #72 Context Compaction
console.log("\n[4/7] Verifying #72 diagnostic preview and production chat integration...");
const messagesToCompact = Array.from({ length: 15 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: index === 0 ? "Our budget is 60,000 USD per year." : `Historical turn ${index + 1} with relevant project context.`,
}));
const compactRes = await api("/chat/compact", "POST", { messages: messagesToCompact, keepRecentTurns: 4 });
if (!compactRes.ok || !compactRes.data.compacted || compactRes.data.preservedCount !== 4) {
  throw new Error(`Context compaction diagnostic failed: ${JSON.stringify(compactRes.data)}`);
}

const conversationRes = await api("/conversations", "POST", { title: "P02 context compaction E2E" });
if (!conversationRes.ok || !conversationRes.data?.id) throw new Error(`Could not create neutral conversation: ${JSON.stringify(conversationRes.data)}`);
const conversationId = conversationRes.data.id;
const messageRows = Array.from({ length: 14 }, (_, index) => {
  const role = index % 2 === 0 ? "user" : "assistant";
  const content = `Production history turn ${index + 1}: retain decision CTX-${Date.now()} and all constraints.`.replaceAll("'", "''");
  return `('${randomUUID()}','${conversationId}','${role}','${content}')`;
}).join(",");
execFileSync("docker", ["exec", "npati-agent-postgres", "psql", "-U", "npati", "-d", "npati_agent", "-v", "ON_ERROR_STOP=1", "-c", `INSERT INTO messages(id,conversation_id,role,content) VALUES ${messageRows};`], { stdio: "pipe" });
const productionCompact = await api("/chat", "POST", {
  contextType: "none",
  conversationId,
  message: "Acknowledge the retained context in one short sentence.",
});
await api(`/conversations/${conversationId}`, "DELETE");
if (!productionCompact.ok || productionCompact.data?.contextCompaction?.applied !== true) {
  throw new Error(`Production chat did not apply context compaction: ${JSON.stringify(productionCompact.data)}`);
}
if (productionCompact.data.contextCompaction.preservedCount !== 6) {
  throw new Error(`Expected six recent turns after production compaction: ${JSON.stringify(productionCompact.data.contextCompaction)}`);
}
console.log("✓ #72 model-backed compaction ran inside production /chat and preserved six recent turns");
// 5. #78 Automatic Memory Extraction
console.log("\n[5/7] Verifying #78 automatic extraction in production company chat...");
const overviewRes = await api("/overview");
const companies = overviewRes.data.companies ?? [];
let companyId = companies[0]?.id;
if (!companyId) {
  const createComp = await api("/companies", "POST", { name: "P02 Memory Test Corp" });
  if (!createComp.ok || !createComp.data?.id) throw new Error(`Could not create test company: ${JSON.stringify(createComp.data)}`);
  companyId = createComp.data.id;
}
const uniqueCode = `AUTO-MEM-${Date.now()}`;
const automaticChat = await api("/chat", "POST", {
  contextType: "company",
  companyId,
  message: `Remember that our escalation code is ${uniqueCode}.`,
});
if (!automaticChat.ok) throw new Error(`Company chat failed: ${JSON.stringify(automaticChat.data)}`);
if (automaticChat.data?.automaticMemory?.status !== "completed" || automaticChat.data.automaticMemory.persistedCount < 1) {
  throw new Error(`Company chat did not await automatic memory persistence: ${JSON.stringify(automaticChat.data?.automaticMemory)}`);
}
const memoryList = await api(`/companies/${companyId}/knowledge/memory`);
if (!memoryList.ok || !memoryList.data.memories?.some((memory) => memory.content.includes(uniqueCode) && memory.source.startsWith("auto_extracted:"))) {
  throw new Error(`Automatically extracted fact was not durably stored: ${JSON.stringify(memoryList.data)}`);
}
const privateCode = `PRIVATE-MEM-${Date.now()}`;
const privateChat = await api("/chat", "POST", {
  contextType: "company",
  companyId,
  noMemory: true,
  message: `Remember that our escalation code is ${privateCode}.`,
}, { "x-no-memory": "true" });
if (!privateChat.ok || privateChat.data?.automaticMemory?.status !== "skipped") {
  throw new Error(`noMemory company chat did not explicitly skip extraction: ${JSON.stringify(privateChat.data)}`);
}
const memoryAfterPrivate = await api(`/companies/${companyId}/knowledge/memory`);
if (memoryAfterPrivate.data.memories?.some((memory) => memory.content.includes(privateCode))) {
  throw new Error("noMemory fact was persisted unexpectedly");
}
const streamCode = `STREAM-MEM-${Date.now()}`;
const streamResponse = await fetch(`${base}/chat/stream`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `idem-stream-${Date.now()}` },
  body: JSON.stringify({ contextType: "company", companyId, streamId: `p02-${Date.now()}`, message: `Remember that our escalation code is ${streamCode}.` }),
});
const streamBody = await streamResponse.text();
const resultLine = streamBody.split("\n").find((line, index, lines) => line.startsWith("data:") && lines[index - 1]?.startsWith("event: result"));
const streamResult = resultLine ? JSON.parse(resultLine.slice(5).trim()) : undefined;
if (!streamResponse.ok || streamResult?.automaticMemory?.status !== "completed" || streamResult.automaticMemory.persistedCount < 1) {
  throw new Error(`Streaming company chat did not await automatic memory persistence: ${streamBody.slice(-2000)}`);
}
const memoryAfterStream = await api(`/companies/${companyId}/knowledge/memory`);
if (!memoryAfterStream.data.memories?.some((memory) => memory.content.includes(streamCode))) {
  throw new Error("Streaming chat fact was not durably stored");
}
console.log("✓ #78 JSON and SSE company chats await durable PostgreSQL persistence; noMemory suppression verified");
// 6. #80 Memory Rerank API & Knowledge Retrieval
console.log("\n[6/7] Verifying #80 Memory Rerank & Knowledge Retrieval (/companies/:companyId/knowledge/retrieve & memory/rerank)...");
const memoryRerankRes = await api(`/companies/${companyId}/knowledge/memory/rerank`, "POST", {
  query: "який контакт і бюджет компанії?",
  topK: 5,
});

if (!memoryRerankRes.ok || !memoryRerankRes.data.rankedMemories) {
  throw new Error(`Memory rerank endpoint failed: ${JSON.stringify(memoryRerankRes.data)}`);
}
if (memoryRerankRes.data.rankedMemories.length === 0) {
  throw new Error("Expected ranked memories for query");
}

const topMem = memoryRerankRes.data.rankedMemories[0];
if (!topMem.rerankScore || !topMem.finalScore || !topMem.rank) {
  throw new Error(`Ranked memory missing score fields: ${JSON.stringify(topMem)}`);
}
console.log(`✓ #80 Memory Rerank scored memories with temporal decay + query relevance: top score=${topMem.finalScore}, rank=${topMem.rank}`);

// Test retrieve endpoint returns reranked context
const retrieveRes = await api(`/companies/${companyId}/knowledge/retrieve`, "POST", {
  query: "бюджет і контакти",
  limit: 5,
});
if (!retrieveRes.ok || !Array.isArray(retrieveRes.data.memories)) {
  throw new Error(`Knowledge retrieve failed: ${JSON.stringify(retrieveRes.data)}`);
}
console.log(`✓ /companies/:companyId/knowledge/retrieve returned context with ${retrieveRes.data.memories.length} reranked memories`);

// 7. Developer Capabilities Inspector Verification
console.log("\n[7/7] Verifying Developer Capabilities Inspector on live server...");
const inspectRes = await api("/capabilities/inspect");
if (!inspectRes.ok) {
  throw new Error(`Capabilities inspect failed: ${JSON.stringify(inspectRes.data)}`);
}

const p02Capabilities = [
  { id: 64, name: "storage.embeddings", expected: "VERIFIED_EXISTING" },
  { id: 65, name: "ai.rerank", expected: "PARTIALLY_IMPLEMENTED" },
  { id: 72, name: "system.context_compaction", expected: "PARTIALLY_IMPLEMENTED" },
  { id: 78, name: "storage.automatic_memory_extraction", expected: "NOT_IMPLEMENTED" },
  { id: 80, name: "storage.memory_rerank", expected: "NOT_IMPLEMENTED" },
  { id: 302, name: "storage.omniroute_rerank_integration", expected: "PARTIALLY_IMPLEMENTED" },
];

const items = inspectRes.data.items ?? inspectRes.data.capabilities ?? [];
const itemMap = new Map(items.map((i) => [i.id, i]));

for (const cap of p02Capabilities) {
  const found = itemMap.get(cap.id);
  if (!found) {
    throw new Error(`Capability #${cap.id} (${cap.name}) not found in live /capabilities/inspect`);
  }
  if (found.status !== cap.expected) {
    throw new Error(`Capability #${cap.id} (${cap.name}) expected ${cap.expected}, got: ${found.status}`);
  }
  console.log(`  • #${cap.id} ${cap.name}: ${found.status}`);
}

console.log("\n==========================================================");
console.log("  P0.2 IMPLEMENTATION AND HONEST STATUSES VALIDATED       ");
console.log("==========================================================");
