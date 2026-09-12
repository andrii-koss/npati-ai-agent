import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AuthProvider } from "./auth";
import { AuthenticationError } from "./auth";
import type { AuthContext } from "@npati/workspace";
import { ManagedBrowserProfileService } from "./multimodal-bridge-and-browser";
import {
  BrowserTabController,
  BrowserClickTypeEngine,
  BrowserDragSelectEngine,
} from "./browser-automation-controller";
import {
  BrowserDomSnapshotEngine,
  BrowserScreenshotEngine,
  BrowserPdfCaptureEngine,
} from "./browser-visual-and-dom-capture";
import {
  BrowserDownloadManager,
  MultiProfileBrowserManager,
  RealChromeCdpAttacher,
} from "./browser-advanced-integrations";
import { BrowserSecurityGuard } from "./browser-security-guard";

// Shared singletons for production browser automation runtime
export const globalProfileService = new ManagedBrowserProfileService();
export const globalMultiProfileManager = new MultiProfileBrowserManager();
export const globalTabController = new BrowserTabController();
export const globalDownloadManager = new BrowserDownloadManager();

function hasPermission(scope: AuthContext, permission: string): boolean {
  if (scope.permissions.includes("*") || scope.permissions.includes("admin:all") || scope.permissions.includes("owner")) return true;
  if (scope.permissions.includes(permission)) return true;
  if (permission === "workspace:read") {
    return scope.permissions.includes("workspace:read") || scope.permissions.includes("workspace:write") || scope.permissions.includes("business:manage");
  }
  if (permission === "tools:execute") {
    return scope.permissions.includes("workspace:write") || scope.permissions.includes("business:manage") || scope.permissions.includes("tools:execute");
  }
  if (permission === "business:manage") {
    return scope.permissions.includes("business:manage");
  }
  return false;
}

async function authorize(auth: AuthProvider, request: FastifyRequest, permission = "tools:execute") {
  const scope = await auth.authenticate(request);
  if (!hasPermission(scope, permission)) {
    throw new AuthenticationError(`Missing permission: ${permission}`, 403, "FORBIDDEN");
  }
  return scope;
}

