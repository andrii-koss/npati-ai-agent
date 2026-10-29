// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { WebsiteProjectCard } from "./website-builder-card";
import { websiteBuilderCopy } from "./website-builder-constants";
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => "thumbnail-test", getStoredAuthUser: () => ({ id: "thumbnail-test" }) }));
describe("catalog Preview actions", () => {
  it("only loads the saved screenshot until the user explicitly opens Preview", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/qa/thumbnail") ? { thumbnail: null } : url.endsWith("/status") ? { isRunning: false } : { token: "scoped-token" })));
    vi.stubGlobal("fetch", fetch);
    const replace = vi.fn(); const popup = { opener: {}, document: { body: { textContent: "" } }, location: { replace } };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(<MemoryRouter><WebsiteProjectCard site={{ id: "p", companyId: "c", name: "Site", type: "website", status: "ready", revision: 1, updatedAt: "2026-10-29" }} companyId="c" language="en" t={websiteBuilderCopy.en} handleDelete={() => {}} handleDuplicate={() => {}} handleRename={() => {}} /></MemoryRouter>));
      expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/companies/c/projects/p/qa/thumbnail"]);
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
});
