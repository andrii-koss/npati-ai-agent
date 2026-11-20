import { chmod, chown, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { automaticDomain, authorized, defaults, domainProof, domainsFor, localEnabled, ProductionError, projectKey, publicOrigin, publicUrl, runtimeEnvironment, settingsFor, tlsEnabled, verifyDomains, writeJson, writeRoutes } from "./config.mjs";
import { publicRequest, readJson, text, trafficSummary } from "./http.mjs";
import { applicationFor, buildRelease, dataDir, discardRelease, projectDir, readOptionalJson, rootFor, validateSnapshot } from "./releases.mjs";
import { reserveUid } from "./workloads.mjs";

const routesDir = "/routes";
const records = new Map();
const hosts = new Map();
const apps = new Map();
const pending = new Set();
const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
const newRecord = key => ({ key, release: null, job: null, activity: [], logs: [], traffic: {} });
const statePath = key => join(projectDir(key), "record.json");
const trafficPath = key => join(projectDir(key), "traffic.json");
const appKey = (record, release) => `${record.key}:${release.id}`;
let jobs = Promise.resolve();
let registry = Promise.resolve();
const maxBodyBytes = 34 * 1048576;
const memMax = Number(await readFile("/sys/fs/cgroup/memory.max", "utf8").catch(() => ""));
const usableMiB = Number.isFinite(memMax) && memMax > 0 ? Math.floor(memMax / 1048576) - 384 : 3712;
let buildingMiB = 0;

function pushActivity(record, event, detail) {
  record.activity = [{ at: new Date().toISOString(), event, detail }, ...record.activity].slice(0, 30);
}

function pushLog(record, source, message) {
  const sanitized = message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim().slice(0, 2000);
  if (!sanitized) return;
  record.logs = [...record.logs.slice(-79), { at: new Date().toISOString(), source, message: sanitized }];
  record.logsDirty = true;
}

const locked = operation => {
  const next = registry.then(operation, operation);
  registry = next.catch(() => {});
  return next;
};

async function persist(record) {
  record.logsDirty = false;
  await mkdir(projectDir(record.key), { recursive: true, mode: 0o711 });
  await writeJson(statePath(record.key), { release: record.release, job: record.job, activity: record.activity, logs: record.logs });
}

async function refreshRoutes() {
  await writeRoutes(routesDir, records);
  hosts.clear();
  for (const record of records.values()) {
    if (record.release) for (const domain of domainsFor(record.release.settings)) hosts.set(domain, record);
  }
}

function assertDomainsAvailable(record, settings) {
  for (const domain of domainsFor(settings)) {
    const owner = hosts.get(domain);
    if (owner && owner !== record) throw new ProductionError(409, `Domain ${domain} is already published by another project.`);
  }
}

function reservedMemory() {
  return [...apps.values()].reduce((sum, app) => sum + app.memoryMiB, 0);
}

function applicationLog(record, release, message) {
  const values = Object.values(release.environment ?? {}).filter(value => value.length >= 4);
  for (const secret of values) message = message.replaceAll(secret, "[redacted]");
  pushLog(record, "application", message);
}

async function getApplication(record, release) {
  const key = appKey(record, release);
  const current = apps.get(key);
  if (current) return current.promise;
  if (record.nextAppAttempt && Date.now() < record.nextAppAttempt) return null;
  if (reservedMemory() + buildingMiB + release.settings.limits.memoryMiB > usableMiB) return null;
  const entry = { memoryMiB: release.settings.limits.memoryMiB, state: "starting" };
  entry.promise = applicationFor(record, release, message => applicationLog(record, release, message)).then(app => {
    entry.state = "running";
    void app.done.then(async () => {
      apps.delete(key);
      if (record.release?.id === release.id) {
        record.nextAppAttempt = Date.now() + 5000;
        pushActivity(record, "application_stopped", release.settings.domain);
        await locked(() => persist(record)).catch(console.error);
      }
    });
    return app;
  }).catch(error => {
    apps.delete(key);
    record.nextAppAttempt = Date.now() + 5000;
    pushLog(record, "application", error.message);
    return null;
  });
  apps.set(key, entry);
  return entry.promise;
}

async function stopRelease(record, release) {
  if (!release) return;
  const entry = apps.get(appKey(record, release));
  const app = entry && await entry.promise;
  if (app) {
    app.stop();
    await app.done;
  }
  reserveUid(release.uid, false);
  await discardRelease(record, release);
}

async function deploy(record, settings, files, environment) {
  let candidate;
  try {
    record.job = { state: "building", at: new Date().toISOString() };
    pushLog(record, "build", "Preparing production release");
    await locked(() => persist(record));
    if (reservedMemory() + settings.limits.memoryMiB > usableMiB) {
      throw new Error("Production has insufficient memory headroom for this build. Lower the project limit or increase its Docker memory cap.");
    }
    buildingMiB = settings.limits.memoryMiB;
    try {
      candidate = await buildRelease(record, settings, files, message => pushLog(record, "build", message), environment);
    } finally {
      buildingMiB = 0;
    }
    reserveUid(candidate.uid, true);
    if (candidate.kind === "node" && !(await getApplication(record, candidate))) {
      throw new Error("Candidate application did not become ready within its production limits. See Production logs.");
    }
    const previous = record.release;
    await locked(async () => {
      assertDomainsAvailable(record, settings);
      const previousActivity = record.activity;
      record.release = candidate;
      record.job = { state: "ready", at: new Date().toISOString() };
      pushLog(record, "build", `Release ready for ${settings.domain}`);
      pushActivity(record, "published", settings.domain);
      if (previous?.settings.domain !== settings.domain) pushActivity(record, "domain_changed", settings.domain);
      const previousDomains = previous ? domainsFor(previous.settings) : [];
      if (previous?.settings.aliasDomain !== settings.aliasDomain) pushActivity(record, "alias_changed", settings.aliasDomain ?? previous.settings.aliasDomain);
      for (const domain of domainsFor(settings)) {
        if (settings.tls && (!previous?.settings.tls || !previousDomains.includes(domain))) pushActivity(record, "https_requested", domain);
      }
      try {
        await persist(record);
        await refreshRoutes();
      } catch (error) {
        record.release = previous;
        record.activity = previousActivity;
        await persist(record);
        await refreshRoutes();
        throw error;
      }
    });
    candidate = null;
    // Give existing requests to the previous release time to finish.
    if (previous) setTimeout(() => { void stopRelease(record, previous).catch(console.error); }, (previous.settings.limits.timeoutSeconds + 2) * 1000).unref();
  } catch (error) {
    if (candidate) await stopRelease(record, candidate).catch(console.error);
    record.job = { state: "failed", at: new Date().toISOString(), error: error.message };
    pushActivity(record, "publish_failed", settings.domain);
    pushLog(record, "build", error.message);
    await locked(() => persist(record));
  } finally {
    pending.delete(record.key);
  }
}

async function statusFor(record, queryDomain) {
  const settings = record.release?.settings;
  let certificate = "disabled";
  if (settings?.tls) {
    const acme = await readOptionalJson("/certs/acme.json").catch(() => null);
    const domains = domainsFor(settings);
    const issued = domains.filter(domain => acme?.npati?.Certificates?.some(item =>
      item.domain?.main === domain || item.domain?.sans?.includes(domain)));
    certificate = issued.length === domains.length ? "issued" : "pending";
    const newlyIssued = issued.filter(domain => !record.activity.some(item => item.event === "https_issued" && item.detail === domain));
    for (const domain of newlyIssued) pushActivity(record, "https_issued", domain);
    if (newlyIssued.length) await locked(() => persist(record));
  }
  return {
    enabled: true, tlsEnabled, localEnabled, defaults, automaticDomain: automaticDomain(record.key),
    proof: queryDomain ? domainProof(record.key, queryDomain) : null,
    release: record.release && {
      kind: record.release.kind, createdAt: record.release.createdAt, url: publicUrl(settings), settings, certificate,
      runtime: record.release.kind === "static" ? "running" : apps.get(appKey(record, record.release))?.state ?? "unavailable",
    },
    job: record.job, logs: record.logs, activity: record.activity, traffic: trafficSummary(record.traffic),
  };
}

async function control(req, res) {
  const url = new URL(req.url, "http://production");
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
  if (!authorized(req.headers.authorization)) throw new ProductionError(401, "Unauthorized");
  const key = url.pathname.slice(1);
  if (!projectKey.test(key)) throw new ProductionError(404, "Unknown project");
  const existing = records.get(key);
  const record = existing ?? newRecord(key);
  if (req.method === "GET") return json(res, 200, await statusFor(record, url.searchParams.get("domain")));
  if (pending.has(key)) throw new ProductionError(409, "A publication is already in progress for this project.");
  if (req.method === "DELETE") {
    await locked(async () => {
      if (pending.has(key)) throw new ProductionError(409, "A publication is already in progress for this project.");
      if (!records.has(key)) return;
      const previous = record.release;
      if (previous) pushActivity(record, "unpublished", previous.settings.domain);
      record.release = null;
      record.job = null;
      await persist(record);
      await refreshRoutes();
      await stopRelease(record, previous);
      if (url.searchParams.get("purge") === "1") {
        await rm(projectDir(key), { recursive: true, force: true });
        records.delete(key);
      }
    });
    return json(res, 200, { removed: true });
  }
  if (req.method !== "POST") throw new ProductionError(405, "Method not allowed");
  if (pending.size >= 4) throw new ProductionError(429, "Production build queue is full. Try again shortly.");
  const input = await readJson(req, maxBodyBytes);
  if (!input || typeof input !== "object") throw new ProductionError(400, "Invalid publication settings.");
  const settings = settingsFor(key, input.settings ?? {});
  const environment = runtimeEnvironment(input.settings?.environment, record.release?.environment);
  assertDomainsAvailable(record, settings);
  await verifyDomains(key, settings, record.release?.settings);
  validateSnapshot(input.files);
  await locked(async () => {
    if (pending.has(key)) throw new ProductionError(409, "A publication is already in progress for this project.");
    if (pending.size >= 4) throw new ProductionError(429, "Production build queue is full. Try again shortly.");
    if (records.get(key) !== existing) throw new ProductionError(409, "Project publication changed. Try again.");
    assertDomainsAvailable(record, settings);
    pending.add(key);
    records.set(key, record);
    record.job = { state: "queued", at: new Date().toISOString() };
    try { await persist(record); }
    catch (error) { pending.delete(key); throw error; }
    jobs = jobs.then(() => deploy(record, settings, input.files, environment)).catch(console.error);
  });
  return json(res, 202, await statusFor(record));
}

await mkdir(dataDir, { recursive: true, mode: 0o711 });
await chmod(dataDir, 0o711);
await mkdir(routesDir, { recursive: true, mode: 0o755 });
await chmod(routesDir, 0o755);
await mkdir("/certs", { recursive: true, mode: 0o700 });
await chown("/certs", 65532, 65532);
await chmod("/certs", 0o700);
try {
  await writeFile("/certs/acme.json", "{}", { flag: "wx", mode: 0o600 });
  await chown("/certs/acme.json", 65532, 65532);
} catch (error) { if (error.code !== "EEXIST") throw error; }

for (const key of await readdir(dataDir)) {
  if (!projectKey.test(key)) continue;
  const saved = await readOptionalJson(statePath(key));
  if (!saved) continue;
  const record = { ...newRecord(key), ...saved, traffic: (await readOptionalJson(trafficPath(key))) ?? {} };
  if (["queued", "building"].includes(record.job?.state)) {
    record.job = { state: "failed", at: new Date().toISOString(), error: "Production restarted during the build. Publish again." };
    pushActivity(record, "publish_interrupted", record.release?.settings.domain ?? "");
    await persist(record);
  }
  if (record.release) reserveUid(record.release.uid, true);
  for (const dir of await readdir(projectDir(key))) {
    if (/^[a-f0-9-]{36}$/.test(dir) && dir !== record.release?.id) await discardRelease(record, { id: dir });
  }
  records.set(key, record);
}
await refreshRoutes();

const controlServer = createServer((req, res) => {
  void control(req, res).catch(error => {
    if (!(error instanceof ProductionError)) console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "Production service failed." });
  });
});
controlServer.maxConnections = 16;
controlServer.requestTimeout = 30000;
controlServer.listen(8091);

const publicServer = createServer((req, res) => {
  const host = req.headers.host?.toLowerCase().split(":")[0];
  const record = hosts.get(host);
  const settings = record?.release?.settings;
  if (!settings || !domainsFor(settings).includes(host)) return text(res, 404, "Unknown project");
  const redirectOrigin = host === settings.aliasDomain && settings.redirectAlias ? publicOrigin(settings) : undefined;
  void publicRequest(req, res, record, rootFor, getApplication, redirectOrigin).catch(error => {
    if (!res.destroyed) text(res, 500, "Production request failed");
    if (!["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(error.code)) console.error(error);
  });
});
publicServer.maxConnections = 512;
publicServer.requestTimeout = 35000;
publicServer.headersTimeout = 10000;
publicServer.listen(8090);

for (const record of records.values()) {
  if (record.release?.kind === "node") void getApplication(record, record.release);
}

setInterval(() => {
  void locked(async () => {
    for (const record of records.values()) {
      if (record.release) await writeJson(trafficPath(record.key), record.traffic);
      if (record.logsDirty) await persist(record);
    }
  }).catch(console.error);
}, 60000).unref();
