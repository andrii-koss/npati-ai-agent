import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smoke = process.argv.includes("--smoke");
const target = Number.parseInt(process.env.NPATI_SCALE_TARGET ?? (smoke ? "200" : "10000"), 10);
const endpoints = (process.env.NPATI_SCALE_ENDPOINTS ?? "http://127.0.0.1:3101,http://127.0.0.1:3102").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
const secret = process.env.NPATI_JWT_SECRET ?? "pati-backend-jwt-secret-key-2024-min-32-chars-long";
const userId = `scale-cert-${Date.now()}`;
const batchSize = Number.parseInt(process.env.NPATI_SCALE_BATCH_SIZE ?? "250", 10);
const holdMs = Number.parseInt(process.env.NPATI_SCALE_HOLD_MS ?? (smoke ? "250" : "16000"), 10);
const connectTimeoutMs = Number.parseInt(process.env.NPATI_SCALE_CONNECT_TIMEOUT_MS ?? "90000", 10);
const reportPath = path.join(rootDir, "packages", "shared", "src", "scale-certification-report.json");

function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ userId, role: "user", iat: now, exp: now + 1800 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

const authorization = `Bearer ${token()}`;
const connections = [];
const latencies = [];
const failures = [];

function openSession(endpoint, sessionId) {
  let timeout;
  return new Promise((resolve) => {
    const started = performance.now();
    const request = http.get(`${endpoint}/sessions/${sessionId}/stream`, { headers: { authorization }, agent: false }, (response) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (error) { response.destroy(); failures.push({ sessionId, endpoint, error }); }
        else { connections.push({ request, response, sessionId, endpoint }); latencies.push(performance.now() - started); }
        resolve();
      };
      if (response.statusCode !== 200) return finish(`HTTP ${response.statusCode}`);
      response.once("data", (chunk) => finish(String(chunk).includes("event: ready") ? undefined : "missing ready event"));
      response.once("error", (error) => finish(error.message));
      timeout = setTimeout(() => finish("ready timeout"), connectTimeoutMs);
    });
    request.once("error", (error) => { failures.push({ sessionId, endpoint, error: error.message }); resolve(); });
  });
}

async function statusRequest(endpoint, sessionId, auth = authorization) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${endpoint}/sessions/${sessionId}/stream`, { headers: auth ? { authorization: auth } : {}, agent: false }, (response) => {
      resolve(response.statusCode ?? 0);
      response.destroy(); request.destroy();
    });
    request.setTimeout(10_000, () => request.destroy(new Error("status request timeout")));
    request.once("error", reject);
  });
}

async function activeCount() {
  const response = await fetch(`${endpoints[0]}/sessions/active`, { headers: { authorization } });
  if (!response.ok) throw new Error(`Active-session count returned HTTP ${response.status}`);
  return (await response.json()).activeSessions;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const startedAt = new Date().toISOString();
const started = performance.now();
let registered = 0, duplicateStatus = 0, unauthorizedStatus = 0, cleanupCount = -1, capabilityStatuses = {};
try {
  if (!smoke && target !== 10_000) throw new Error("Full certification requires exactly 10,000 sessions. Use --smoke for a smaller diagnostic run.");
  if (!smoke && endpoints.length < 2) throw new Error("Full certification requires at least two API replica endpoints.");
  for (let offset = 0; offset < target; offset += batchSize) {
    const size = Math.min(batchSize, target - offset);
    await Promise.all(Array.from({ length: size }, (_, index) => {
      const id = offset + index;
      return openSession(endpoints[id % endpoints.length], `scale-${userId}-${id.toString().padStart(5, "0")}`);
    }));
    if (failures.length) break;
  }
  registered = await activeCount();
  duplicateStatus = await statusRequest(endpoints[1 % endpoints.length], `scale-${userId}-00000`);
  unauthorizedStatus = await statusRequest(endpoints[0], `unauth-${userId}-00000`, "");
  if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
} finally {
  for (const connection of connections) { connection.response.destroy(); connection.request.destroy(); }
  const inspectorResponse = await fetch(`${endpoints[0]}/capabilities/inspect`, { headers: { authorization } });
  if (!inspectorResponse.ok) throw new Error(`Capability Inspector returned HTTP ${inspectorResponse.status}`);
  const inspector = await inspectorResponse.json();
  for (const item of inspector.capabilities ?? inspector.items ?? []) {
    const id = item.id ?? item.capability?.id;
    if (id === 192 || id === 290) capabilityStatuses[id] = item.status ?? item.classification?.status ?? item.effectiveStatus;
  }
  const deadline = Date.now() + 20_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 100));
    cleanupCount = await activeCount().catch(() => -1);
  } while (cleanupCount > 0 && Date.now() < deadline);
}

const durationMs = performance.now() - started;
const passed = failures.length === 0 && connections.length === target && registered === target && duplicateStatus === 409 && unauthorizedStatus === 401 && cleanupCount === 0 && capabilityStatuses[192] === "VERIFIED_EXISTING" && capabilityStatuses[290] === "VERIFIED_EXISTING" && (smoke || endpoints.length >= 2);
const report = {
  schemaVersion: 2,
  mode: smoke ? "smoke" : "distributed-production-certification",
  startedAt,
  completedAt: new Date().toISOString(),
  passed,
  target,
  endpoints,
  capabilityStatuses,
  metrics: {
    connected: connections.length,
    registered,
    failures: failures.length,
    duplicateStatus,
    unauthorizedStatus,
    cleanupCount,
    durationMs: Number(durationMs.toFixed(2)),
    connectionP50Ms: Number(percentile(latencies, 0.5).toFixed(2)),
    connectionP95Ms: Number(percentile(latencies, 0.95).toFixed(2)),
    connectionP99Ms: Number(percentile(latencies, 0.99).toFixed(2)),
    heldAcrossHeartbeat: holdMs >= 15_000,
  },
  failureSamples: failures.slice(0, 20),
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
