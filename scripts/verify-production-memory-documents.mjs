import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";

const base = process.env.NPATI_API_URL ?? "http://localhost:3001";
const jwtSecret = process.env.NPATI_JWT_SECRET ?? "pati-backend-jwt-secret-key-2024-min-32-chars-long";
const stamp = Date.now();
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function userToken(userId) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ userId, email: userId + "@example.test", role: "user", iat: now, exp: now + 3600 });
  const signature = createHmac("sha256", jwtSecret).update(header + "." + payload).digest("base64url");
  return header + "." + payload + "." + signature;
}
async function request(path, { method = "GET", token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) ? { "idempotency-key": "memory-doc-" + stamp + "-" + Math.random() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}
function assert(condition, message, detail) {
  if (!condition) throw new Error(message + ": " + JSON.stringify(detail));
  console.log("OK " + message);
}
async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(base + "/health")).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("API did not recover after restart");
}

console.log("NPATI #73/#74 production Docker E2E");
const tokenA = userToken("memory-doc-a-" + stamp);
const tokenB = userToken("memory-doc-b-" + stamp);
const userCode = "USER-" + stamp;
const companyCode = "MEMORY-" + stamp;
let companyA;
let companyB;

try {
  const initial = await request("/memory/user.md", { token: tokenA });
  assert(initial.status === 200 && initial.data.document === null, "new tenant starts without synthetic USER.md", initial);
  const userMd = "# User Profile: E2E User\n\n## Preferred Communication Style\n- Language: Ukrainian (uk)\n- Style: concise\n\n## Domain & Expertise\n- Production testing\n\n## Active Priorities\n- Verify " + userCode + "\n\n## Guidelines & Constraints\n- Use exact stored codes";
  const savedUser = await request("/memory/user.md", { method: "PUT", token: tokenA, body: { markdown: userMd, expectedRevision: 0 } });
  assert(savedUser.status === 200 && savedUser.data.document.revision === 1, "USER.md persisted with revision control", savedUser);

  companyA = await request("/companies", { method: "POST", token: tokenA, body: { name: "Memory Document A " + stamp } });
  companyB = await request("/companies", { method: "POST", token: tokenB, body: { name: "Memory Document B " + stamp } });
  assert(companyA.status === 201 && companyB.status === 201, "companies created in isolated tenants", { companyA, companyB });

  const memoryMd = "# Long-Term Memory: Company " + companyA.data.id + "\n\n## Core Business Context\n- Exact company code " + companyCode + "\n\n## User Preferences\n- Ukrainian\n\n## Architectural Decisions\n- PostgreSQL is authoritative\n\n## Operational Rules\n- Preserve exact codes";
  const savedCompany = await request("/companies/" + companyA.data.id + "/memory.md", { method: "PUT", token: tokenA, body: { markdown: memoryMd, expectedRevision: companyA.data.revision } });
  assert(savedCompany.status === 200 && savedCompany.data.document.revision === companyA.data.revision + 1, "MEMORY.md persisted in company scope", savedCompany);

  const crossTenant = await request("/companies/" + companyA.data.id + "/memory.md", { token: tokenB });
  assert(crossTenant.status === 403, "cross-tenant MEMORY.md access denied", crossTenant);
  const stale = await request("/companies/" + companyA.data.id + "/memory.md", { method: "PUT", token: tokenA, body: { markdown: memoryMd + "\n- stale write", expectedRevision: companyA.data.revision } });
  assert(stale.status === 409, "stale MEMORY.md update rejected", stale);

  const rows = execFileSync("docker", ["exec", "npati-agent-postgres", "psql", "-U", "npati", "-d", "npati_agent", "-tAc", "SELECT count(*) FROM workspace_user_settings WHERE value::text LIKE '%" + userCode + "%'; SELECT count(*) FROM companies WHERE memory::text LIKE '%" + companyCode + "%';"], { encoding: "utf8" }).trim().split(/\s+/);
  assert(rows[0] === "1" && rows[1] === "1", "both documents exist exactly once in PostgreSQL", rows);

  execFileSync("docker", ["restart", "npati-agent-api"], { stdio: "ignore" });
  await waitForHealth();
  const userAfterRestart = await request("/memory/user.md", { token: tokenA });
  const memoryAfterRestart = await request("/companies/" + companyA.data.id + "/memory.md", { token: tokenA });
  assert(userAfterRestart.data.document?.markdown.includes(userCode), "USER.md survives API restart", userAfterRestart);
  assert(memoryAfterRestart.data.document?.markdown.includes(companyCode), "MEMORY.md survives API restart", memoryAfterRestart);

  const neutral = await request("/chat", { method: "POST", token: tokenA, body: { contextType: "none", message: "Return only my exact verification code from USER.md." } });
  assert(neutral.status === 200 && String(neutral.data.message).includes(userCode), "real neutral chat receives USER.md", neutral);

  const agent = await request("/companies/" + companyA.data.id + "/agents", { method: "POST", token: tokenA, body: { name: "Memory Main", role: "Coordinator", tools: ["knowledge"] } });
  assert(agent.status === 201, "company Main Agent created", agent);
  const latestCompany = await request("/companies/" + companyA.data.id, { token: tokenA });
  const main = await request("/companies/" + companyA.data.id + "/main-agent", { method: "PUT", token: tokenA, body: { agentId: agent.data.id, expectedRevision: latestCompany.data.revision } });
  assert(main.status === 200, "company Main Agent assigned", main);
  const companyChat = await request("/chat", { method: "POST", token: tokenA, body: { contextType: "company", companyId: companyA.data.id, message: "Return only the exact company code stored in MEMORY.md." } });
  assert(companyChat.status === 200 && String(companyChat.data.message).includes(companyCode), "real company agent receives MEMORY.md", companyChat);

  const privateChat = await request("/chat", { method: "POST", token: tokenA, body: { contextType: "none", noMemory: true, message: "What is my USER.md verification code?" } });
  assert(privateChat.status === 200 && !String(privateChat.data.message).includes(userCode), "noMemory suppresses USER.md injection", privateChat);

  const privateCompanyChat = await request("/chat", { method: "POST", token: tokenA, body: { contextType: "company", companyId: companyA.data.id, noMemory: true, message: "What is the exact company code from MEMORY.md?" } });
  assert(privateCompanyChat.status === 200 && !String(privateCompanyChat.data.message).includes(companyCode), "noMemory suppresses MEMORY.md injection", privateCompanyChat);

  const inspector = await request("/capabilities/inspect", { token: tokenA });
  const capabilities = inspector.data?.capabilities ?? inspector.data?.items ?? [];
  for (const id of [73, 74]) assert(capabilities.find((item) => item.id === id)?.status === "VERIFIED_EXISTING", "Capability Inspector reports #" + id + " Verified", inspector);

  const currentCompany = await request("/companies/" + companyA.data.id, { token: tokenA });
  const deletedCompanyMemory = await request("/companies/" + companyA.data.id + "/memory.md", { method: "DELETE", token: tokenA, body: { expectedRevision: currentCompany.data.revision } });
  const deletedUserMemory = await request("/memory/user.md", { method: "DELETE", token: tokenA, body: { expectedRevision: userAfterRestart.data.document.revision } });
  assert(deletedCompanyMemory.status === 204 && deletedUserMemory.status === 204, "privacy deletion endpoints remove both documents", { deletedCompanyMemory, deletedUserMemory });
  assert((await request("/companies/" + companyA.data.id + "/memory.md", { token: tokenA })).data.document === null, "MEMORY.md is absent after deletion");
  assert((await request("/memory/user.md", { token: tokenA })).data.document === null, "USER.md is absent after deletion");
} finally {
  if (companyA?.data?.id) await request("/companies/" + companyA.data.id, { method: "DELETE", token: tokenA });
  if (companyB?.data?.id) await request("/companies/" + companyB.data.id, { method: "DELETE", token: tokenB });
  try {
    execFileSync("docker", ["exec", "npati-agent-postgres", "psql", "-U", "npati", "-d", "npati_agent", "-c", "DELETE FROM workspace_user_settings WHERE value::text LIKE '%" + userCode + "%';"], { stdio: "ignore" });
  } catch {}
}
console.log("NPATI #73/#74 production Docker E2E passed");
