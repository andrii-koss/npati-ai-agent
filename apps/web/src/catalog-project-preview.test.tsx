// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { WebsiteProjectCard } from "./website-builder-card";
import { websiteBuilderCopy } from "./website-builder-constants";
import type { ProductionStatus } from "./code-workspace/project-production";
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => "thumbnail-test", getStoredAuthUser: () => ({ id: "thumbnail-test" }) }));
describe("catalog Preview actions", () => {
  it("reads the screenshot and production status without starting Preview", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/qa/thumbnail")) return Response.json({ thumbnail: null });
      if (url.endsWith("/production")) return Response.json({ enabled: false });
      if (url.endsWith("/status")) return Response.json({ isRunning: false });
      return Response.json({ token: "scoped-token" });
    });
    vi.stubGlobal("fetch", fetch);
    const replace = vi.fn(); const popup = { opener: {}, document: { body: { textContent: "" } }, location: { replace } };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(<MemoryRouter><WebsiteProjectCard site={{ id: "p", companyId: "c", name: "Site", type: "website", status: "ready", revision: 1, updatedAt: "2026-10-29" }} companyId="c" language="en" t={websiteBuilderCopy.en} handleDelete={() => {}} handleDuplicate={() => {}} handleRename={() => {}} /></MemoryRouter>));
      expect(fetch.mock.calls.map(call => call[0]).sort()).toEqual([
        "/api/companies/c/projects/p/production",
        "/api/companies/c/projects/p/qa/thumbnail",
      ]);
      expect(host.querySelector("iframe")).toBeNull();
      const button = host.querySelector<HTMLButtonElement>('button[aria-label="Open Live Preview"]')!;
      expect(host.querySelectorAll('button[aria-label="Open Live Preview"]')).toHaveLength(1);
      expect(host.querySelector('.website-preview-viewport')?.textContent).not.toContain("Open Live Preview");
      await act(async () => button.click());
      expect(replace).toHaveBeenCalledWith("/api/companies/c/projects/p/preview/proxy/?token=scoped-token");
      expect(fetch.mock.calls.some(([url]) => url.endsWith("/preview/start"))).toBe(true);
      expect(popup.opener).toBeNull();
      const thumbnailLink = host.querySelector<HTMLAnchorElement>('.website-preview-viewport a')!;
      await act(async () => thumbnailLink.click());
      expect(replace).toHaveBeenCalledTimes(2);
      expect(host.querySelectorAll('button[aria-label="Open Live Preview"]')).toHaveLength(1);
    } finally { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });

  it("retains the confirmed production indicator during the settings handoff", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const site = { id: "status", companyId: "c", name: "Site", type: "website", status: "ready", revision: 1, updatedAt: "2026-10-29", hasThumbnail: false } as const;
    const limits = { cpu: 1, memoryMiB: 512, requestsPerSecond: 20, concurrency: 5, bodyMiB: 1, timeoutSeconds: 10 };
    const production: Extract<ProductionStatus, { enabled: true }> = {
      enabled: true, automaticDomain: "site.localhost", localEnabled: true, tlsEnabled: false, defaults: limits,
      release: {
        kind: "static", createdAt: site.updatedAt, url: "http://site.localhost/", certificate: "disabled", runtime: "running",
        settings: { domain: "site.localhost", path: "/", port: 3000, stripPath: false, tls: false, entrypoint: "auto", limits },
      },
      job: null, logs: [], activity: [], traffic: { requests: 0, errors: 0, limited: 0, averageMs: 0 },
    };
    const reads: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { reads.push(resolve); })));
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = (status?: ProductionStatus | null) => act(async () => root.render(
      <MemoryRouter><WebsiteProjectCard site={site} companyId={site.companyId} language="en" t={websiteBuilderCopy.en}
        drawerProductionStatus={status} handleDelete={() => {}} handleDuplicate={() => {}} handleRename={() => {}} /></MemoryRouter>,
    ));
    const indicator = () => host.querySelector(".website-card-production-dot");
    try {
      await render();
      await act(async () => reads[0]!(Response.json(production)));
      const initial = indicator();
      expect(initial?.getAttribute("data-healthy")).toBe("true");
      await render(null);
      expect(indicator()).toBe(initial);
      await render(production);
      await render();
      expect(indicator()).toBe(initial);
      await act(async () => reads[1]!(Response.json(production)));
      expect(indicator()).toBe(initial);
      await render({ ...production, release: null });
      expect(indicator()).toBeNull();
      await render();
      expect(indicator()).toBeNull();
      await act(async () => reads[2]!(Response.json({ ...production, release: null })));
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
