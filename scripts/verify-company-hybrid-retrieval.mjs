import { chromium } from "playwright";

const base = process.env.NPATI_API_URL ?? "http://localhost:3001";
const webBase = process.env.NPATI_WEB_URL ?? "http://localhost:3000";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loginResponse = await fetch(base + "/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "webuser1@example.com", password: "Password123!" }),
});
const login = await loginResponse.json();
if (!loginResponse.ok) throw new Error(JSON.stringify(login));
const token = login.tokens.accessToken;

async function request(path, method = "GET", body, idempotencyKey) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(method + " " + path + " " + response.status + " " + text);
  return value;
}

const stamp = Date.now();
let companyId;
let isolatedCompanyId;
let browser;
try {
  const company = await request("/companies", "POST", { name: "Hybrid Retrieval " + stamp }, "hybrid-company-" + stamp);
  companyId = company.id;
  const isolated = await request("/companies", "POST", { name: "Hybrid Isolation " + stamp }, "hybrid-isolation-" + stamp);
  isolatedCompanyId = isolated.id;
  const mainAgent = await request(
    "/companies/" + companyId + "/agents",
    "POST",
    { name: "Hybrid Main Agent", role: "Coordinator", modelId: "openai/gpt-5.6-luna", tools: ["Web Search"], isActive: true },
    "hybrid-main-agent-" + stamp,
  );
  await request("/companies/" + companyId + "/main-agent", "PUT", { agentId: mainAgent.id, expectedRevision: company.revision });

  const exactCode = "LEXICAL-7391-" + stamp;
  const memoryCode = "MEMORY-5512-" + stamp;
  const document = await request(
    "/companies/" + companyId + "/knowledge/documents",
    "POST",
    {
      filename: "hybrid-retrieval.txt",
      mimeType: "text/plain",
      data: Buffer.from("Emergency refund escalation code is " + exactCode + ". Use it only for disputed enterprise refunds.").toString("base64"),
    },
    "hybrid-document-" + stamp,
  );
  await request("/companies/" + companyId + "/knowledge/memory", "POST", {
    content: "Priority customer recovery code is " + memoryCode,
  });

  let ready = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const documents = await request("/companies/" + companyId + "/knowledge/documents");
    const current = documents.documents.find((item) => item.id === document.id);
    if (current?.status === "failed") throw new Error("Document processing failed: " + current.errorMessage);
    if (current?.status === "ready") { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) throw new Error("Document processing timed out");

  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.addInitScript(({ accessToken, user }) => {
    localStorage.setItem("npati_agent_access_token", accessToken);
    localStorage.setItem("npati_agent_user", JSON.stringify(user));
  }, { accessToken: token, user: login.user });
  await page.goto(webBase + "/company", { waitUntil: "networkidle" });
  await page.getByLabel("Select company").selectOption(companyId);
  const permissionAlert = page.locator(".company-knowledge-permission-alert");
  await permissionAlert.waitFor();
  await permissionAlert.getByRole("button", { name: "Enable Knowledge for Main Agent" }).click();
  await permissionAlert.waitFor({ state: "detached" });
  const agents = await request("/companies/" + companyId + "/agents?limit=60");
  const storedMain = agents.agents.find((agent) => agent.id === mainAgent.id);
  if (!storedMain?.tools.includes("Knowledge")) throw new Error("Knowledge permission button did not update the Main Agent");

  const exact = await request("/companies/" + companyId + "/knowledge/retrieve", "POST", { query: exactCode, limit: 6 });
  if (!exact.chunks.some((item) => item.content.includes(exactCode))) throw new Error("PostgreSQL hybrid retrieval missed the exact document code");
  const companyChat = await request("/chat", "POST", {
    message: "Find the exact emergency refund code in the uploaded Company document.",
    contextType: "company",
    companyId,
  });
  if (!companyChat.message?.includes(exactCode)) throw new Error("Company chat did not ground its answer in the uploaded document: " + String(companyChat.message));
  const memory = await request("/companies/" + companyId + "/knowledge/retrieve", "POST", { query: memoryCode, limit: 6 });
  if (!memory.memories.some((item) => item.content.includes(memoryCode))) throw new Error("Scoped Company Memory retrieval missed the exact memory code");
  const isolatedResult = await request("/companies/" + isolatedCompanyId + "/knowledge/retrieve", "POST", { query: exactCode, limit: 6 });
  if (isolatedResult.chunks.some((item) => item.content.includes(exactCode))) throw new Error("Cross-company knowledge leakage detected");
  const inspector = await request("/capabilities/inspect");
  const inspected = inspector.capabilities ?? inspector.items ?? [];
  for (const capabilityId of [
    "research.vector_semantic_search",
    "storage.hybrid_memory_retrieval",
    "research.semantic_memory_search",
    "research.hybrid_keyword_vector_search",
  ]) {
    const capability = inspected.find((item) => item.capabilityId === capabilityId || item.capability?.id === capabilityId);
    const status = capability?.status ?? capability?.classification?.status ?? capability?.effectiveStatus;
    if (status !== "VERIFIED_EXISTING") throw new Error(capabilityId + " is not Verified: " + String(status));
  }

  console.log(JSON.stringify({
    documentStatus: "ready",
    pgvectorAndFtsResult: true,
    knowledgePermissionUi: true,
    companyChatGroundedResult: true,
    companyMemoryResult: true,
    crossCompanyIsolation: true,
    inspectorStatuses: "VERIFIED_EXISTING",
    exactCode,
  }, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  if (companyId) await request("/companies/" + companyId, "DELETE").catch(() => undefined);
  if (isolatedCompanyId) await request("/companies/" + isolatedCompanyId, "DELETE").catch(() => undefined);
}
