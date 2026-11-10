import { chromium } from "playwright";
import { captureBrowserDiagnostic, isBlockedExternalResource } from "./browser-qa-diagnostics.mjs";
import { assertBrowserQaActions, runBrowserQaActions } from "./browser-qa-actions.mjs";

let stage = "input";
const fail = (code) => {
  process.stdout.write(JSON.stringify({ error: code, stage }));
  process.exitCode = 1;
};
try {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 4096) throw new Error("invalid_input");
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assertBrowserQaActions(input.actions);
  const { host, port, path, viewport, timeoutMs, maxScreenshotBytes, maxBrokenLinks, screenshot, screenshotMode = "layout" } = input;
  const shared = process.argv.includes("--shared-runtime");
  // The launcher gives every command a private /tmp; short paths fit Unix sockets.
  if (shared) process.env.TMPDIR = "/tmp";
  if (!(shared ? host === "10.0.2.2" : /^npati-sb-[0-9a-f-]{36}$/.test(host)) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof path !== "string" || !/^\/(?!\/)[A-Za-z0-9/_~.%-]*$/.test(path) || path.includes("..") ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000 ||
      !Number.isInteger(viewport?.width) || viewport.width < 320 || viewport.width > 1920 ||
      !Number.isInteger(viewport?.height) || viewport.height < 320 || viewport.height > 1200 ||
      !Number.isInteger(maxScreenshotBytes) || maxScreenshotBytes < 50000 || maxScreenshotBytes > 2000000 ||
      !Number.isInteger(maxBrokenLinks) || maxBrokenLinks < 1 || maxBrokenLinks > 50) throw new Error("invalid_input");
  if (!["layout", "visual"].includes(screenshotMode)) throw new Error("invalid_input");
  const origin = `http://${host}:${port}`;
  stage = "launch";
  // WebGL through Mesa's software renderer (llvmpipe): Alpine's Chromium has no SwiftShader, so without these flags every
  // Three.js or WebGL scene failed the check as a "runtime error" and the agent "repaired" working code blind (E2E G7).
  // Compositing stays in software: drawing the whole page through Mesa made every screenshot take 5-8 s instead of under 1 s.
  const webgl = ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist", "--disable-gpu-compositing"];
  // The sandbox has no direct network, not even DNS: allowed outside hosts (Google Fonts, the Flutter engine) are reached
  // through its egress proxy, which enforces the allowlist, and only the Preview itself is opened directly.
  const egress = shared ? process.env.HTTPS_PROXY ?? process.env.https_proxy : undefined;
  const browser = await chromium.launch({ headless: true, ...(shared ? { executablePath: "/usr/bin/chromium-browser" } : {}),
    ...(egress ? { proxy: { server: egress, bypass: `${host},localhost,127.0.0.1` } } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", ...webgl, ...(shared && !egress ? ["--no-proxy-server"] : [])] });
  try {
    const context = await browser.newContext({ viewport, serviceWorkers: "block", acceptDownloads: false });
    // A site calls its Project API at its own origin (/v1/projects/...), where the Preview server has no API. Inside the shared
    // runtime the egress proxy routes the Project API host, so those calls reach the real API, marked as checks: writes run
    // with the site's real rules and roll back, and a refused form shows up here instead of only for a real visitor.
    const apiBridge = shared && Boolean(egress) && !input.actions?.length;
    let formPhase = false;
    let apiCalls = 0;
    const apiLog = [];
    const pendingBodies = [];
    const apiFailures = [];
    // A site must call its Project API by a relative path. A fixed host (another installation's domain) works for nobody else.
    const foreignApiHosts = [];
    await context.route("**/*", async route => {
      let url;
      try { url = new URL(route.request().url()); } catch { return route.abort(); }
      if (apiBridge && url.origin === origin && url.pathname.startsWith("/v1/projects/") && !url.username && !url.password) {
        apiCalls++;
        // Sent from here through the sandbox egress proxy, the same way the site's own server reaches the Project API; the
        // page gets the API's real answer. A browser-side URL rewrite was refused on the way and hid the answer's body.
        const request = route.request();
        const headers = { "x-npati-dry-run": "1" };
        for (const [name, value] of Object.entries(request.headers())) if (["accept", "content-type", "x-project-key", "authorization"].includes(name.toLowerCase())) headers[name.toLowerCase()] = value;
        const body = request.postDataBuffer();
        try {
          // The sandbox sets NODE_USE_ENV_PROXY, so this fetch goes through the egress proxy like a site's server code does.
          const answer = await fetch("http://project-api.npati.internal" + url.pathname + url.search, {
            method: request.method(), headers, ...(body && body.length && !["GET", "HEAD"].includes(request.method()) ? { body } : {}),
            signal: AbortSignal.timeout(15000), redirect: "manual",
          });
          return route.fulfill({ status: answer.status, headers: { "content-type": answer.headers.get("content-type") ?? "application/json" }, body: Buffer.from(await answer.arrayBuffer()) });
        } catch (error) {
          return route.fulfill({ status: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: ("QA_API_UNREACHABLE_" + String(error?.code ?? error?.message ?? "")).replace(/[^A-Z0-9_]/gi, "_").slice(0, 60) } }) });
        }
      }
      if (url.origin !== origin && url.pathname.startsWith("/v1/projects/") && foreignApiHosts.length < 5 && !foreignApiHosts.includes(url.host)) foreignApiHosts.push(url.host);
      // While forms are tried, any other write (a framework API route) could change real data, so it is not sent.
      if (formPhase && !["GET", "HEAD"].includes(route.request().method())) return route.abort();
      // A Flutter web app loads its engine and fonts from these hosts, and a site loads Google Fonts from the last two. Blocking
      // them made a working page look broken, and the agent then removed the fonts from the site to "fix" it.
      const flutterEngine = url.protocol === "https:" && ["www.gstatic.com", "fonts.gstatic.com", "fonts.googleapis.com"].includes(url.hostname) && route.request().method() === "GET" && !url.username && !url.password;
      if ((url.origin !== origin && !flutterEngine) || url.username || url.password) return route.abort();
      if(input.actions?.length && !['GET','HEAD'].includes(route.request().method()))return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    await page.routeWebSocket("**/*", socket => {
      if(input.actions?.length){socket.close();return;}
      try {
        const url = new URL(socket.url());
        if (url.origin === origin.replace(/^http:/, "ws:") && !url.username && !url.password) {
          socket.connectToServer();
          return;
        }
      } catch { /* Invalid destinations stay blocked. */ }
      socket.close();
    });
    let consoleErrorCount = 0;
    const consoleDiagnostics = [];
    const capture = (type, message, location, stack) => {
      consoleErrorCount++;
      if (consoleDiagnostics.length < 5) consoleDiagnostics.push(captureBrowserDiagnostic(type, message, location, stack, origin));
    };
    page.on("console", message => { if (!formPhase && message.type() === "error" && !isBlockedExternalResource(message.text(), message.location(), origin)) capture("error", message.text(), message.location()); });
    page.on("requestfailed", request => {
      if (/\/v1\/projects\//.test(request.url()) && apiLog.length < 10)
        apiLog.push(`${request.method()} ${request.url().replace(/^https?:\/\/[^/]+/, "").replace(/\/v1\/projects\/[^/]+/, "").slice(0, 80)} failed ${(request.failure()?.errorText ?? "").slice(0, 40)}`);
    });
    page.on("response", async response => {
      let url;
      try { url = new URL(response.url()); } catch { return; }
      if (url.pathname.startsWith("/v1/projects/") && apiLog.length < 10)
        apiLog.push(`${response.request().method()} ${url.host}${url.pathname.replace(/^\/v1\/projects\/[^/]+/, "").slice(0, 80)} ${response.status()}`);
      // 401 is what a signed-out visitor is meant to get for account pages, so only real refusals and errors count.
      if (!url.pathname.startsWith("/v1/projects/") || response.status() < 400 || response.status() === 401 || apiFailures.length >= 10) return;
      // Recorded before the body is read: the report may be written while the body is still arriving.
      const failure = { method: response.request().method(), path: url.pathname.replace(/^\/v1\/projects\/[^/]+/, "").slice(0, 120), status: response.status(), code: "", duringForms: formPhase };
      apiFailures.push(failure);
      pendingBodies.push(response.json().then(body => { failure.code = String(body?.error?.code ?? "").slice(0, 60); }).catch(() => undefined));
    });
    page.on("pageerror", error => capture("pageerror", error.message, undefined, error.stack));
    const started = Date.now();
    stage = "navigation";
    const response = await page.goto(origin + path, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(3000, Math.max(500, timeoutMs - (Date.now() - started))) }).catch(() => undefined);
    const loadTimeMs = Date.now() - started;
    const interactionTrace = await runBrowserQaActions(page,input.actions);
    stage = "forms";
    let formsSubmitted = 0;
    if (apiBridge) {
      formPhase = true;
      const forms = await page.locator("form:visible").all();
      for (const form of forms.slice(0, 3)) {
        // Sign-up and sign-in forms are left alone: an account is not something a check should create or use.
        if (await form.locator("input[type=password]").count()) continue;
        // Consent boxes are often drawn by CSS over a hidden input, so every checkbox is ticked, visible or not.
        await form.evaluate(element => {
          for (const box of element.querySelectorAll("input[type=checkbox]")) {
            if (box.checked) continue;
            box.checked = true;
            box.dispatchEvent(new Event("input", { bubbles: true }));
            box.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }).catch(() => undefined);
        for (const field of await form.locator("input:visible, textarea:visible, select:visible").all()) {
          const tag = await field.evaluate(element => element.tagName.toLowerCase()).catch(() => "");
          const type = (await field.getAttribute("type") ?? "text").toLowerCase();
          if (["hidden", "submit", "button", "reset", "file", "image"].includes(type)) continue;
          if (tag === "select") { await field.evaluate(element => { if (element.options.length) element.selectedIndex = element.options.length - 1; element.dispatchEvent(new Event("change", { bubbles: true })); }).catch(() => undefined); continue; }
          if (type === "checkbox" || type === "radio") { await field.check({ timeout: 1000 }).catch(() => undefined); continue; }
          const value = type === "email" ? "qa-check@example.com" : type === "tel" ? "+380501234567" : type === "number" ? "2"
            : type === "date" ? "2030-01-15" : type === "time" ? "12:00" : type === "url" ? "https://example.com" : tag === "textarea" ? "Browser QA test message" : "QA test";
          await field.fill(value, { timeout: 1000 }).catch(() => undefined);
        }
        await form.evaluate(element => element.requestSubmit()).catch(() => undefined);
        formsSubmitted++;
        await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
        await page.waitForTimeout(800);
      }
      formPhase = false;
    }
    await Promise.race([Promise.all(pendingBodies), new Promise(resolve => setTimeout(resolve, 1500))]);
    stage = "inspection";
    const observations = await page.evaluate(() => {
      const violations = [];
      const add = (rule, impact, selector) => {
        if (violations.length < 100) violations.push({ rule, impact, selector });
      };
      if (!document.title.trim()) add("document-title", "serious", "head > title");
      if (!document.documentElement.lang) add("html-has-lang", "moderate", "html");
      document.querySelectorAll("img").forEach((el, i) => {
        if (!el.hasAttribute("alt")) add("image-alt", "critical", `img:nth-of-type(${i + 1})`);
      });
      document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button])").forEach((el, i) => {
        if (!el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") &&
            !(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) && !el.closest("label"))
          add("label", "serious", `input:nth-of-type(${i + 1})`);
      });
      document.querySelectorAll("button").forEach((el, i) => {
        if (!el.textContent?.trim() && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby"))
          add("button-name", "critical", `button:nth-of-type(${i + 1})`);
      });
      const seen = new Set();
      document.querySelectorAll("[id]").forEach(el => {
        if (seen.has(el.id)) add("duplicate-id", "moderate", "[id]");
        seen.add(el.id);
      });
      const links = [...document.querySelectorAll("a[href]")].slice(0, 100).map(el => el.getAttribute("href"));
      // An element the page hides with the hidden attribute that a CSS display rule shows anyway (a guest seeing "Sign out").
      const hiddenShown = [...document.querySelectorAll("body [hidden]")].filter(el => getComputedStyle(el).display !== "none" && el.getClientRects().length > 0)
        .slice(0, 5).map(el => el.tagName.toLowerCase() + (el.id ? "#" + el.id : el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : ""));
      const navigation = performance.getEntriesByType("navigation")[0];
      return {
        violations, links, hiddenShown,
        domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? 0,
        resourceCount: performance.getEntriesByType("resource").length,
        totalSizeBytes: new TextEncoder().encode(document.documentElement.outerHTML).length,
      };
    });
    stage = "links";
    const brokenLinks = [];
    for (const href of observations.links.slice(0, maxBrokenLinks)) {
      if (!href || href === "#") { brokenLinks.push({ href: "(empty)", error: "Placeholder link" }); continue; }
      let link;
      try { link = new URL(href, origin + path); } catch { continue; }
      if (link.origin !== origin || !["http:", "https:"].includes(link.protocol)) continue;
      try {
        const result = await context.request.get(link.href, { timeout: Math.min(2500, timeoutMs), maxRedirects: 0 });
        if (result.status() >= 400) brokenLinks.push({ href: link.pathname.slice(0, 200), status: result.status() });
      } catch { brokenLinks.push({ href: link.pathname.slice(0, 200), error: "Local link request failed" }); }
    }
    let captured;
    stage = "screenshot";
    if (screenshot && screenshotMode === "visual") {
      // Explicit reference-review mode captures the real render; default QA remains layout-only.
      // Mask user-entered values and regions explicitly marked private without replacing the design.
      const bytes = await page.screenshot({ type: "png", fullPage: false, animations: "disabled", caret: "hide",
        mask: [page.locator('input,textarea,[contenteditable],[data-private],[data-sensitive],iframe')],
        timeout: Math.min(5000, timeoutMs) });
      if (bytes.length <= maxScreenshotBytes) captured = { mimeType: "image/png", base64Data: bytes.toString("base64"), sizeBytes: bytes.length, redacted: true, captureMode: "visual" };
    } else if (screenshot) {
      const boxes = await page.evaluate(({ width, height }) => {
        const tags = "header,nav,main,section,article,aside,footer,h1,h2,h3,p,button,a,input,textarea,img,svg,canvas,video";
        return [...document.querySelectorAll(tags)].slice(0, 500).flatMap(element => {
          const rect = element.getBoundingClientRect();
          if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || rect.width < 2 || rect.height < 2 ||
              rect.right < 0 || rect.bottom < 0 || rect.x > width || rect.y > height) return [];
          const kind = ["header", "nav", "footer"].includes(element.tagName.toLowerCase()) ? 0 :
            ["button", "a", "input", "textarea"].includes(element.tagName.toLowerCase()) ? 1 :
            ["img", "svg", "canvas", "video"].includes(element.tagName.toLowerCase()) ? 2 : 3;
          return [{ x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)),
            width: Math.min(width, Math.round(rect.width)), height: Math.min(height, Math.round(rect.height)), kind }];
        });
      }, viewport);
      const palette = ["#dbeafe", "#bfdbfe", "#e2e8f0", "#f1f5f9"];
      const rectangles = boxes.map(box => `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${palette[box.kind]}" stroke="#cbd5e1" stroke-width="1"/>`).join("");
      const layoutPage = await context.newPage();
      await layoutPage.setContent(`<html><body style="margin:0;background:#fff"><svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}">${rectangles}</svg></body></html>`);
      const bytes = await layoutPage.screenshot({ type: "png", fullPage: false, timeout: Math.min(5000, timeoutMs) });
      await layoutPage.close();
      if (bytes.length <= maxScreenshotBytes) captured = { mimeType: "image/png", base64Data: bytes.toString("base64"), sizeBytes: bytes.length, redacted: true, captureMode: "layout" };
    }    process.stdout.write(JSON.stringify({
      statusCode: response?.status() ?? 0, loadTimeMs, domContentLoadedMs: Math.round(observations.domContentLoadedMs),
      resourceCount: observations.resourceCount, totalSizeBytes: observations.totalSizeBytes,
      consoleErrorCount: Math.min(consoleErrorCount, 100), consoleDiagnostics, brokenLinks, accessibility: observations.violations, interactionTrace,
      apiFailures, formsSubmitted, apiCalls, apiBridge, apiLog, foreignApiHosts, hiddenShown: observations.hiddenShown,
      screenshot: captured,
    }));
    await context.close();
  } finally { await browser.close(); }
} catch (error) {
  fail(error?.message === "invalid_input" ? "invalid_input" : "browser_qa_failed");
}
