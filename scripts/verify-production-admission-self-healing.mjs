import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.NPATI_RESILIENCE_E2E_URL ?? "http://127.0.0.1:3018";
const jwtSecret = "pati-backend-jwt-secret-key-2024-min-32-chars-long";
const suffix = Date.now();
const upstreamName = "npati-resilience-e2e-upstream";
const apiName = "npati-resilience-e2e-api";
const image = "npati-agent-agent-api:latest";
const fixture = path.join(root, "scripts", "fixtures", "resilience-upstream.mjs");

function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: options.stdio ?? "pipe", timeout: options.timeout }).trim();
}
function cleanup() {
  for (const name of [apiName, upstreamName]) {
    try { docker(["rm", "-f", name]); } catch {}
  }
}
function token(userId) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ userId, email: userId + "@example.test", role: "user", iat: now, exp: now + 3600 });
  const signature = createHmac("sha256", jwtSecret).update(header + "." + payload).digest("base64url");
  return header + "." + payload + "." + signature;
}
async function request(route, { method = "GET", bearer, body, headers = {}, signal } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(bearer ? { authorization: "Bearer " + bearer } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, headers: response.headers, data };
}
function assert(condition, message, detail) {
  if (!condition) throw new Error(message + ": " + JSON.stringify(detail));
  console.log("✓ " + message);
}
async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(["exec", apiName, "node", "-e", "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { timeout: 2_000 });
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Temporary production API did not become healthy");
}

cleanup();
try {
  docker([
    "run", "-d", "--name", upstreamName,
    "--network", "npati-agent-network",
    "-v", fixture.replaceAll("\\", "/") + ":/tmp/resilience-upstream.mjs:ro",
    "--entrypoint", "node",
    image, "/tmp/resilience-upstream.mjs",
  ]);
  docker([
    "run", "-d", "--name", apiName,
    "--network", "npati-agent-network",
    "-p", "3018:3001",
    "-e", "NODE_ENV=production",
    "-e", "NPATI_AGENT_API_PORT=3001",
    "-e", "NPATI_AUTH_STRICT=true",
    "-e", "NPATI_JWT_SECRET=" + jwtSecret,
    "-e", "DATABASE_URL=postgresql://npati:npati@postgres:5432/npati_agent",
    "-e", "REDIS_URL=redis://redis:6379",
    "-e", "OMNIROUTE_BASE_URL=http://" + upstreamName + ":4010",
    "-e", "OMNIROUTE_API_KEY=resilience-e2e",
    "-e", "NPATI_ADMISSION_MAX_CONCURRENT=1",
    "-e", "NPATI_ADMISSION_MAX_QUEUE_LENGTH=3",
    "-e", "NPATI_ADMISSION_FREE_SHED_THRESHOLD=0.5",
    image,
  ]);
  await waitForHealth();

  const tenantA = token("resilience-a-" + suffix);
  const tenantB = token("resilience-b-" + suffix);

  const unauthenticatedMetrics = await request("/runtime/admission");
  assert(unauthenticatedMetrics.status === 401, "admission metrics require authentication", unauthenticatedMetrics);

  const added = await request("/ai/models/add", {
    method: "POST", bearer: tenantA, body: { providerId: "openai", modelId: "openai/broken/primary" },
  });
  assert(added.status === 200, "fault-injected primary registered through normal model API", added);

  const routing = await request("/ai/routing", {
    method: "PUT", bearer: tenantA,
    body: { mode: "manual", defaultModelId: "openai/broken/primary", fallbackOnFailure: true },
  });
  assert(routing.status === 200 && routing.data?.defaultModelId === "openai/broken/primary", "manual primary and automatic fallback persisted", routing);

  const healed = await request("/chat", {
    method: "POST", bearer: tenantA,
    body: { message: "Return the resilience verification phrase.", contextType: "none", noMemory: true },
  });
  assert(healed.status === 200 && healed.data.message === "Production fallback response", "real chat survives primary HTTP 503", healed);
  assert(healed.data.telemetry?.failoverCount === 1, "real chat exposes one self-healing failover", healed.data.telemetry);

  const ollamaChat = await request("/api/chat", {
    method: "POST", bearer: tenantA,
    body: { model: "openai/broken/primary", messages: [{ role: "user", content: "Verify compatible chat fallback." }], stream: false },
  });
  assert(ollamaChat.status === 200 && ollamaChat.data.message?.content === "Production fallback response", "Ollama-compatible chat uses the production queue and fallback", ollamaChat);

  const ollamaGenerate = await request("/api/generate", {
    method: "POST", bearer: tenantA,
    body: { model: "openai/broken/primary", prompt: "Verify compatible generate fallback.", stream: false },
  });
  assert(ollamaGenerate.status === 200 && ollamaGenerate.data.response === "Production fallback response", "Ollama-compatible generate uses the production queue and fallback", ollamaGenerate);

  const burst = await Promise.all(Array.from({ length: 12 }, (_, index) => request("/chat", {
    method: "POST", bearer: tenantA,
    headers: { "x-priority-tier": index % 2 ? "critical-orchestration" : "enterprise" },
    body: { message: "Burst request " + index, contextType: "none", noMemory: true },
  })));
  const admitted = burst.filter((item) => item.status === 200).length;
  const shed = burst.filter((item) => item.status === 429 && /^ADMISSION_QUEUE_/.test(item.data?.error?.code ?? "")).length;
  assert(admitted >= 1 && shed >= 1 && admitted + shed === burst.length, "real chat burst is bounded and sheds excess with HTTP 429", { admitted, shed, statuses: burst.map((item) => item.status) });

  const metrics = await request("/runtime/admission", { bearer: tenantA });
  assert(metrics.status === 200 && metrics.data.maxConcurrent === 1 && metrics.data.maxQueueLength === 3 && metrics.data.shed >= shed, "authenticated runtime metrics report actual queue pressure", metrics);

  const isolatedRouting = await request("/ai/routing", { bearer: tenantB });
  assert(isolatedRouting.status === 200 && isolatedRouting.data.mode === "automatic", "routing/fallback configuration is tenant-isolated", isolatedRouting);

  docker(["restart", apiName]);
  await waitForHealth();
  const afterRestart = await request("/chat", {
    method: "POST", bearer: tenantA,
    body: { message: "Verify fallback after API restart.", contextType: "none", noMemory: true },
  });
  assert(afterRestart.status === 200 && afterRestart.data.telemetry?.failoverCount === 1, "persisted routing still self-heals after API restart", afterRestart);

  console.log("Adaptive admission + self-healing Docker E2E: passed");
} finally {
  cleanup();
}