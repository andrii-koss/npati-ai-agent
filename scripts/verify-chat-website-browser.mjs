/** Real chat/card interaction in Edge, with mocked HTTP; never changes user projects. */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "vite";

const root = process.cwd();
const reportPath = path.join(root, "artifacts/chat-website-browser-report.json");
mkdirSync(path.dirname(reportPath), { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.NPATI_DRILL_PLAYWRIGHT ?? path.join(root, "artifacts/async-step-8-browser/node_modules/playwright/index.mjs")).href);
const executablePath = process.env.NPATI_DRILL_BROWSER ?? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(existsSync);
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client'; import {BrowserRouter} from 'react-router-dom';
import {WorkspaceProvider,BusinessChatPage} from '/src/BusinessWorkspace.tsx'; import '/src/styles.css';
import {I18nProvider} from '/src/i18n/index.tsx';
createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(BrowserRouter,null,
React.createElement(WorkspaceProvider,null,React.createElement('div',{className:'workspace'},
React.createElement('div',{className:'workspace-content chat-workspace-content'},React.createElement(BusinessChatPage,{neutralChat:true,companyId:'c',initialConversationId:'conv'})))))));
</script></body></html>`;
const server = await createServer({ root: path.join(root, "apps/web"), configFile: path.join(root, "apps/web/vite.config.ts"),
  server: { host: "127.0.0.1", port: 5181, strictPort: true }, plugins: [{ name: "chat-website-drill", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== "/chat-website-drill" && request.url !== "/c/conv") return next();
      response.setHeader("Content-Type", "text/html"); response.end(await server.transformIndexHtml(request.url, html));
    });
  } }] });
let browser;
const checks = [];
try {
  await server.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  await page.addInitScript(() => sessionStorage.setItem("npati_code_inbox:conv", JSON.stringify({ companyId: "c", projectId: "project", sessionId: "session", inboxEnabled: true })));
  const errors = []; page.on("pageerror", error => { errors.push(error.message); console.log("Browser error:", error.message); });
  const submissions = []; let token = 0, edited = false;
  const card = { id: "session", projectId: "project", sessionId: "session", companyId: "c", kind: "code_project", name: "Shop", framework: "Next.js", status: "completed", cardVersion: 2 };
  const messages = [{ id: "assistant-first", role: "assistant", content: "Site created.", createdAt: "2026-10-10T12:00:00Z", projectCard: card }];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const send = value => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/api/workspace/context") return send({ businesses: [], currentBusiness: null, currentCompany: null });
    if (url.pathname === "/api/conversations") return send([{ id: "conv", title: "Shop edits", updatedAt: "2026-10-10T12:00:00Z" }]);
    if (url.pathname === "/api/conversations/conv") return send({ conversation: { id: "conv" }, messages });
    if (url.pathname.endsWith("/code/sessions/session/messages")) return send({ revision: 1, phase: "settled", runId: null, lastError: null, messages: [] });
    if (url.pathname.endsWith("/preview/status")) return send({ isRunning: true });
    if (url.pathname.endsWith("/preview/token")) return send({ token: `preview-${++token}` });
    if (url.pathname.endsWith("/preview/proxy/")) return route.fulfill({ contentType: "text/html", body: `<h1>${edited ? "Green button" : "Original shop"}</h1>` });
    if (url.pathname === "/api/chat/stream") {
      const body = JSON.parse(request.postData()); submissions.push(body); edited = true;
      messages.push({ id: "user-edit", role: "user", content: body.message, createdAt: "2026-10-10T12:01:00Z" },
        { id: "assistant-edit", role: "assistant", content: "Button updated.", createdAt: "2026-10-10T12:01:01Z", projectCard: card });
      return route.fulfill({ contentType: "text/event-stream", body: `event: result\ndata: ${JSON.stringify({ message: "Button updated.", suggestedActions: [], routed: "code_runner", run: { status: "completed" }, conversationId: "conv", projectCard: card, activeContext: { contextType: "project", companyId: "c", projectId: "project", businessId: null } })}\n\n` });
    }
    return send({ items: [] });
  });
  await page.goto("http://127.0.0.1:5181/chat-website-drill");
  await page.waitForTimeout(1500);
  assert.deepEqual(errors, [], "React must render without errors");
  assert.equal(await page.getByRole("link", { name: "Open Code Workspace", exact: true }).count(), 0);
  assert.equal(await page.getByText("Pending coding messages", { exact: false }).count(), 0);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.frameLocator('iframe[title="Shop preview"]').getByText("Original shop").waitFor();
  assert.equal(await page.getByText("Open in Website Builder", { exact: false }).count(), 0);
  checks.push("A code_project card opens the website in the chat's right Preview drawer");
  const composer = page.locator("textarea").first(); await composer.fill("Make the button green"); await composer.press("Enter");
  await page.frameLocator('iframe[title="Shop preview"]').getByText("Green button").waitFor();
  assert.equal(submissions.length, 1); assert.equal(submissions[0].projectId, "project"); assert.equal(submissions[0].companyId, "c"); assert.equal(submissions[0].conversationId, "conv");
  checks.push("The composer stays usable with Preview open, sends the same project and refreshes the website after editing");
  await page.reload(); await page.getByRole("button", { name: "Preview", exact: true }).first().waitFor();
  assert.equal(submissions.length, 1);
  await page.getByRole("button", { name: "Preview", exact: true }).first().click();
  await page.frameLocator('iframe[title="Shop preview"]').getByText("Green button").waitFor();
  checks.push("Reload restores persisted project cards without starting another code run");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, "artifacts/chat-website-browser.png"), fullPage: true });
  writeFileSync(reportPath, JSON.stringify({ status: "passed", checks, passed: checks.length, failed: 0 }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failed: 0, checks }, null, 2));
} catch (error) {
  writeFileSync(reportPath, JSON.stringify({ status: "failed", checks, passed: checks.length, failed: 1, error: String(error) }, null, 2)); throw error;
} finally { await browser?.close(); await server.close(); }
