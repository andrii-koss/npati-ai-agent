import { execFileSync } from "node:child_process";

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
console.log("\n[3/7] Verifying #65 Rerank & #302 OmniRoute Rerank API (/ai/rerank)...");
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

if (!rerankRes.ok) {
  throw new Error(`Rerank API failed: ${JSON.stringify(rerankRes.data)}`);
}
if (!Array.isArray(rerankRes.data.results) || rerankRes.data.results.length === 0) {
  throw new Error(`Expected rerank results array, got: ${JSON.stringify(rerankRes.data)}`);
}

// The top ranked result must be document index 1 (refund policy)
const topResult = rerankRes.data.results[0];
if (topResult.index !== 1) {
  throw new Error(`Expected document index 1 to rank first, got: ${JSON.stringify(topResult)}`);
}
if (topResult.relevanceScore < 0.25) {
  throw new Error(`Expected relevanceScore >= 0.25, got: ${topResult.relevanceScore}`);
}
console.log(`✓ #65 & #302 Rerank API active: top rank=${topResult.rank}, score=${topResult.relevanceScore}, model=${rerankRes.data.model}`);

// 4. #72 Context Compaction API
console.log("\n[4/7] Verifying #72 Context Compaction API (/chat/compact)...");
const messagesToCompact = [
  { role: "user", content: "Привіт! Наш бюджет є $60,000 на рік." },
  { role: "assistant", content: "Чудово, зафіксовано." },
  { role: "user", content: "Ми використовуємо TypeScript та PostgreSQL." },
  { role: "assistant", content: "Зрозумів." },
  { role: "user", content: "Контактна особа є Дмитро (dmytro@example.com)." },
  { role: "assistant", content: "Добре." },
  { role: "user", content: "Turn 7 discussion on feature scope." },
  { role: "assistant", content: "Turn 8 reply." },
  { role: "user", content: "Turn 9 details." },
  { role: "assistant", content: "Turn 10 reply." },
  { role: "user", content: "Turn 11 details." },
  { role: "assistant", content: "Turn 12 reply." },
  { role: "user", content: "Turn 13 details." },
  { role: "assistant", content: "Turn 14 reply." },
  { role: "user", content: "Recent question: Can you summarize everything?" },
];

const compactRes = await api("/chat/compact", "POST", {
  messages: messagesToCompact,
  keepRecentTurns: 4,
});

if (!compactRes.ok || !compactRes.data.compacted) {
  throw new Error(`Context compaction failed: ${JSON.stringify(compactRes.data)}`);
}
if (!compactRes.data.summary?.includes("[Previous Context Summary")) {
  throw new Error(`Compaction missing structured summary header: ${compactRes.data.summary}`);
}
if (compactRes.data.preservedCount !== 4) {
  throw new Error(`Expected 4 preserved turns, got ${compactRes.data.preservedCount}`);
}
if (!compactRes.data.flushedMemories.some((f) => f.includes("$60,000"))) {
  throw new Error(`Flushed memories did not contain extracted budget fact: ${JSON.stringify(compactRes.data.flushedMemories)}`);
}
console.log(`✓ #72 Context Compactor compacted ${compactRes.data.originalCount} turns into 4 recent turns + summary, flushed ${compactRes.data.flushedMemories.length} facts`);

// 5. #78 Automatic Memory Extraction API
console.log("\n[5/7] Verifying #78 Automatic Memory Extraction (/companies/:companyId/knowledge/memory/extract)...");
// Get or create test company
const overviewRes = await api("/overview");
const companies = overviewRes.data.companies ?? [];
let companyId = companies[0]?.id;
if (!companyId) {
  const createComp = await api("/companies", "POST", { name: "P02 Memory Test Corp" });
  companyId = createComp.data.id;
}

// Test no-memory suppression
const extractNoMemRes = await api(`/companies/${companyId}/knowledge/memory/extract`, "POST", {
  text: "Our budget is 1,000,000 USD and confidential.",
  noMemory: true,
  persist: true,
});
if (!extractNoMemRes.ok || extractNoMemRes.data.count !== 0) {
  throw new Error(`Expected no memories extracted when noMemory=true, got: ${JSON.stringify(extractNoMemRes.data)}`);
}

// Test actual extraction & persistence
const extractRes = await api(`/companies/${companyId}/knowledge/memory/extract`, "POST", {
  text: "Наш бюджет є $90,000 на маркетингову кампанію. Ми використовуємо PostgreSQL базу даних. Контактна особа є Марія Шевченко (maria@company.ua).",
  noMemory: false,
  persist: true,
});

if (!extractRes.ok || extractRes.data.count === 0) {
  throw new Error(`Extraction failed: ${JSON.stringify(extractRes.data)}`);
}
console.log(`✓ #78 Automatic Memory Extractor extracted and persisted ${extractRes.data.count} structured company memories (verified noMemory suppression)`);

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
  { id: 64, name: "storage.embeddings" },
  { id: 65, name: "ai.rerank" },
  { id: 72, name: "system.context_compaction" },
  { id: 78, name: "storage.automatic_memory_extraction" },
  { id: 80, name: "storage.memory_rerank" },
  { id: 302, name: "storage.omniroute_rerank_integration" },
];

const items = inspectRes.data.items ?? inspectRes.data.capabilities ?? [];
const itemMap = new Map(items.map((i) => [i.id, i]));

for (const cap of p02Capabilities) {
  const found = itemMap.get(cap.id);
  if (!found) {
    throw new Error(`Capability #${cap.id} (${cap.name}) not found in live /capabilities/inspect`);
  }
  if (found.status !== "VERIFIED_EXISTING") {
    throw new Error(`Capability #${cap.id} (${cap.name}) expected VERIFIED_EXISTING, got: ${found.status}`);
  }
  console.log(`  • #${cap.id} ${cap.name}: VERIFIED_EXISTING [✓]`);
}

console.log("\n==========================================================");
console.log("  ALL P0.2 CAPABILITIES VERIFIED SUCCESSFULLY ON DOCKER   ");
console.log("==========================================================");
