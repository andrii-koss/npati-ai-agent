import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";

const base = process.env.NPATI_API_URL ?? "http://localhost:3001";
const jwtSecret = process.env.NPATI_JWT_SECRET ?? "pati-backend-jwt-secret-key-2024-min-32-chars-long";
const stamp = Date.now();
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function userToken(userId) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ userId, email: `${userId}@example.test`, role: "user", iat: now, exp: now + 3600 });
  const signature = createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
async function request(path, { method = "GET", token, apiKey, body } = {}) {
  const headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(apiKey ? { "x-npati-api-key": apiKey } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) ? { "idempotency-key": `api-key-e2e-${stamp}-${Math.random()}` } : {}),
  };
  const response = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}
function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(detail)}`);
  console.log(`✓ ${message}`);
}
async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(`${base}/health`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("API did not recover after restart");
}

const login = await request("/auth/login", { method: "POST", body: { email: "webuser1@example.com", password: "Password123!" } });
assert(login.status === 200 && login.data?.tokens?.accessToken, "administrator authenticated", login);
const admin = login.data.tokens.accessToken;
const tenantUser = userToken(`api-key-tenant-${stamp}`);

const companyA = await request("/companies", { method: "POST", token: admin, body: { name: `API Key A ${stamp}` } });
const companyB = await request("/companies", { method: "POST", token: admin, body: { name: `API Key B ${stamp}` } });
const companyOtherTenant = await request("/companies", { method: "POST", token: tenantUser, body: { name: `Other tenant ${stamp}` } });
assert(companyA.status === 201 && companyB.status === 201 && companyOtherTenant.status === 201, "test companies created in two tenants", { companyA, companyB, companyOtherTenant });

try {
  const created = await request(`/companies/${companyA.data.id}/api-keys`, { method: "POST", token: admin, body: { name: "Read-only production key" } });
  assert(created.status === 201, "API key created", created);
  const key = created.data.key;
  assert(key.scopes.length === 1 && key.scopes[0] === "workspace:read", "default scope is deny-by-default workspace:read", key.scopes);

  const ownCompany = await request(`/companies/${companyA.data.id}`, { apiKey: key.rawToken });
  assert(ownCompany.status === 200, "key accesses its bound company", ownCompany);
  const sameTenantOtherCompany = await request(`/companies/${companyB.data.id}`, { apiKey: key.rawToken });
  assert(sameTenantOtherCompany.status === 403, "same-tenant cross-company access denied", sameTenantOtherCompany);
  const otherTenant = await request(`/companies/${companyOtherTenant.data.id}`, { apiKey: key.rawToken });
  assert(otherTenant.status === 403, "cross-tenant access denied", otherTenant);

  const list = await request("/companies", { apiKey: key.rawToken });
  assert(list.status === 200 && list.data.companies.length === 1 && list.data.companies[0].id === companyA.data.id, "company listing is restricted to the bound company", list);
  const writeDenied = await request("/companies", { method: "POST", apiKey: key.rawToken, body: { name: "Escalation attempt" } });
  assert(writeDenied.status === 403, "read-only key cannot mutate workspace", writeDenied);

  const invalidScope = await request(`/companies/${companyA.data.id}/api-keys`, { method: "POST", token: admin, body: { name: "Invalid", scopes: ["root:all"] } });
  assert(invalidScope.status === 400, "unknown scope rejected", invalidScope);
  const escalation = await request(`/companies/${companyOtherTenant.data.id}/api-keys`, { method: "POST", token: tenantUser, body: { name: "Escalation", scopes: ["*"] } });
  assert(escalation.status === 403, "non-admin wildcard delegation rejected", escalation);

  const sql = `SELECT length(key_hash), encrypted_secret = '${key.rawToken.replaceAll("'", "''")}' FROM company_api_keys WHERE id='${key.id}'`;
  const stored = execFileSync("docker", ["exec", "npati-agent-postgres", "psql", "-U", "npati", "-d", "npati_agent", "-tA", "-c", sql], { encoding: "utf8" }).trim();
  assert(stored === "64|f", "database stores a SHA-256 hash and no plaintext token", stored);

  execFileSync("docker", ["restart", "npati-agent-api"], { stdio: "ignore" });
  await waitForHealth();
  const afterRestart = await request(`/companies/${companyA.data.id}`, { apiKey: key.rawToken });
  assert(afterRestart.status === 200, "API key persists and authenticates after API restart", afterRestart);

  const revoked = await request(`/companies/${companyA.data.id}/api-keys/${key.id}`, { method: "DELETE", token: admin });
  assert(revoked.status === 200 && revoked.data.revoked === true, "API key revoked", revoked);
  execFileSync("docker", ["restart", "npati-agent-api"], { stdio: "ignore" });
  await waitForHealth();
  const afterRevoke = await request(`/companies/${companyA.data.id}`, { apiKey: key.rawToken });
  assert(afterRevoke.status === 401, "revocation persists after API restart", afterRevoke);
} finally {
  await request(`/companies/${companyA.data.id}`, { method: "DELETE", token: admin });
  await request(`/companies/${companyB.data.id}`, { method: "DELETE", token: admin });
  await request(`/companies/${companyOtherTenant.data.id}`, { method: "DELETE", token: tenantUser });
}
console.log("API key auth Docker E2E: passed");