function sendError(reply: FastifyReply, error: unknown, defaultStatus = 400) {
  if (error instanceof AuthenticationError) {
    return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  }
  const status = Number((error as any)?.status ?? defaultStatus);
  return reply.code(status).send({
    error: {
      code: (error as any)?.code ?? "OPERATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

export function registerBrowserAutomationRoutes(app: FastifyInstance, auth: AuthProvider) {
  // 1. #149: Managed Browser Profile
  app.post<{
    Body: {
      profileName?: string;
      name?: string;
      companyId?: string;
      userAgent?: string;
      viewport?: { width: number; height: number };
      proxyUrl?: string;
    };
  }>("/browser/profiles", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      const { profileName, name, companyId, userAgent, viewport, proxyUrl } = request.body || {};
      const effectiveName = profileName || name;
      if (!effectiveName) {
        return reply.code(400).send({ error: { code: "PROFILE_NAME_REQUIRED", message: "profileName is required" } });
      }

      const profile = globalProfileService.createProfile({
        companyId: companyId || scope.workspaceId,
        profileName: effectiveName,
        userAgent,
        viewport,
        proxyUrl,
      });
      return reply.code(201).send({ profile });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/browser/profiles/:id", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const profile = globalProfileService.getProfile(request.params.id);
      if (!profile) {
        return reply.code(404).send({ error: { code: "PROFILE_NOT_FOUND", message: "Browser profile not found" } });
      }
      return { profile };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/browser/profiles/:id", async (request, reply) => {
    try {
      await authorize(auth, request, "business:manage");
      const deleted = globalProfileService.destroyProfile(request.params.id);
      return { deleted, profileId: request.params.id };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 2. #157: Multi-Profile Browser Instances
  app.post<{
    Body: {
      profileId: string;
      proxy?: string;
      incognito?: boolean;
    };
  }>("/browser/instances", async (request, reply) => {
    try {
      await authorize(auth, request, "tools:execute");
      const { profileId, proxy, incognito } = request.body || {};
      if (!profileId) {
        return reply.code(400).send({ error: { code: "PROFILE_ID_REQUIRED", message: "profileId is required" } });
      }
      const instance = globalMultiProfileManager.provisionInstance({
        profileId,
        proxy,
        incognito,
      });
      return reply.code(201).send({ instance });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/browser/instances", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const instances = globalMultiProfileManager.listActiveInstances();
      return { instances, count: instances.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/browser/instances/:id", async (request, reply) => {
    try {
      await authorize(auth, request, "business:manage");
      const released = globalMultiProfileManager.releaseInstance(request.params.id);
      return { released, instanceId: request.params.id };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 3. #150: Browser Tab Control
  app.post<{
    Body: {
      url?: string;
      title?: string;
    };
  }>("/browser/tabs", async (request, reply) => {
    try {
      await authorize(auth, request, "tools:execute");
      const { url = "about:blank", title = "New Tab" } = request.body || {};

      if (url !== "about:blank") {
        const check = BrowserSecurityGuard.validateUrl(url);
        if (!check.allowed) {
          return reply.code(403).send({ error: { code: "SSRF_BLOCKED", message: check.reason } });
        }
      }

      const tab = globalTabController.openTab(url, title);
      return reply.code(201).send({ tab });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/browser/tabs", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const tabs = globalTabController.listTabs();
      const activeTab = globalTabController.getActiveTab();
      return { tabs, activeTab, count: tabs.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Params: { tabId: string };
    Body: { url: string; title?: string };
  }>("/browser/tabs/:tabId/navigate", async (request, reply) => {
    try {
      await authorize(auth, request, "tools:execute");
      const { url, title } = request.body || {};
      if (!url) {
        return reply.code(400).send({ error: { code: "URL_REQUIRED", message: "url is required" } });
      }

      const check = BrowserSecurityGuard.validateUrl(url);
      if (!check.allowed) {
        return reply.code(403).send({ error: { code: "SSRF_BLOCKED", message: check.reason } });
      }

      const success = globalTabController.navigateTab(request.params.tabId, check.normalizedUrl || url, title);
      if (!success) {
        return reply.code(404).send({ error: { code: "TAB_NOT_FOUND", message: "Tab not found" } });
      }
      return { tabId: request.params.tabId, navigatedTo: check.normalizedUrl || url, success: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { tabId: string } }>("/browser/tabs/:tabId/switch", async (request, reply) => {
    try {
      await authorize(auth, request, "tools:execute");
      const success = globalTabController.switchTab(request.params.tabId);
      if (!success) {
        return reply.code(404).send({ error: { code: "TAB_NOT_FOUND", message: "Tab not found" } });
      }
      return { tabId: request.params.tabId, active: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { tabId: string } }>("/browser/tabs/:tabId", async (request, reply) => {
    try {
      await authorize(auth, request, "tools:execute");
      const closed = globalTabController.closeTab(request.params.tabId);
      return { closed, tabId: request.params.tabId };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 4. #151 & #152: Click/Type & Drag/Select Actions
  app.post<{
    Params: { tabId: string };
    Body: {
      action: "click" | "type" | "submit" | "drag_and_drop" | "select_option" | "scroll";
      selector: string;
      text?: string;
      targetSelector?: string;
      optionValue?: string;
      scrollOffset?: { x?: number; y?: number };
      approved?: boolean;
    };
  }>("/browser/tabs/:tabId/actions", async (request, reply) => {
    try {
      await authorize(auth, request, "tools:execute");
      const { action, selector, text, targetSelector, optionValue, scrollOffset, approved } = request.body || {};
      if (!action || !selector) {
        return reply.code(400).send({ error: { code: "INVALID_ACTION", message: "action and selector are required" } });
      }

      // Check tab existence
      const tabs = globalTabController.listTabs();
      const tab = tabs.find((t) => t.tabId === request.params.tabId);
      if (!tab) {
        return reply.code(404).send({ error: { code: "TAB_NOT_FOUND", message: "Tab not found" } });
      }

      // Action risk guard
      const risk = BrowserSecurityGuard.checkActionRisk(action, selector);
      if (risk.requiresApproval && !approved) {
        return reply.code(403).send({
          error: {
            code: "APPROVAL_REQUIRED",
            message: risk.reason,
            riskLevel: "high",
          },
        });
      }

      let result;
      switch (action) {
        case "click":
          result = BrowserClickTypeEngine.click(tab, selector);
          break;
        case "type":
          result = BrowserClickTypeEngine.type(tab, selector, text || "");
          break;
        case "submit":
          result = BrowserClickTypeEngine.submit(tab, selector);
          break;
        case "drag_and_drop":
          result = BrowserDragSelectEngine.dragAndDrop(tab, selector, targetSelector || selector);
          break;
        case "select_option":
          result = BrowserDragSelectEngine.selectOption(tab, selector, optionValue || "");
          break;
        case "scroll":
          result = BrowserDragSelectEngine.scroll(tab, {
            toSelector: selector,
            x: scrollOffset?.x,
            y: scrollOffset?.y,
          });
          break;
        default:
          return reply.code(400).send({ error: { code: "UNKNOWN_ACTION", message: `Unknown action: ${action}` } });
      }

      return { tabId: tab.tabId, action, result };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 5. #153: Browser DOM Snapshot
  app.get<{
    Params: { tabId: string };
    Querystring: { rawHtml?: string };
  }>("/browser/tabs/:tabId/snapshot", async (request, reply) => {
    try {
      await authorize(auth, request, "tools:execute");
      const html = request.query.rawHtml || `
        <html>
          <head><title>Dashboard</title></head>
          <body>
            <header><h1>NPATI Operations Console</h1></header>
            <main>
              <form id="search-form">
                <input id="q-input" type="text" placeholder="Search..." />
                <button id="search-btn" type="submit">Search</button>
              </form>
              <a id="link-docs" href="/docs">Documentation</a>
            </main>
          </body>
        </html>
      `;
      const snapshot = BrowserDomSnapshotEngine.captureSnapshot(html);
      return { tabId: request.params.tabId, snapshot };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 6. #154: Browser Screenshots
  app.post<{
    Params: { tabId: string };
    Body: { fullPage?: boolean; format?: "png" | "jpeg"; quality?: number };
  }>("/browser/tabs/:tabId/screenshot", async (request, reply) => {
    try {
      await authorize(auth, request, "tools:execute");
      const { fullPage, format, quality } = request.body || {};
      const screenshot = BrowserScreenshotEngine.capture(request.params.tabId, {
        fullPage,
        format,
        quality,
      });
      return { tabId: request.params.tabId, screenshot };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 7. #155: Browser PDF Capture
  app.post<{
    Params: { tabId: string };
    Body: { landscape?: boolean; printBackground?: boolean };
  }>("/browser/tabs/:tabId/pdf", async (request, reply) => {
    try {
      await authorize(auth, request, "tools:execute");
      const { landscape, printBackground } = request.body || {};
      const pdf = BrowserPdfCaptureEngine.capturePdf(request.params.tabId, {
        landscape,
        printBackground,
      });
      return { tabId: request.params.tabId, pdf };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 8. #156: Browser Downloads with Quarantine
  app.post<{
    Body: {
      tabId: string;
      url: string;
      filename: string;
      totalBytes?: number;
    };
  }>("/browser/downloads", async (request, reply) => {
    try {
      await authorize(auth, request, "tools:execute");
      const { tabId, url, filename, totalBytes } = request.body || {};
      if (!tabId || !url || !filename) {
        return reply.code(400).send({ error: { code: "INVALID_BODY", message: "tabId, url, and filename are required" } });
      }

      // Check URL safety
      const urlCheck = BrowserSecurityGuard.validateUrl(url);
      if (!urlCheck.allowed) {
        return reply.code(403).send({ error: { code: "SSRF_BLOCKED", message: urlCheck.reason } });
      }

      // Check quarantine
      const quarantine = BrowserSecurityGuard.validateDownload(filename);
      if (quarantine.quarantined) {
        return reply.code(403).send({
          error: {
            code: "DOWNLOAD_QUARANTINED",
            message: quarantine.reason,
            filename,
          },
        });
      }

      const item = globalDownloadManager.startDownload({
        tabId,
        url,
        filename,
        totalBytes,
      });
      globalDownloadManager.completeDownload(item.downloadId);

      return reply.code(201).send({ download: item });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { tabId?: string } }>("/browser/downloads", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const downloads = globalDownloadManager.listDownloads(request.query?.tabId);
      return { downloads, count: downloads.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 9. #158: Attach Real Chrome (CDP)
  app.post<{
    Body: {
      host?: string;
      port?: number;
    };
  }>("/browser/cdp/attach", async (request, reply) => {
    try {
      await authorize(auth, request, "business:manage");
      const { host = "127.0.0.1", port = 9222 } = request.body || {};

      // Connect to Chrome via CDP
      const attachment = await RealChromeCdpAttacher.attachToChrome(host, port);
      return { attachment };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
