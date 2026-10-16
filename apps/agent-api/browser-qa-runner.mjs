import { chromium } from "playwright";

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
  const { host, port, path, viewport, timeoutMs, maxScreenshotBytes, maxBrokenLinks, screenshot } = input;
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
  const origin = `http://${host}:${port}`;
  stage = "launch";
  const browser = await chromium.launch({ headless: true, ...(shared ? { executablePath: "/usr/bin/chromium-browser" } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage", ...(shared ? ["--no-proxy-server"] : [])] });
  try {
    const context = await browser.newContext({ viewport, serviceWorkers: "block", acceptDownloads: false });
    await context.route("**/*", async route => {
      let url;
      try { url = new URL(route.request().url()); } catch { return route.abort(); }
      if (url.origin !== origin || url.username || url.password) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    await page.routeWebSocket("**/*", socket => socket.close());
    let consoleErrorCount = 0;
    page.on("console", message => { if (message.type() === "error") consoleErrorCount++; });
    page.on("pageerror", () => { consoleErrorCount++; });
    const started = Date.now();
    stage = "navigation";
    const response = await page.goto(origin + path, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(3000, Math.max(500, timeoutMs - (Date.now() - started))) }).catch(() => undefined);
    const loadTimeMs = Date.now() - started;
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
      const navigation = performance.getEntriesByType("navigation")[0];
      return {
        violations, links,
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
    if (screenshot) {
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
      if (bytes.length <= maxScreenshotBytes) captured = { mimeType: "image/png", base64Data: bytes.toString("base64"), sizeBytes: bytes.length, redacted: true };
    }    process.stdout.write(JSON.stringify({
      statusCode: response?.status() ?? 0, loadTimeMs, domContentLoadedMs: Math.round(observations.domContentLoadedMs),
      resourceCount: observations.resourceCount, totalSizeBytes: observations.totalSizeBytes,
      consoleErrorCount: Math.min(consoleErrorCount, 100), brokenLinks, accessibility: observations.violations,
      screenshot: captured,
    }));
    await context.close();
  } finally { await browser.close(); }
} catch (error) {
  fail(error?.message === "invalid_input" ? "invalid_input" : "browser_qa_failed");
}