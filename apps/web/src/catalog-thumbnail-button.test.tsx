// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CatalogProjectThumbnail, preloadCatalogThumbnails } from "./catalog-project-thumbnail";
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => "button-state", getStoredAuthUser: () => ({ id: "button-state" }) }));

describe("screenshot button feedback", () => {
  it("shows a preloaded image that completes between mounting and the visibility callback", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let intersect!: (entries: Partial<IntersectionObserverEntry>[]) => void;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe() {}
      disconnect() {}
    });
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const host = document.createElement("div"), root = createRoot(host);
    const thumbnail = { dataUrl: "data:image/webp;base64,preloaded", capturedAt: "2026-11-11" };
    try {
      preloadCatalogThumbnails([{ companyId: "race", id: "prefetch-before-visible", hasThumbnail: true }]);
      await act(async () => root.render(<CatalogProjectThumbnail companyId="race" projectId="prefetch-before-visible" name="Site" language="en" hasThumbnail onPreview={() => {}} />));
      await act(async () => finish(new Response(JSON.stringify({ thumbnail }))));
      await act(async () => intersect([{ isIntersecting: true }]));
      expect(host.querySelector("img")?.getAttribute("src")).toBe(thumbnail.dataUrl);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
  });
  it("keeps an explicitly refreshed image when an older read finishes later", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let finishRead!: (response: Response) => void;
    const thumbnail = { dataUrl: "data:image/webp;base64,new", capturedAt: "2026-11-11" };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/qa/thumbnail")) return init?.method === "POST"
        ? new Response(JSON.stringify({ thumbnail })) : new Promise<Response>(resolve => { finishRead = resolve; });
      return new Response(JSON.stringify(url.endsWith("/status") ? { isRunning: true } : { token: "token" }));
    }));
    const host = document.createElement("div"), root = createRoot(host);
    try {
      await act(async () => root.render(<CatalogProjectThumbnail companyId="race-company" projectId="race-site" name="Site" language="en" hasThumbnail onPreview={() => {}} />));
      await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
      expect(host.querySelector("img")?.getAttribute("src")).toBe(thumbnail.dataUrl);
      await act(async () => finishRead(new Response(JSON.stringify({ thumbnail: null }))));
      expect(host.querySelector("img")?.getAttribute("src")).toBe(thumbnail.dataUrl);
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
  });
  it.each(["empty", "failure", "webp"])("waits for visibility, shares requests and settles %s results", async outcome => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const observers: Array<(entries: Partial<IntersectionObserverEntry>[]) => void> = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) { observers.push(callback); }
      observe() {}
      disconnect() {}
    });
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const host = document.createElement("div"), root = createRoot(host);
    const props = { companyId: "visibility-company", projectId: outcome, name: "Site", language: "en", hasThumbnail: true, onPreview: () => {} };
    try {
      await act(async () => root.render(<><CatalogProjectThumbnail {...props} /><CatalogProjectThumbnail {...props} /></>));
      expect(fetch).not.toHaveBeenCalled();
      preloadCatalogThumbnails([{ companyId: props.companyId, id: props.projectId, hasThumbnail: true }]);
      expect(fetch).toHaveBeenCalledTimes(1);
      await act(async () => { observers.forEach(callback => callback([{ isIntersecting: true }])); });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(host.querySelectorAll(".website-thumbnail-skeleton")).toHaveLength(2);
      expect(host.querySelector(".website-thumbnail-skeleton [style*='animation']")).toBeNull();
      await act(async () => {
        finish(new Response(JSON.stringify(outcome === "failure" ? { error: { message: "Unavailable" } }
          : { thumbnail: outcome === "webp" ? { dataUrl: "data:image/webp;base64,fixture", capturedAt: "2026-11-11" } : null }), { status: outcome === "failure" ? 503 : 200 }));
      });
      expect(host.querySelectorAll(".website-thumbnail-skeleton")).toHaveLength(0);
      if (outcome === "webp") {
        expect(host.querySelectorAll("img")).toHaveLength(2);
        expect(host.querySelector("img")?.getAttribute("loading")).toBe("lazy");
      }
      await act(async () => root.render(null));
      observers.length = 0;
      await act(async () => root.render(<CatalogProjectThumbnail {...props} />));
      await act(async () => { observers.forEach(callback => callback([{ isIntersecting: true }])); });
      expect(fetch).toHaveBeenCalledTimes(outcome === "failure" ? 2 : 1);
      expect(sessionStorage.length).toBe(0);
      expect(localStorage.length).toBe(0);
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
  });
  it.each([true, false])("shows progress and restores its original appearance after success=%s", async success => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/qa/thumbnail') && init?.method === 'POST') return new Promise<Response>(resolve => { finish = resolve; });
      return new Response(JSON.stringify(url.endsWith('/status') ? { isRunning: true } : url.endsWith('/token') ? { token: 'token' } : { thumbnail: null }));
    }));
    const host=document.createElement('div'),root=createRoot(host);
    try {
      await act(async()=>root.render(<CatalogProjectThumbnail companyId="c" projectId={success?'success':'failure'} name="Site" language="en" onPreview={()=>{}} />));
      const button=host.querySelector<HTMLButtonElement>('.website-thumbnail-refresh')!,icon=button.querySelector('svg')!;
      expect(button.classList.contains('button-secondary')).toBe(true);expect(icon.getAttribute('width')).toBe('14');
      expect(button.textContent).toBe('');expect(button.title).toBe('Refresh screenshot');
      await act(async()=>button.click());
      expect(button.disabled).toBe(true);expect(button.getAttribute('aria-busy')).toBe('true');expect(icon.style.animation).toContain('website-preview-spin');
      await act(async()=>finish(new Response(JSON.stringify(success?{thumbnail:{dataUrl:'data:image/png;base64,fixture',capturedAt:'2026-10-29'}}:{error:{message:'Capture failed'}}),{status:success?200:503})));
      expect(button.disabled).toBe(false);expect(button.getAttribute('aria-busy')).toBe('false');expect(icon.style.animation).toBe('');expect(button.textContent).toBe('');
    } finally { await act(async()=>root.unmount());vi.unstubAllGlobals(); }
  });
});
