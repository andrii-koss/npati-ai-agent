import { createHmac, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const output = process.env.NPATI_AUDIT_OUTPUT ?? "/tmp/shared-browser-qa.json";
const secret = process.env.NPATI_SANDBOX_RUNNER_SECRET;
const base = process.env.NPATI_SANDBOX_RUNNER_URL ?? "http://127.0.0.1:7865";
if (!secret) throw new Error("Runner signing configuration is required");
const report = { startedAt: new Date().toISOString(), checks: [], cleanup: [] };
const owned = [];
async function call(operation, payload) {
  const body = JSON.stringify({ operation, payload }), timestamp = String(Date.now()), nonce = randomUUID();
  const signature = createHmac("sha256", secret).update(timestamp + "." + nonce + "." + body).digest("hex");
  const response = await fetch(new URL("/v1/sandbox", base), { method: "POST",
    headers: { "content-type": "application/json", "x-npati-timestamp": timestamp, "x-npati-nonce": nonce, "x-npati-signature": signature },
    body, signal: AbortSignal.timeout(75000) });
  const result = await response.json();
  if (!response.ok || result.error) throw Object.assign(new Error(result.error?.message ?? "Runner operation failed"),
    { code: result.error?.code, httpStatus: response.status });
  return result.result;
}
function assert(value, message) { if (!value) throw new Error(message); }
async function check(name, action) {
  const started = Date.now();
  try { const evidence = await action(); report.checks.push({ name, status: "passed", durationMs: Date.now() - started, evidence }); return evidence; }
  catch (error) { report.checks.push({ name, status: "failed", durationMs: Date.now() - started, code: error.code, message: error.message }); throw error; }
}
const server = "import http from 'node:http';import{readFileSync}from'node:fs';http.createServer((req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}if(req.url==='/gone'){res.writeHead(404);res.end('Missing');return;}res.setHeader('Content-Type','text/html');res.end(readFileSync('index.html'));}).listen(Number(process.env.PORT),'0.0.0.0');";
const bad = "<!doctype html><html><body><main><h1>QA fixture</h1><button></button><a href='/gone'>Broken</a><script>console.error('Fixture diagnostic');throw new Error('Fixture runtime error');</script></main></body></html>";
const good = "<!doctype html><html lang='en'><head><title>QA repaired</title><meta name='viewport' content='width=device-width,initial-scale=1'></head><body style='margin:auto;max-width:900px;padding:16px'><main><h1>QA repaired</h1><button>Continue</button><a href='/okay'>Working</a></main></body></html>";
const source = html => [{ path: "server.mjs", content: server }, { path: "index.html", content: html }];
const summarize = qa => ({ statusCode: qa.statusCode, consoleErrorCount: qa.consoleErrorCount, brokenLinks: qa.brokenLinks.length,
  accessibility: qa.accessibility.length, screenshotBytes: qa.screenshot?.sizeBytes ?? 0, loadTimeMs: qa.loadTimeMs });
try {
  const scopes = Array.from({ length: 2 }, () => Object.fromEntries(["workspaceId", "userId", "companyId", "projectId"].map(key => [key, randomUUID()])));
  for (const scope of scopes) {
    const created = await check("create:" + owned.length, () => call("createSandbox", { scope }));
    owned.push({ scope, sandboxId: created.id });
  }
  const common = owned[0], port = (await call("exposePort", { ...common, port: 3000 })).port;
  await call("startSandbox", common);
  await call("uploadFiles", { ...common, files: source(bad) });
  await check("start-server", async () => {
    const result = await call("startProcess", { ...common, command: "node server.mjs", options: { timeoutMs: 30000, outputLimitBytes: 16000 } });
    assert(result.processId, "Missing process identity");
    return { processId: result.processId };
  });
  await check("preview-http", async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try { const result = await call("proxyPreview", { ...common, options: { port, path: "/", method: "GET", headers: {} } });
        if (result.status === 200) return { statusCode: result.status }; } catch { /* bounded startup */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("Preview did not become ready");
  });
  const options = { port, path: "/", viewport: { width: 375, height: 667 }, timeoutMs: 30000,
    maxScreenshotBytes: 500000, maxBrokenLinks: 10, screenshot: true };
  await check("real-browser-detects-console-links-a11y", async () => {
    const qa = await call("inspectBrowser", { ...common, options });
    assert(qa.statusCode === 200 && qa.consoleErrorCount >= 1 && qa.brokenLinks.length >= 1 && qa.accessibility.length >= 2, "Expected actual DOM/runtime findings");
    assert(qa.screenshot?.redacted === true && qa.screenshot.sizeBytes > 0, "Missing redacted browser screenshot");
    return summarize(qa);
  });
  await check("same-project-fix", async () => {
    await call("uploadFiles", { ...common, files: source(good) });
    return { projectId: common.scope.projectId, updatedFile: "index.html" };
  });
  for (const viewport of [{ width: 375, height: 667 }, { width: 1280, height: 800 }]) {
    await check("real-browser-revalidates:" + viewport.width, async () => {
      const qa = await call("inspectBrowser", { ...common, options: { ...options, viewport } });
      assert(qa.statusCode === 200 && qa.consoleErrorCount === 0 && qa.brokenLinks.length === 0 && qa.accessibility.length === 0, "Repaired application still has QA findings");
      return { ...summarize(qa), viewport };
    });
  }
  await check("foreign-project-refused", async () => {
    try { await call("inspectBrowser", { ...common, scope: owned[1].scope, options }); }
    catch (error) { assert(error.httpStatus === 403, "Wrong ownership refusal"); return { code: error.code }; }
    throw new Error("Foreign project obtained Browser QA");
  });
  await check("foreign-port-refused", async () => {
    const other = (await call("exposePort", { ...owned[1], port: 3000 })).port;
    try { await call("inspectBrowser", { ...common, options: { ...options, port: other } }); }
    catch (error) { assert(error.httpStatus === 403, "Wrong port refusal"); return { code: error.code }; }
    throw new Error("Foreign port was accepted");
  });
} catch (error) {
  report.error = { code: error.code, message: error.message };

}
finally {
  for (const common of owned.reverse()) {
    try { await call("destroySandbox", common); report.cleanup.push({ sandboxId: common.sandboxId, status: "passed" }); }
    catch (error) { report.cleanup.push({ sandboxId: common.sandboxId, status: "failed", code: error.code }); }
  }
  report.finishedAt = new Date().toISOString();
  report.status = report.checks.length === 10 && report.checks.every(item => item.status === "passed") && report.cleanup.length === 2 && report.cleanup.every(item => item.status === "passed") ? "passed" : "failed";
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, output }));
  if (report.status !== "passed") process.exitCode = 1;
}
