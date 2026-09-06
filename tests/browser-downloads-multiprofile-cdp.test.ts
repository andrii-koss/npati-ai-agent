import { describe, expect, it } from "vitest";
import {
  BrowserDownloadManager,
  MultiProfileBrowserManager,
  RealChromeCdpAttacher,
} from "../apps/agent-api/src/browser-advanced-integrations";

describe("Browser Download Manager (BrowserDownloadManager)", () => {
  it("tracks and manages file download lifecycles", () => {
    const manager = new BrowserDownloadManager();

    const download = manager.startDownload({
      tabId: "tab-down-1",
      url: "https://npati.ai/assets/report.pdf",
      filename: "annual_report_2026.pdf",
      totalBytes: 2048000,
    });

    expect(download.downloadId).toMatch(/^dl_/);
    expect(download.status).toBe("downloading");

    manager.completeDownload(download.downloadId, 2048000);
    const completed = manager.getDownload(download.downloadId);
    expect(completed?.status).toBe("completed");
    expect(completed?.receivedBytes).toBe(2048000);
    expect(completed?.completedAt).toBeDefined();

    const tabList = manager.listDownloads("tab-down-1");
    expect(tabList.length).toBe(1);
  });
});

describe("Multi-Profile Browser Manager (MultiProfileBrowserManager)", () => {
  it("provisions and releases concurrent browser instances", () => {
    const manager = new MultiProfileBrowserManager();

    const inst1 = manager.provisionInstance({
      profileId: "prof-scraping-1",
      proxy: "http://proxy.corp:8080",
    });

    const inst2 = manager.provisionInstance({
      profileId: "prof-admin-2",
      incognito: true,
    });

    expect(manager.listActiveInstances().length).toBe(2);
    expect(inst1.proxy).toBe("http://proxy.corp:8080");
    expect(inst2.incognito).toBe(true);

    manager.releaseInstance(inst1.instanceId);
    expect(manager.listActiveInstances().length).toBe(1);
  });
});

describe("Real Chrome CDP Attacher (RealChromeCdpAttacher)", () => {
  it("connects to active Chrome DevTools Protocol port", async () => {
    const res = await RealChromeCdpAttacher.attachToChrome("127.0.0.1", 9222, async () => true);

    expect(res.connected).toBe(true);
    expect(res.browserVersion).toContain("Chrome");
    expect(res.webSocketDebuggerUrl).toContain("ws://127.0.0.1:9222");
    expect(res.activePagesCount).toBe(3);
  });

  it("handles unreachable CDP ports with descriptive error", async () => {
    await expect(
      RealChromeCdpAttacher.attachToChrome("127.0.0.1", 9999, async () => false)
    ).rejects.toThrow("CDP_CONNECTION_FAILED");
  });
});
