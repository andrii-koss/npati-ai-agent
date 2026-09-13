import { describe, expect, it } from "vitest";
import { ManagedBrowserProfileService } from "../apps/agent-api/src/multimodal-bridge-and-browser";
import {
  BrowserTabController,
  BrowserClickTypeEngine,
  BrowserDragSelectEngine,
} from "../apps/agent-api/src/browser-automation-controller";
import {
  BrowserDomSnapshotEngine,
  BrowserScreenshotEngine,
  BrowserPdfCaptureEngine,
} from "../apps/agent-api/src/browser-visual-and-dom-capture";
import {
  BrowserDownloadManager,
  MultiProfileBrowserManager,
  RealChromeCdpAttacher,
} from "../apps/agent-api/src/browser-advanced-integrations";
import { BrowserSecurityGuard } from "../apps/agent-api/src/browser-security-guard";

describe("Browser automation scaffold and guardrail contracts (not production certification)", () => {
  // 1. #149 Managed Browser Profile
  describe("#149 Managed Browser Profile (browser.managed_browser_profile)", () => {
    it("creates isolated profiles with encrypted cookies, viewport, and cleanup", () => {
      const service = new ManagedBrowserProfileService();

      const profile = service.createProfile({
        companyId: "comp-enterprise-1",
        profileName: "Finance Audit Browser",
        userAgent: "NPATI-Headless-Audit/1.0",
        viewport: { width: 1920, height: 1080 },
        proxyUrl: "http://proxy.internal:8080",
      });

      expect(profile.profileId).toBeDefined();
      expect(profile.companyId).toBe("comp-enterprise-1");
      expect(profile.userAgent).toBe("NPATI-Headless-Audit/1.0");
      expect(profile.viewport).toEqual({ width: 1920, height: 1080 });
      expect(profile.proxyUrl).toBe("http://proxy.internal:8080");

      const saved = service.saveCookies(profile.profileId, [
        { name: "session_id", value: "sec_token_987", domain: "npati.ai" },
      ]);
      expect(saved).toBe(true);

      const retrieved = service.getProfile(profile.profileId);
      expect(retrieved?.cookies.length).toBe(1);
      expect(retrieved?.cookies[0]?.name).toBe("session_id");

      const destroyed = service.destroyProfile(profile.profileId);
      expect(destroyed).toBe(true);
      expect(service.getProfile(profile.profileId)).toBeNull();
    });
  });

  // 2. #150 Browser Tab Control
  describe("#150 Browser Tab Control (browser.browser_tab_control)", () => {
    it("manages tab lifecycle: open, navigate, switch, history tracking, and close", () => {
      const controller = new BrowserTabController();

      const tab1 = controller.openTab("https://npati.ai", "NPATI AI Home");
      expect(tab1.isActive).toBe(true);
      expect(controller.getActiveTab()?.tabId).toBe(tab1.tabId);

      const tab2 = controller.openTab("https://docs.npati.ai", "Docs");
      expect(tab2.isActive).toBe(true);
      expect(controller.getActiveTab()?.tabId).toBe(tab2.tabId);
      expect(controller.listTabs().length).toBe(2);

      // Switch tab
      const switched = controller.switchTab(tab1.tabId);
      expect(switched).toBe(true);
      expect(controller.getActiveTab()?.tabId).toBe(tab1.tabId);

      // Navigate
      const navigated = controller.navigateTab(tab1.tabId, "https://npati.ai/dashboard", "Dashboard");
      expect(navigated).toBe(true);
      expect(controller.getActiveTab()?.url).toBe("https://npati.ai/dashboard");
      expect(controller.getActiveTab()?.history).toEqual(["https://npati.ai", "https://npati.ai/dashboard"]);

      // Close tab
      const closed = controller.closeTab(tab1.tabId);
      expect(closed).toBe(true);
      expect(controller.listTabs().length).toBe(1);
      expect(controller.getActiveTab()?.tabId).toBe(tab2.tabId);
    });
  });

  // 3. #151 Browser Click/Type
  describe("#151 Browser Click/Type (browser.browser_clicktype)", () => {
    it("interacts with buttons, input fields, and form submissions", () => {
      const controller = new BrowserTabController();
      const tab = controller.openTab("https://portal.npati.ai/login");

      const clickRes = BrowserClickTypeEngine.click(tab, "button#submit-btn", { button: "left", clickCount: 1 });
      expect(clickRes.success).toBe(true);
      expect(clickRes.action).toBe("click");
      expect(clickRes.selector).toBe("button#submit-btn");

      const typeRes = BrowserClickTypeEngine.type(tab, "input[name='api_key']", "sk-secret-key-value", { clearFirst: true });
      expect(typeRes.success).toBe(true);
      expect(typeRes.action).toBe("type");
      expect(typeRes.details?.typedText).toBe("sk-secret-key-value");
      expect(typeRes.details?.charactersCount).toBe(19);

      const submitRes = BrowserClickTypeEngine.submit(tab, "form#login-form");
      expect(submitRes.success).toBe(true);
      expect(submitRes.action).toBe("submit");
      expect(submitRes.selector).toBe("form#login-form");
    });
  });

  // 4. #152 Browser Drag/Select
  describe("#152 Browser Drag/Select (browser.browser_dragselect)", () => {
    it("executes drag and drop, select dropdown option, and scroll gestures", () => {
      const controller = new BrowserTabController();
      const tab = controller.openTab("https://npati.ai/canvas");

      const dragRes = BrowserDragSelectEngine.dragAndDrop(tab, "#node-a", "#node-b");
      expect(dragRes.success).toBe(true);
      expect(dragRes.action).toBe("drag_and_drop");
      expect(dragRes.details?.source).toBe("#node-a");
      expect(dragRes.details?.target).toBe("#node-b");

      const selectRes = BrowserDragSelectEngine.selectOption(tab, "select#region-selector", "eu-central-1");
      expect(selectRes.success).toBe(true);
      expect(selectRes.action).toBe("select_option");
      expect(selectRes.details?.selectedOption).toBe("eu-central-1");

      const scrollRes = BrowserDragSelectEngine.scroll(tab, { x: 0, y: 500, toSelector: "#audit-table" });
      expect(scrollRes.success).toBe(true);
      expect(scrollRes.action).toBe("scroll");
      expect(scrollRes.details?.scrollOffset).toEqual({ x: 0, y: 500 });
    });
  });

  // 5. #153 Browser Snapshots
  describe("#153 Browser Snapshots (browser.browser_snapshots)", () => {
    it("extracts token-optimized accessibility tree and cleans scripts/styles", () => {
      const rawHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <style>body { font-size: 14px; }</style>
            <script>console.log("tracking");</script>
          </head>
          <body>
            <header>
              <svg><path d="M10 10" /></svg>
              <h1>Company Console</h1>
            </header>
            <main>
              <form id="billing-form">
                <input id="org-name" type="text" value="Acme Corp" />
                <button id="save-btn" type="submit">Save Changes</button>
              </form>
              <a id="support-link" href="/support">Get Help</a>
            </main>
          </body>
        </html>
      `;

      const snapshot = BrowserDomSnapshotEngine.captureSnapshot(rawHtml, { pruneScripts: true });

      expect(snapshot.interactiveCount).toBe(3);
      expect(snapshot.cleanTree).not.toContain("<script>");
      expect(snapshot.cleanTree).not.toContain("<style>");
      expect(snapshot.cleanTree).not.toContain("<svg>");
      expect(snapshot.cleanTree).toContain("[org-name] <input>");
      expect(snapshot.cleanTree).toContain("[save-btn] <button>");
      expect(snapshot.cleanTree).toContain("[support-link] <a>");
      expect(snapshot.estimatedTokens).toBeGreaterThan(0);
    });
  });

  // 6. #154 Browser Screenshots
  describe("#154 Browser Screenshots (browser.browser_screenshots)", () => {
    it("captures viewport and full-page visual renderings as base64 images", () => {
      const viewportShot = BrowserScreenshotEngine.capture("tab-123", { fullPage: false, format: "png" });
      expect(viewportShot.screenshotId).toBeDefined();
      expect(viewportShot.mimeType).toBe("image/png");
      expect(viewportShot.dimensions).toEqual({ width: 1280, height: 800 });
      expect(viewportShot.base64Data.length).toBeGreaterThan(0);

      const fullPageShot = BrowserScreenshotEngine.capture("tab-123", { fullPage: true, format: "jpeg" });
      expect(fullPageShot.mimeType).toBe("image/jpeg");
      expect(fullPageShot.dimensions).toEqual({ width: 1280, height: 2400 });
    });
  });

  // 7. #155 Browser PDF Capture
  describe("#155 Browser PDF Capture (browser.browser_pdf_capture)", () => {
    it("returns the current PDF descriptor scaffold", () => {
      const pdf = BrowserPdfCaptureEngine.capturePdf("tab-456", { landscape: true, printBackground: true });
      expect(pdf.pdfId).toBeDefined();
      expect(pdf.pageCount).toBe(2);
      expect(pdf.fileSizeBytes).toBeGreaterThan(0);

      const decoded = Buffer.from(pdf.pdfBase64, "base64").toString("utf-8");
      expect(decoded).toContain("%PDF-1.4");
      expect(decoded).toContain("/Landscape true");
    });
  });

  // 8. #156 Browser Downloads
  describe("#156 Browser Downloads (browser.browser_downloads)", () => {
    it("tracks download progress, status transitions, and listing", () => {
      const manager = new BrowserDownloadManager();

      const item = manager.startDownload({
        tabId: "tab-dl-1",
        url: "https://npati.ai/reports/q3-audit.pdf",
        filename: "q3-audit.pdf",
        totalBytes: 5242880,
      });

      expect(item.downloadId).toBeDefined();
      expect(item.status).toBe("downloading");
      expect(item.filename).toBe("q3-audit.pdf");
      expect(item.totalBytes).toBe(5242880);

      const completed = manager.completeDownload(item.downloadId, 5242880);
      expect(completed).toBe(true);

      const record = manager.getDownload(item.downloadId);
      expect(record?.status).toBe("completed");
      expect(record?.completedAt).toBeDefined();

      const list = manager.listDownloads("tab-dl-1");
      expect(list.length).toBe(1);
      expect(list[0]?.filename).toBe("q3-audit.pdf");
    });
  });

  // 9. #157 Multi-Profile Browser
  describe("#157 Multi-Profile Browser (browser.multi-profile_browser)", () => {
    it("provisions and manages concurrent isolated browser instances", () => {
      const manager = new MultiProfileBrowserManager();

      const inst1 = manager.provisionInstance({
        profileId: "prof-ops",
        proxy: "http://squid.corp:3128",
        incognito: false,
      });
      expect(inst1.instanceId).toBeDefined();
      expect(inst1.profileId).toBe("prof-ops");
      expect(inst1.proxy).toBe("http://squid.corp:3128");

      const inst2 = manager.provisionInstance({
        profileId: "prof-finance",
        incognito: true,
      });
      expect(inst2.instanceId).toBeDefined();
      expect(inst2.incognito).toBe(true);

      expect(manager.listActiveInstances().length).toBe(2);

      const released = manager.releaseInstance(inst1.instanceId);
      expect(released).toBe(true);
      expect(manager.listActiveInstances().length).toBe(1);
    });
  });

  // 10. #158 Attach Real Chrome
  describe("#158 Attach Real Chrome (browser.attach_real_chrome)", () => {
    it("connects to CDP debugging port and discovers pages, rejecting unreachable ports", async () => {
      // Successful connection
      const cdp = await RealChromeCdpAttacher.attachToChrome("127.0.0.1", 9222, async () => true);
      expect(cdp.connected).toBe(true);
      expect(cdp.browserVersion).toContain("Chrome");
      expect(cdp.webSocketDebuggerUrl).toContain("ws://127.0.0.1:9222/devtools");
      expect(cdp.activePagesCount).toBe(3);

      // Connection failure
      await expect(
        RealChromeCdpAttacher.attachToChrome("127.0.0.1", 9223, async () => false)
      ).rejects.toThrow(/CDP_CONNECTION_FAILED/);
    });
  });

  // 11. Security Guardrails: SSRF, Quarantine & Dangerous Action Protection
  describe("Security Guardrails & Enterprise Policies", () => {
    it("blocks SSRF attacks to internal networks, cloud metadata, and dangerous protocols", () => {
      // Safe URLs
      expect(BrowserSecurityGuard.validateUrl("https://example.com").allowed).toBe(true);
      expect(BrowserSecurityGuard.validateUrl("https://api.github.com/repos").allowed).toBe(true);

      // Dangerous protocols
      expect(BrowserSecurityGuard.validateUrl("file:///etc/passwd").allowed).toBe(false);
      expect(BrowserSecurityGuard.validateUrl("javascript:alert(1)").allowed).toBe(false);
      expect(BrowserSecurityGuard.validateUrl("data:text/html,<h1>Hack</h1>").allowed).toBe(false);

      // Private IPs
      expect(BrowserSecurityGuard.validateUrl("http://127.0.0.1/admin").allowed).toBe(false);
      expect(BrowserSecurityGuard.validateUrl("http://10.0.1.5:8080").allowed).toBe(false);
      expect(BrowserSecurityGuard.validateUrl("http://172.18.0.2:3000").allowed).toBe(false);
      expect(BrowserSecurityGuard.validateUrl("http://192.168.1.1").allowed).toBe(false);

      // Cloud Metadata
      expect(BrowserSecurityGuard.validateUrl("http://169.254.169.254/latest/meta-data/").allowed).toBe(false);
      expect(BrowserSecurityGuard.validateUrl("http://metadata.google.internal/computeMetadata/v1/").allowed).toBe(false);

      // Internal Docker Hostnames
      expect(BrowserSecurityGuard.validateUrl("http://postgres:5432").allowed).toBe(false);
      expect(BrowserSecurityGuard.validateUrl("http://redis:6379").allowed).toBe(false);
      expect(BrowserSecurityGuard.validateUrl("http://omniroute:20128").allowed).toBe(false);
    });

    it("quarantines dangerous executable and script downloads", () => {
      const exe = BrowserSecurityGuard.validateDownload("invoice_viewer.exe");
      expect(exe.quarantined).toBe(true);
      expect(exe.reason).toContain(".exe");

      const script = BrowserSecurityGuard.validateDownload("install.sh");
      expect(script.quarantined).toBe(true);

      const batch = BrowserSecurityGuard.validateDownload("payload.bat");
      expect(batch.quarantined).toBe(true);

      const safePdf = BrowserSecurityGuard.validateDownload("annual_report.pdf");
      expect(safePdf.quarantined).toBe(false);

      const safePng = BrowserSecurityGuard.validateDownload("logo.png");
      expect(safePng.quarantined).toBe(false);
    });

    it("flags high-risk destructive actions requiring approval", () => {
      const deleteClick = BrowserSecurityGuard.checkActionRisk("click", "button#delete-workspace");
      expect(deleteClick.highRisk).toBe(true);
      expect(deleteClick.requiresApproval).toBe(true);

      const paySubmit = BrowserSecurityGuard.checkActionRisk("submit", "form#checkout-payment");
      expect(paySubmit.highRisk).toBe(true);
      expect(paySubmit.requiresApproval).toBe(true);

      const benignClick = BrowserSecurityGuard.checkActionRisk("click", "a#view-docs");
      expect(benignClick.highRisk).toBe(false);
      expect(benignClick.requiresApproval).toBe(false);
    });
  });
});
