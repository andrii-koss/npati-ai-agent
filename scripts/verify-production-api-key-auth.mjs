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
async function request(path, { method = "GET", token, apiKey, body, deviceId, userAgent, platform, forwardedFor, headers: extraHeaders = {} } = {}) {
  const headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(apiKey ? {
      "x-npati-api-key": apiKey,
      "x-device-id": deviceId ?? "e2e-primary-device",
      "user-agent": userAgent ?? "NPATI-E2E/1.0",
      "sec-ch-ua-platform": platform ?? "Docker",
      "x-forwarded-for": forwardedFor ?? "172.30.0.10",
    } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) ? { "idempotency-key": `api-key-e2e-${stamp}-${Math.random()}` } : {}),
    ...extraHeaders,
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
const inspector = await request("/capabilities/inspect", { token: admin });
const capabilities = inspector.data?.capabilities ?? inspector.data?.items ?? [];
for (const capabilityId of [38, 62, 221, 260]) {
  const capability = capabilities.find((item) => item.id === capabilityId);
  assert(inspector.status === 200 && capability?.status === "VERIFIED_EXISTING", `live Capability Inspector reports #${capabilityId} as Verified`, capability ?? inspector);
}
const tenantUser = userToken(`api-key-tenant-${stamp}`);
const preferencesUserA = userToken(`preferences-a-${stamp}`);
const preferencesUserB = userToken(`preferences-b-${stamp}`);

const companyA = await request("/companies", { method: "POST", token: admin, body: { name: `API Key A ${stamp}` } });
const companyB = await request("/companies", { method: "POST", token: admin, body: { name: `API Key B ${stamp}` } });
const companyOtherTenant = await request("/companies", { method: "POST", token: tenantUser, body: { name: `Other tenant ${stamp}` } });
assert(companyA.status === 201 && companyB.status === 201 && companyOtherTenant.status === 201, "test companies created in two tenants", { companyA, companyB, companyOtherTenant });

