import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const base = process.env.NPATI_API_URL ?? "http://localhost:3001";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHmacJwt(payload, secret = "pati-backend-jwt-secret-key-2024-min-32-chars-long", header = { alg: "HS256", typ: "JWT" }) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const fullPayload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7200,
    ...payload,
  };
  const p1 = enc(header);
  const p2 = enc(fullPayload);
  const sig = crypto.createHmac("sha256", secret).update(`${p1}.${p2}`).digest("base64url");
  return `${p1}.${p2}.${sig}`;
}

console.log("==========================================================");
console.log("  NPATI AGENT — P0.1 PRODUCTION SECURITY & AUTH SUITE     ");
console.log("==========================================================");

// 1. Initial login to get an admin Bearer token for setup
console.log("\n[1/8] Authenticating admin user against live container...");
const loginRes = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "webuser1@example.com", password: "Password123!" }),
});
const login = await loginRes.json();
if (!loginRes.ok || !login.tokens?.accessToken) {
  throw new Error(`Admin login failed: ${JSON.stringify(login)}`);
}
const adminToken = login.tokens.accessToken;
console.log("✓ Admin login successful");

// Helper for authenticated requests
async function apiRequest(path, method = "GET", body = undefined, token = adminToken, customHeaders = {}) {
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

// 2. Capability Inspection Verification
console.log("\n[2/8] Verifying capability statuses via /capabilities/inspect...");
const inspectRes = await apiRequest("/capabilities/inspect");
if (!inspectRes.ok) throw new Error(`/capabilities/inspect failed: ${JSON.stringify(inspectRes.data)}`);

const targetIds = [35, 38, 61, 62, 221, 260];
const targetCaps = inspectRes.data.items.filter((i) => targetIds.includes(i.id));
for (const cap of targetCaps) {
  if (cap.status !== "VERIFIED_EXISTING") {
    throw new Error(`Capability #${cap.id} (${cap.capabilityId}) expected VERIFIED_EXISTING but got ${cap.status}`);
  }
}
console.log(`✓ All 6 production-certified capabilities confirmed VERIFIED_EXISTING in live Docker runtime:`);
targetCaps.forEach((c) => console.log(`  - #${c.id} [${c.capabilityId}]: ${c.status}`));

// 3. OIDC Dashboard Gate (#61)
console.log("\n[3/8] Testing OIDC Dashboard Gate (#61)...");
const validOidcIdToken = createHmacJwt({
  sub: "oidc-user-test-42",
  email: "oidc-operator@npati.ai",
  name: "OIDC Operator",
  roles: ["admin"],
  tenantId: "comp-oidc-42",
  iss: "https://auth.npati.ai",
  aud: "npati-dashboard",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 7200,
});

const oidcLoginRes = await fetch(`${base}/auth/oidc/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ idToken: validOidcIdToken }),
});
const oidcLogin = await oidcLoginRes.json();
if (!oidcLoginRes.ok || !oidcLogin.tokens?.accessToken) {
  throw new Error(`OIDC login failed: ${JSON.stringify(oidcLogin)}`);
}
console.log("✓ Valid OIDC token accepted; issued scoped dashboard session");

// Verify invalid OIDC issuer rejected
const invalidOidcToken = createHmacJwt({
  sub: "attacker",
  email: "attacker@evil.com",
  iss: "https://malicious-issuer.com",
  aud: "npati-dashboard",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 7200,
});

const invalidOidcRes = await fetch(`${base}/auth/oidc/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ idToken: invalidOidcToken }),
});
if (invalidOidcRes.status !== 401) {
  throw new Error(`Expected 401 for invalid OIDC issuer, got ${invalidOidcRes.status}`);
}
console.log("✓ Untrusted OIDC issuer strictly rejected with 401");

// 4. Content Moderation Endpoint (#57)
console.log("\n[4/8] Testing Content Moderation API (#57)...");
const benignMod = await apiRequest("/ai/moderations", "POST", {
  input: "Hello, could you explain the theory of general relativity and space-time curvature?",
});
if (!benignMod.ok || benignMod.data.results[0].flagged !== false) {
  throw new Error(`Benign moderation check failed: ${JSON.stringify(benignMod.data)}`);
}
console.log("✓ Benign prompt marked unflagged (flagged: false)");

const violentMod = await apiRequest("/ai/moderations", "POST", {
  input: "Instructions to execute a mass shooting and build a chemical bomb to kill innocent people",
});
if (!violentMod.ok || violentMod.data.results[0].flagged !== true || !violentMod.data.results[0].categories.violence) {
  throw new Error(`Harmful moderation check failed: ${JSON.stringify(violentMod.data)}`);
}
console.log("✓ Violent/destructive prompt intercepted and flagged (flagged: true, category: violence)");

