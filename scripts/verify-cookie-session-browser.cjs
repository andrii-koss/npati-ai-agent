// Browser check of the cookie session (security audit 2026-11-24, L6 stage 2). Run from the repository root against
// the local compose stack (http://localhost:3000). Uses the installation owner's session like verify-chat-browser.cjs;
// the token is passed straight into the browser cookie jar and never printed. Changes nothing but sign-in state.
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");

const ORIGIN = process.env.NPATI_APP_ORIGIN || "http://localhost:3000";
const authScript = `(async()=>{const fs=require('fs');const s=JSON.parse(fs.readFileSync('/app/data/installation-auth.json'));const r=await fetch(new URL('/api/v1/agent-installations/session',process.env.NPATI_BACKEND_URL),{method:'POST',headers:{authorization:'Bearer '+s.installationToken,'content-type':'application/json'},body:'{}'});const d=(await r.json()).data;console.log(JSON.stringify({accessToken:d&&d.accessToken,user:d&&d.user&&{id:d.user.id}}))})()`;

(async () => {
  // A test account's access token (NPATI_QA_ACCESS_TOKEN) or, on a self-hosted installation, the owner's session.
  const auth = process.env.NPATI_QA_ACCESS_TOKEN
    ? { accessToken: process.env.NPATI_QA_ACCESS_TOKEN }
    : JSON.parse(execFileSync("docker", ["exec", "npati-agent-api", "node", "-e", authScript], { encoding: "utf8" }));
  assert.ok(auth.accessToken, "No session: set NPATI_QA_ACCESS_TOKEN to a test account's access token (npati_hosted keeps no owner session)");
  const browser = await chromium.launch({ executablePath: process.env.NPATI_BROWSER_EXECUTABLE || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined), headless: true });
  const report = {};
  try {
    const context = await browser.newContext();
    await context.addCookies([
      { name: "npati_access", value: auth.accessToken, url: ORIGIN, httpOnly: true, sameSite: "Lax" },
      { name: "npati_csrf", value: "qa-" + Math.random().toString(36).slice(2), url: ORIGIN, sameSite: "Strict" },
    ]);
    const page = await context.newPage();
    const apiStatuses = [];
    page.on("response", (response) => { const url = new URL(response.url()); if (url.origin === ORIGIN && url.pathname.startsWith("/api/")) apiStatuses.push(response.status()); });
    await page.goto(ORIGIN + "/chat");
    await page.waitForTimeout(6000);

    report.pageSeesAccessCookie = await page.evaluate(() => document.cookie.includes("npati_access="));
    report.tokenInPageStorage = await page.evaluate((token) => Object.keys(localStorage).some((key) => (localStorage.getItem(key) || "").includes(token.slice(-24))), auth.accessToken);
    report.sessionMarker = await page.evaluate(() => /^npati-cookie-session:/.test(localStorage.getItem("npati_agent_session_marker") || ""));
    report.signedInUi = await page.evaluate(() => !document.querySelector(".auth-modal-backdrop"));
    report.api401s = apiStatuses.filter((status) => status === 401).length;
    // A mutating request through the app's fetch (marker header + CSRF added by the wrapper).
    report.mutationThroughApp = await page.evaluate(async () => {
      const marker = localStorage.getItem("npati_agent_session_marker");
      const response = await fetch("/api/stream-tickets", { method: "POST", headers: { authorization: "Bearer " + marker, "content-type": "application/json" }, body: JSON.stringify({ path: "/api/attachments/0f8fad5b-d9cb-469f-a165-70867728950e" }) });
      return response.status;
    });
    // The same request with the CSRF header stripped is refused: what a cross-site form would get.
    report.mutationWithoutCsrf = await page.evaluate(async () => {
      const request = new XMLHttpRequest();
      request.open("POST", "/api/stream-tickets", false);
      request.setRequestHeader("content-type", "application/json");
      request.send(JSON.stringify({ path: "/api/attachments/0f8fad5b-d9cb-469f-a165-70867728950e" }));
      return request.status + " " + (JSON.parse(request.responseText).error || {}).code;
    });
    report.meThroughCookie = await page.evaluate(async () => (await fetch("/api/auth/me")).status);
    console.log(JSON.stringify(report, null, 2));
    assert.equal(report.pageSeesAccessCookie, false, "The access cookie must be HttpOnly");
    assert.equal(report.tokenInPageStorage, false, "No credential may be stored by the page");
    assert.equal(report.signedInUi, true, "The app did not come up signed in");
    assert.equal(report.mutationThroughApp, 200, "A mutation through the app failed");
    assert.match(report.mutationWithoutCsrf, /^403 CSRF_TOKEN_REQUIRED/, "A mutation without the CSRF header was accepted");
    assert.equal(report.meThroughCookie, 200, "/auth/me through the cookie failed");
  } finally { await browser.close(); }
})().catch((error) => { console.error(String(error.message || error).replace(/eyJ[\w.-]+/g, "[REDACTED]")); process.exitCode = 1; });