try {
  const preferencesA = await request("/ai/routing", { method: "PUT", token: preferencesUserA, body: { mode: "automatic", monthlyBudgetUsd: 137, warningPercent: 71, compression: "stacked" } });
  const preferencesB = await request("/ai/routing", { method: "PUT", token: preferencesUserB, body: { mode: "automatic", monthlyBudgetUsd: 913, warningPercent: 49, compression: "off" } });
  assert(preferencesA.status === 200 && preferencesB.status === 200, "two tenants store independent AI routing preferences", { preferencesA, preferencesB });
  const isolatedA = await request("/ai/routing", { token: preferencesUserA });
  const isolatedB = await request("/ai/routing", { token: preferencesUserB });
  assert(isolatedA.data.monthlyBudgetUsd === 137 && isolatedB.data.monthlyBudgetUsd === 913, "AI preferences are tenant scoped before restart", { isolatedA, isolatedB });

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

  const primaryAgain = await request(`/companies/${companyA.data.id}`, { apiKey: key.rawToken });
  assert(primaryAgain.status === 200, "repeat access updates the existing device", primaryAgain);
  for (let device = 2; device <= 6; device += 1) {
    const access = await request(`/companies/${companyA.data.id}`, {
      apiKey: key.rawToken,
      deviceId: `e2e-device-${device}`,
      userAgent: `NPATI-E2E/${device}.0`,
      platform: device % 2 === 0 ? "Android" : "iOS",
      forwardedFor: `172.30.0.${10 + device}`,
    });
    assert(access.status === 200, `device ${device} authenticated`, access);
  }
  const devices = await request(`/companies/${companyA.data.id}/api-keys/${key.id}/devices`, { token: admin });
  assert(devices.status === 200 && devices.data.totalDevices === 6, "six distinct devices persisted for one API key", devices);
  assert(devices.data.isAnomalous === true, "device sharing anomaly is reported above five devices", devices);
  const primary = devices.data.devices.find((device) => device.deviceId === "e2e-primary-device");
  assert(primary?.requestsCount >= 2, "repeat requests increment the stable device counter", primary);
  const isolatedDevices = await request(`/companies/${companyA.data.id}/api-keys/${key.id}/devices`, { token: tenantUser });
  assert(isolatedDevices.status === 404, "another tenant cannot inspect API-key devices", isolatedDevices);

  const invalidScope = await request(`/companies/${companyA.data.id}/api-keys`, { method: "POST", token: admin, body: { name: "Invalid", scopes: ["root:all"] } });
  assert(invalidScope.status === 400, "unknown scope rejected", invalidScope);
  const escalation = await request(`/companies/${companyOtherTenant.data.id}/api-keys`, { method: "POST", token: tenantUser, body: { name: "Escalation", scopes: ["*"] } });
  assert(escalation.status === 403, "non-admin wildcard delegation rejected", escalation);

  const sql = `SELECT length(key_hash), encrypted_secret = '${key.rawToken.replaceAll("'", "''")}' FROM company_api_keys WHERE id='${key.id}'`;
  const stored = execFileSync("docker", ["exec", "npati-agent-postgres", "psql", "-U", "npati", "-d", "npati_agent", "-tA", "-c", sql], { encoding: "utf8" }).trim();
  assert(stored === "64|f", "database stores a SHA-256 hash and no plaintext token", stored);
  const deviceSql = `SELECT count(*), bool_and(length(device_id) <= 160), max(requests_count) >= 2 FROM company_api_key_devices WHERE key_id='${key.id}'`;
  const storedDevices = execFileSync("docker", ["exec", "npati-agent-postgres", "psql", "-U", "npati", "-d", "npati_agent", "-tA", "-c", deviceSql], { encoding: "utf8" }).trim();
  assert(storedDevices === "6|t|t", "device telemetry is durable, bounded and deduplicated in PostgreSQL", storedDevices);

  const remoteCreated = await request(`/companies/${companyA.data.id}/remote-tokens`, { method: "POST", token: admin, body: { scopes: ["workspace:read"], ttlSeconds: 600, ipAllowlist: ["172.30.0.77"] } });
  assert(remoteCreated.status === 201 && remoteCreated.data.token?.startsWith("rat_"), "tenant-bound remote token minted", remoteCreated);
  const remoteToken = remoteCreated.data.token;
  const remoteOwn = await request(`/companies/${companyA.data.id}`, { token: remoteToken, headers: { "x-forwarded-for": "172.30.0.77" } });
  assert(remoteOwn.status === 200, "remote token accesses its bound company from an allowed IP", remoteOwn);
  const remoteOtherCompany = await request(`/companies/${companyB.data.id}`, { token: remoteToken, headers: { "x-forwarded-for": "172.30.0.77" } });
  assert(remoteOtherCompany.status === 403, "remote token cannot cross company scope", remoteOtherCompany);
  const remoteWrongIp = await request(`/companies/${companyA.data.id}`, { token: remoteToken, headers: { "x-forwarded-for": "203.0.113.9" } });
  assert(remoteWrongIp.status === 401, "remote token IP allowlist is fail-closed", remoteWrongIp);
  const remoteTampered = `${remoteToken.slice(0, -1)}${remoteToken.endsWith("a") ? "b" : "a"}`;
  const tamperedAccess = await request(`/companies/${companyA.data.id}`, { token: remoteTampered, headers: { "x-forwarded-for": "172.30.0.77" } });
  assert(tamperedAccess.status === 401, "tampered remote-token signature is rejected", tamperedAccess);
  const invalidTtl = await request(`/companies/${companyA.data.id}/remote-tokens`, { method: "POST", token: admin, body: { scopes: ["workspace:read"], ttlSeconds: 90_000 } });
  assert(invalidTtl.status === 400, "remote-token TTL is bounded", invalidTtl);
  const remoteEscalation = await request(`/companies/${companyOtherTenant.data.id}/remote-tokens`, { method: "POST", token: tenantUser, body: { scopes: ["*"] } });
  assert(remoteEscalation.status === 403, "non-admin remote-token scope escalation is rejected", remoteEscalation);
  execFileSync("docker", ["restart", "npati-agent-api"], { stdio: "ignore" });
  await waitForHealth();
  const preferencesAfterRestartA = await request("/ai/routing", { token: preferencesUserA });
  const preferencesAfterRestartB = await request("/ai/routing", { token: preferencesUserB });
  assert(preferencesAfterRestartA.data.monthlyBudgetUsd === 137 && preferencesAfterRestartB.data.monthlyBudgetUsd === 913, "tenant AI preferences survive API restart without leakage", { preferencesAfterRestartA, preferencesAfterRestartB });
  const remoteAfterRestart = await request(`/companies/${companyA.data.id}`, { token: remoteToken, headers: { "x-forwarded-for": "172.30.0.77" } });
  assert(remoteAfterRestart.status === 200, "scoped remote token remains valid after API restart", remoteAfterRestart);  const afterRestart = await request(`/companies/${companyA.data.id}`, { apiKey: key.rawToken });
  assert(afterRestart.status === 200, "API key persists and authenticates after API restart", afterRestart);
  const devicesAfterRestart = await request(`/companies/${companyA.data.id}/api-keys/${key.id}/devices`, { token: admin });
  assert(devicesAfterRestart.status === 200 && devicesAfterRestart.data.totalDevices === 6 && devicesAfterRestart.data.isAnomalous === true, "device telemetry and anomaly state survive API restart", devicesAfterRestart);

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
console.log("AES at rest, scoped remote tokens, tenant AI preferences, API key auth and device tracking Docker E2E: passed");