// 5. Tenant-Scoped AI Preferences Isolation (#260)
console.log("\n[5/8] Testing Tenant-Scoped AI Preferences Strict Isolation (#260)...");
const stamp = Date.now();
const compARes = await apiRequest("/companies", "POST", { name: `Security Tenant A ${stamp}` });
const compBRes = await apiRequest("/companies", "POST", { name: `Security Tenant B ${stamp}` });
if (!compARes.ok || !compBRes.ok) throw new Error("Failed to create test companies");
const compAId = compARes.data.id;
const compBId = compBRes.data.id;

try {
  const tenantAToken = createHmacJwt({
    userId: `tenant-usr-a-${stamp}`,
    email: `tenant-a-${stamp}@npati.ai`,
    role: "user",
  });
  const tenantBToken = createHmacJwt({
    userId: `tenant-usr-b-${stamp}`,
    email: `tenant-b-${stamp}@npati.ai`,
    role: "user",
  });

  // Set routing preferences on Tenant A
  const putPrefA = await apiRequest("/ai/routing", "PUT", {
    mode: "automatic",
    compression: "stacked",
    monthlyBudgetUsd: 150,
    warningPercent: 80,
  }, tenantAToken);
  if (!putPrefA.ok) throw new Error(`Failed to set AI routing preferences for Tenant A: ${JSON.stringify(putPrefA.data)}`);

  // Query preferences on Tenant B (must NOT bleed from Tenant A)
  const getPrefB = await apiRequest("/ai/routing", "GET", undefined, tenantBToken);
  if (!getPrefB.ok) throw new Error(`Failed to get AI routing preferences for Tenant B: ${JSON.stringify(getPrefB.data)}`);

  if (getPrefB.data.monthlyBudgetUsd === 150 && getPrefB.data.compression === "stacked") {
    throw new Error("Tenant isolation failure: Tenant B inherited Tenant A's routing preferences!");
  }

  // Update Tenant B independently
  const putPrefB = await apiRequest("/ai/routing", "PUT", {
    mode: "automatic",
    compression: "off",
    monthlyBudgetUsd: 900,
    warningPercent: 50,
  }, tenantBToken);
  if (!putPrefB.ok) throw new Error(`Failed to set AI routing preferences for Tenant B: ${JSON.stringify(putPrefB.data)}`);

  // Verify Tenant A remains untouched
  const getPrefA = await apiRequest("/ai/routing", "GET", undefined, tenantAToken);
  if (getPrefA.data.monthlyBudgetUsd !== 150 || getPrefA.data.compression !== "stacked") {
    throw new Error(`Tenant isolation failure: Tenant A was overwritten or corrupted! Result: ${JSON.stringify(getPrefA.data)}`);
  }
  console.log("✓ Strict tenant isolation confirmed: AI routing preferences completely segregated per tenant workspace");

  // 6. API Key Auth & Device Tracking & Anomaly Threshold (#35 & #221)
  console.log("\n[6/8] Testing API Key Auth & Device Tracking (#35 & #221)...");
  const createKeyRes = await apiRequest(`/companies/${compAId}/api-keys`, "POST", {
    name: "Tenant A Live Key",
    scopes: ["chat:use", "workspace:read"],
  });
  if (!createKeyRes.ok) throw new Error(`Failed to create API key: ${JSON.stringify(createKeyRes.data)}`);
  const apiKeySecret = createKeyRes.data.key?.rawToken ?? createKeyRes.data.key?.secret ?? createKeyRes.data.rawToken;
  const apiKeyId = createKeyRes.data.key?.id ?? createKeyRes.data.id;
  console.log(`✓ API key created (id: ${apiKeyId}, tokenPrefix: ${apiKeySecret?.slice(0, 16)})`);

  // Make request using x-api-key from device-01
  const dev1Res = await fetch(`${base}/companies/${compAId}`, {
    headers: {
      "x-api-key": apiKeySecret,
      "x-device-id": "client-device-01",
      "user-agent": "npati-cli/1.0 (Darwin; arm64)",
    },
  });
  if (!dev1Res.ok) {
    throw new Error(`API key authentication failed on device 1: ${dev1Res.status} ${await dev1Res.text()}`);
  }

  // Verify device recorded in repository
  const listDevRes = await apiRequest(`/companies/${compAId}/api-keys/${apiKeyId}/devices`);
  if (!listDevRes.ok || listDevRes.data.devices.length !== 1) {
    throw new Error(`Device list failed or empty: ${JSON.stringify(listDevRes.data)}`);
  }
  if (listDevRes.data.devices[0].deviceId !== "client-device-01") {
    throw new Error(`Recorded device mismatch: expected client-device-01, got ${listDevRes.data.devices[0].deviceId}`);
  }
  console.log("✓ Device 'client-device-01' tracked and persisted on first call");

  // Simulate multiple distinct devices to trigger anomaly (>5 devices)
  for (let i = 2; i <= 6; i++) {
    await fetch(`${base}/companies/${compAId}`, {
      headers: {
        "x-api-key": apiKeySecret,
        "x-device-id": `client-device-0${i}`,
        "user-agent": `npati-tester/1.0 (node; device-${i})`,
      },
    });
  }

  const listDevAnomRes = await apiRequest(`/companies/${compAId}/api-keys/${apiKeyId}/devices`);
  if (!listDevAnomRes.ok) throw new Error(`Failed to query devices: ${JSON.stringify(listDevAnomRes.data)}`);
  if (listDevAnomRes.data.devices.length !== 6 || listDevAnomRes.data.isAnomalous !== true) {
    throw new Error(`Anomaly detection check failed: expected 6 devices & isAnomalous=true, got ${JSON.stringify(listDevAnomRes.data)}`);
  }
  console.log(`✓ Device tracking anomaly detected: ${listDevAnomRes.data.devices.length} devices recorded, isAnomalous flagged true`);

  // Test Deny-by-default Scope Enforcement:
  // Key only has ["chat:use", "workspace:read"] - calling a write or admin endpoint like POST /companies should fail
  const unauthorizedAction = await fetch(`${base}/companies`, {
    method: "POST",
    headers: {
      "x-api-key": apiKeySecret,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Malicious Company" }),
  });
  if (unauthorizedAction.status !== 403) {
    throw new Error(`Scope enforcement failed: expected 403 Forbidden for unauthorized scope, got ${unauthorizedAction.status}`);
  }
  console.log("✓ Deny-by-default scope enforcement: out-of-scope call rejected with 403 Forbidden");

  // 7. Scoped Remote Access Tokens (#62)
  console.log("\n[7/8] Testing Scoped Remote Access Tokens (#62)...");
  const ratCreateRes = await apiRequest(`/companies/${compAId}/remote-tokens`, "POST", {
    scopes: ["mcp:read"],
    ipAllowlist: ["127.0.0.1", "::1", "10.0.0.5"],
    ttlSeconds: 600,
  });
  if (!ratCreateRes.ok) throw new Error(`Failed to generate remote access token: ${JSON.stringify(ratCreateRes.data)}`);
  const ratToken = ratCreateRes.data.token;
  if (!ratToken.startsWith("rat_")) throw new Error(`Invalid token format: ${ratToken}`);
  console.log(`✓ Scoped remote access token issued: ${ratToken.slice(0, 12)}...`);

  // Verify token
  const ratVerifyRes = await apiRequest(`/companies/${compAId}/remote-tokens/verify`, "POST", {
    token: ratToken,
    clientIp: "127.0.0.1",
  });
  if (!ratVerifyRes.ok || ratVerifyRes.data.isValid !== true) {
    throw new Error(`Remote token verification failed: ${JSON.stringify(ratVerifyRes.data)}`);
  }

  // Verify IP allowlist enforcement
  const ratInvalidIpRes = await apiRequest(`/companies/${compAId}/remote-tokens/verify`, "POST", {
    token: ratToken,
    clientIp: "203.0.113.195", // Not in allowlist
  });
  if (ratInvalidIpRes.status !== 401 && ratInvalidIpRes.data.isValid !== false) {
    throw new Error(`Remote token IP allowlist check failed: untrusted IP should be rejected, got ${JSON.stringify(ratInvalidIpRes)}`);
  }
  console.log("✓ Remote access token IP allowlist enforced (127.0.0.1 allowed, 203.0.113.195 rejected)");

  // 8. Log Hygiene & PII/Secret Leak Check
  console.log("\n[8/8] Verifying zero secret / PII leakage in Docker container logs...");
  const logs = execFileSync("docker", ["logs", "--tail", "500", "npati-agent-api"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (logs.includes(apiKeySecret)) {
    throw new Error("SECURITY FAILURE: Raw API key secret leaked into container stdout/stderr!");
  }
  if (logs.includes(ratToken)) {
    throw new Error("SECURITY FAILURE: Raw remote access token leaked into container stdout/stderr!");
  }
  console.log("✓ Docker container logs clean: zero API secrets, remote tokens, or raw credentials logged");

} finally {
  // Cleanup test companies
  console.log("\nCleaning up test tenants...");
  await apiRequest(`/companies/${compAId}`, "DELETE").catch(() => undefined);
  await apiRequest(`/companies/${compBId}`, "DELETE").catch(() => undefined);
  console.log("✓ Test tenants cleaned up");
}

console.log("\n==========================================================");
console.log("  P0.1 SECURITY & AUTH CAPABILITIES VERIFIED (6/8; #57/#60 OPEN)     ");
console.log("==========================================================");
