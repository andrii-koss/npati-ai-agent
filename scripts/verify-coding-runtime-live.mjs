/** Real runner acceptance. Run inside the API container with its existing runner credentials.
 * This checks the execution backend, not autonomous model quality or the chat UI.
 * No flags, policies, images or existing projects are modified. Only owned fixtures are removed.
 */
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = process.env.NPATI_AUDIT_OUTPUT ?? "artifacts/coding-agent-audit-2026-10-15/live-runtime.json";
const base = process.env.NPATI_SANDBOX_RUNNER_URL;
const secret = process.env.NPATI_SANDBOX_RUNNER_SECRET;
const report = { kind: "real-runner-acceptance", autonomousAgentE2E: false, startedAt: new Date().toISOString(), checks: [], fixtures: [], cleanup: [] };
const owned = [];
async function call(operation, payload, timeout = 660_000) {
  if (!base || !secret) throw Object.assign(new Error("Existing runner configuration is required"), { code: "runner_not_configured" });
  const body = JSON.stringify({ operation, payload }), timestamp = String(Date.now()), nonce = randomUUID();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("hex");
  const response = await fetch(new URL("/v1/sandbox", base), { method: "POST", headers: { "content-type": "application/json", "x-npati-timestamp": timestamp, "x-npati-nonce": nonce, "x-npati-signature": signature }, body, signal: AbortSignal.timeout(timeout) });
  const result = await response.json();
  if (!response.ok || result.error) throw Object.assign(new Error(result.error?.message ?? `HTTP ${response.status}`), { code: result.error?.code ?? "runner_http_error", httpStatus: response.status });
  return result.result;
}
async function check(name, action) {
  const start = Date.now();
  try { const evidence = await action(); report.checks.push({ name, status: "passed", durationMs: Date.now() - start, evidence }); return evidence; }
  catch (error) { report.checks.push({ name, status: "failed", durationMs: Date.now() - start, code: error.code ?? "assertion_failed", message: String(error.message).slice(0, 1000) }); return null; }
}
function assert(value, message) { if (!value) throw new Error(message); }
const files = (entries) => Object.entries(entries).map(([path, content]) => ({ path, content }));
const pkg = (value) => JSON.stringify({ name: "npati-audit-fixture", private: true, version: "1.0.0", ...value });
const fixtures = [
  { name: "node", entries: { "package.json": pkg({ scripts: { test: "node --test" }, type: "module" }), "server.mjs": "import http from 'node:http';http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,path:req.url}));}).listen(Number(process.env.PORT ?? 3000),'0.0.0.0');", "api.test.mjs": "import {test} from 'node:test';import assert from 'node:assert/strict';test('arithmetic',()=>assert.equal(2+2,4));" }, verify: "npm test", start: "node server.mjs", expected: "ok" },
  { name: "python", entries: { "index.html": "<!doctype html><html lang='en'><title>Python audit</title><h1>Python audit</h1></html>" }, verify: "python3 -m compileall .", start: "python3 -m http.server 3000", expected: "Python audit" },
  { name: "vite", install: true, entries: { "package.json": pkg({ type: "module", scripts: { build: "vite build", dev: "vite --host 0.0.0.0 --port 3000" }, dependencies: { vite: "7.1.12", react: "19.2.0", "react-dom": "19.2.0" } }), "index.html": "<!doctype html><html lang='en'><title>Vite audit</title><body><div id='root'></div><script type='module' src='/src.jsx'></script></body></html>", "src.jsx": "import React from 'react';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<main><h1>Vite audit</h1><button onClick={e=>e.currentTarget.textContent='Updated'}>Change</button></main>);" }, verify: "npm run build", start: "npm run dev", expected: "root" },
  { name: "next", install: true, entries: { "package.json": pkg({ scripts: { build: "next build", dev: "next dev --hostname 0.0.0.0 --port 3000" }, dependencies: { next: "15.5.7", react: "19.2.0", "react-dom": "19.2.0" } }), "app/layout.jsx": "export const metadata={title:'Audit shop'};export default function Layout({children}){return <html lang='en'><body style={{margin:'auto',maxWidth:1000,padding:20}}>{children}</body></html>}", "app/page.jsx": "export default function Page(){return <main><h1>Audit shop</h1><a href='/products'>Products</a></main>}", "app/products/page.jsx": "export default function Products(){return <main><h1>Products</h1><a href='/'>Home</a></main>}" }, verify: "npm run build", start: "npm run dev", expected: "Audit shop" },
];
try {
  // Two sandboxes remain alive concurrently so scope checks exercise actual isolation.
  for (const fixture of fixtures) {
    if (process.env.NPATI_AUDIT_STACKS && process.env.NPATI_AUDIT_STACKS !== "all" && fixture.name !== process.env.NPATI_AUDIT_STACKS) continue;
    const scope = Object.fromEntries(["workspaceId", "userId", "companyId", "projectId"].map(key => [key, randomUUID()]));
    const created = await check(`${fixture.name}:create`, () => call("createSandbox", { scope }));
    if (!created) continue;
    const sandboxId = created.id, common = { scope, sandboxId };
    const exposed = await check(`${fixture.name}:port`, () => call("exposePort", { ...common, port: 3000 }));
    const port = exposed?.port ?? 3000;
    owned.push(common); report.fixtures.push({ name: fixture.name, ...common });
    await check(`${fixture.name}:start`, () => call("startSandbox", common));
    await check(`${fixture.name}:upload`, () => call("uploadFiles", { ...common, files: files(fixture.entries) }));
    const exec = async command => {
      const result = await call("executeCommand", { ...common, command, options: { timeoutMs: 600_000, outputLimitBytes: 64_000 } });
      assert(result.exitCode === 0 && result.status === "completed", `${command}: ${JSON.stringify(result).slice(-3000)}`); return result;
    };
    if (fixture.install) {
      const lock = await check(`${fixture.name}:lock`, () => exec("npm install --package-lock-only --ignore-scripts --no-audit --no-fund"));
      if (!lock) continue;
      const install = await check(`${fixture.name}:install`, () => exec("npm ci --ignore-scripts --no-audit --no-fund"));
      if (!install) continue;
    }
    await check(`${fixture.name}:verify`, () => exec(fixture.verify));
    const background = await check(`${fixture.name}:process`, () => call("startProcess", { ...common, command: fixture.start, options: { timeoutMs: 30_000, outputLimitBytes: 16_000 } }));
    if (!background) continue;
    await check(`${fixture.name}:preview`, async () => {
      let last;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { last = await call("proxyPreview", { ...common, options: { port, path: "/", method: "GET", headers: {} } }, 30_000); if (last.status === 200) break; } catch { /* bounded startup polling */ }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert(last?.status === 200, "Preview did not become ready");
      const html = Buffer.from(last.body, "base64").toString("utf8"); assert(html.includes(fixture.expected), "Preview content mismatch"); return { status: last.status, contentMatched: true };
    });
    await check(`${fixture.name}:browser`, async () => {
      const qa = await call("inspectBrowser", { ...common, options: { port, path: "/", viewport: { width: 390, height: 844 }, timeoutMs: 30_000, maxScreenshotBytes: 500_000, maxBrokenLinks: 20, screenshot: false } }, 60_000);
      assert(qa.statusCode === 200 && qa.consoleErrorCount === 0 && (fixture.name === "node" || qa.brokenLinks.length === 0 && qa.accessibility.length === 0), `Browser QA findings: ${JSON.stringify(qa)}`); return { ...qa, htmlChecksApplicable: fixture.name !== "node" };
    });
    if (fixture.name === "vite" && report.checks.at(-1)?.status === "failed") {
      // Diagnostics run only on this authored fixture, never on user projects or production QA logs.
      await check("vite:fixture-diagnostic", async () => {
        await call("uploadFiles", { ...common, files: [...files(fixture.entries), { path: "npati-audit-browser.cjs", content: "const {chromium}=require('/opt/npati-qa/node_modules/playwright');process.env.TMPDIR='/tmp';(async()=>{const origin='http://10.0.2.2:'+process.env.PORT;const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium-browser',args:['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server']});try{const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());const page=await context.newPage();await page.routeWebSocket('**/*',socket=>socket.close());const errors=[];page.on('console',message=>{if(message.type()==='error')errors.push(message.text().slice(0,500))});page.on('pageerror',error=>errors.push(String(error.message).slice(0,500)));await page.goto(origin,{waitUntil:'networkidle',timeout:30000});process.stdout.write(JSON.stringify({fixtureOnly:true,errors:errors.slice(0,10),heading:await page.locator('h1').textContent()}))}finally{await browser.close()}})().catch(error=>{console.error(String(error.message));process.exitCode=1})" }] });
        const result = await exec("node npati-audit-browser.cjs");
        return JSON.parse(result.stdout);
      });
    }
    await check(`${fixture.name}:ownership`, async () => {
      try { await call("getStatus", { ...common, scope: { ...scope, projectId: randomUUID() } }); }
      catch (error) { assert(error.httpStatus === 403 || error.httpStatus === 404, "Unexpected refusal"); return { denied: true, code: error.code }; }
      throw new Error("Foreign project obtained sandbox status");
    });
  }
} finally {
  for (const common of owned.reverse()) {
    try { await call("destroySandbox", common); report.cleanup.push({ sandboxId: common.sandboxId, status: "passed" }); }
    catch (error) { report.cleanup.push({ sandboxId: common.sandboxId, status: "failed", code: error.code }); }
  }
  report.finishedAt = new Date().toISOString();
  report.status = report.checks.some(item => item.status === "failed") || report.cleanup.some(item => item.status === "failed") ? "failed" : "passed";
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.map(({ name, status, code }) => ({ name, status, code })), output }));
  if (report.status !== "passed") process.exitCode = 1;
}
