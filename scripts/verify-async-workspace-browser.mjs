/** Step 8 click/reload/reconnect drills against the real React panel and mocked existing HTTP contracts.
 * Requires Playwright (default: disposable install under artifacts/async-step-8-browser) and a local browser.
 * Does not contact a deployment, start producers or change flags. Run: node scripts/verify-async-workspace-browser.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "vite";

const root = process.cwd();
const reportPath = path.join(root, "artifacts/async-step-8-browser-report.json");
mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify({ status: "running", passed: 0, failed: 0 }));
const playwrightPath = process.env.NPATI_DRILL_PLAYWRIGHT ?? path.join(root, "artifacts/async-step-8-browser/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const executablePath = process.env.NPATI_DRILL_BROWSER ?? [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(existsSync);
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'; import { createRoot } from 'react-dom/client';
import { AsyncWorkspacePanel } from '/src/code-workspace/AsyncWorkspacePanel.tsx';
const scope = {companyId:'c',projectId:'p',sessionId:'s'};
createRoot(document.getElementById('root')).render(React.createElement(AsyncWorkspacePanel, {scope,runId:'root',isUk:false,onAvailability:()=>{},onRun:()=>{}}));
</script></body></html>`;
const server = await createServer({ root: path.join(root, "apps/web"), configFile: path.join(root, "apps/web/vite.config.ts"),
  server: { host: "127.0.0.1", port: 5179, strictPort: true }, plugins: [{ name: "async-workspace-drill", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== "/async-step8-drill") return next();
      response.setHeader("Content-Type", "text/html"); response.end(await server.transformIndexHtml(request.url, html));
    });
  } }] });
let browser;
const checks = [];
try {
  await server.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let childState = "interrupted", offline = false, revision = 1, continueFailure = true;
  let messages = []; const writes = [], continues = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), body = request.method() === "GET" ? null : JSON.parse(request.postData() ?? "{}");
    const send = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (request.method() !== "GET") writes.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/async-workspace")) {
      if (offline) return route.abort("failed");
      return send({ schemaVersion: 1, companyId: "c", projectId: "p", sessionId: "s", capabilities: { inbox: true, controls: true, resume: true, processes: true },
        operations: [{ operationId: "child-op", processId: "child-process", runId: "root", generation: 1, kind: "subagent", childRunId: "child", state: childState,
          exitCode: null, cancelRequested: childState === "interrupted", stopRequested: false, collected: false, delivered: false },
          { operationId: "shell-op", processId: "shell", runId: "root", generation: 1, kind: "process", state: "running", exitCode: null, cancelRequested: false, collected: false, delivered: false }] });
    }
    if (url.pathname.endsWith("/continue")) {
      continues.push(body.requestId);
      if (continueFailure) { continueFailure = false; return route.abort("failed"); }
      childState = "running"; return send({ childRunId: "child", duplicate: true }, 202);
    }
    if (url.pathname.endsWith("/interrupt")) { childState = "interrupted"; return send({ status: "requested" }, 202); }
    if (url.pathname.endsWith("/send_message")) return send({ target: "next-step" }, 202);
    if (url.pathname.endsWith("/tools/invoke")) return send({ result: { data: { output: '<script>window.injected=true</script>', nextOffset: 42, lossy: true } } });
    if (url.pathname.includes("/messages")) {
      if (request.method() === "POST") { revision++; messages = [{ id: "m", requestId: body.requestId, text: body.text, revision, target: "next-step", status: "pending", runId: "root" }]; }
      if (request.method() === "PUT") { revision++; messages = [{ ...messages[0], text: body.text, revision }]; }
      if (request.method() === "DELETE") { revision++; messages = []; }
      return send({ revision, phase: "running", runId: "root", lastError: null, messages, receipt: messages[0] ?? null });
    }
    return send({ error: { code: "unexpected_drill_request" } }, 500);
  });
  await page.goto("http://127.0.0.1:5179/async-step8-drill");
  await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Failed to fetch" }).waitFor();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Send message", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector('button[disabled]')?.textContent?.includes("Send message"));
  assert.equal(continues.length, 2); assert.equal(continues[0], continues[1]); checks.push("Continue retry retains the request identity");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.locator("textarea").fill("Inspect constraints"); await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Message accepted" }).waitFor();
  assert(writes.some(write => write.path.endsWith("/children/child/send_message") && write.body.text === "Inspect constraints")); checks.push("Child message reaches the existing child control route");
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Request accepted" }).waitFor();
  assert.equal(continues.length, 3); assert.notEqual(continues[1], continues[2]);
  await page.locator("textarea").fill("Inspect database"); await page.getByRole("button", { name: "Steer", exact: true }).click();
  await page.getByRole("textbox", { name: "Queued message" }).waitFor();
  await page.getByRole("textbox", { name: "Queued message" }).fill("Inspect indexes"); await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.getByRole("textbox", { name: "Queued message" }).waitFor({ state: "hidden" }); checks.push("Queue/steer, optimistic edit and discard use the existing inbox");
  await page.getByRole("button", { name: "Process output", exact: true }).click();
  await page.locator("pre").waitFor(); assert.equal(await page.evaluate(() => window.injected), undefined); checks.push("Process output renders inert text and reports lossy output");
  const beforeReload = writes.length; await page.reload(); await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
  assert.equal(writes.length, beforeReload); checks.push("Reload reconstructs existing operations with no producer/control writes");
  offline = true; await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByRole("status").filter({ hasText: "Controls paused" }).waitFor();
  for (const button of await page.getByRole("button").all()) assert(await button.isDisabled());
  offline = false; await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByRole("status").filter({ hasText: "Controls paused" }).waitFor({ state: "hidden" });
  assert.equal(writes.length, beforeReload); checks.push("Offline disables controls; reconnect performs reads only");
  assert.deepEqual(errors, []); console.log(JSON.stringify({ checks, passed: checks.length, failed: 0 }, null, 2));
  writeFileSync(reportPath, JSON.stringify({ status: "passed", checks, passed: checks.length, failed: 0 }, null, 2));
} catch (error) {
  writeFileSync(reportPath, JSON.stringify({ status: "failed", checks, passed: checks.length, failed: 1, error: String(error) }, null, 2));
  throw error;
} finally { await browser?.close(); await server.close(); }
