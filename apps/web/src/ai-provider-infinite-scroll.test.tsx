// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "./i18n";
import { AIProviderMarketplace } from "./AIProviderMarketplace";
import type { MarketplaceData, Provider } from "./ai-marketplace-types";

vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => null }));

const providers: Provider[] = Array.from({ length: 25 }, (_, index) => ({
  id: `provider-${index}`, name: `Provider ${index}`, category: "cloud", authType: "api_key",
  connectionStatus: "disconnected", freeStatus: "paid", local: false, modelCount: 1,
  capabilities: ["text"], connected: false, recommended: false, experimental: false,
  credentialOptional: false, connectable: true, connectionMode: "api_key", availability: "ready", connections: [],
}));
const page = (offset: number): MarketplaceData => ({
  source: { version: "test", commit: "test", registryProviders: 25, routableProviders: 25 },
  overview: { providers: 25, models: 25, connectedProviders: 0, addedModels: 0 },
  counts: { all: 25, free: 0, connected: 0, recommended: 0, local: 0 },
  availableFilters: { auth: [], cost: [], capabilities: [] },
  providers: providers.slice(offset, offset + 24),
  pagination: { offset, limit: 24, returned: Math.min(24, 25 - offset), total: 25, hasMore: offset === 0 },
});
type Observer = { callback: (entries: { isIntersecting: boolean }[]) => void; active: boolean };
let observers: Observer[];
let root: Root;
let host: HTMLDivElement;
let releaseNext: (response: Response) => void;
let nextRequests: number;
const intersect = () => [...observers].reverse().find(observer => observer.active)!.callback([{ isIntersecting: true }]);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); observers = []; nextRequests = 0;
  vi.stubGlobal("IntersectionObserver", class {
    record: Observer;
    constructor(callback: Observer["callback"]) { this.record = { callback, active: false }; observers.push(this.record); }
    observe() { this.record.active = true; }
    disconnect() { this.record.active = false; }
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/ai/models/added") return new Response("[]");
    if (url.pathname === "/api/ai/routing") return new Response("null");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (url.searchParams.get("tab") === "all" && offset > 0) {
      nextRequests++;
      return new Promise<Response>(resolve => { releaseNext = resolve; });
    }
    return new Response(JSON.stringify(page(offset)));
  }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<I18nProvider><MemoryRouter><AIProviderMarketplace /></MemoryRouter></I18nProvider>)); }

it("appends providers near the end, prevents duplicate requests, and stops on the last page", async () => {
  await render();
  expect(host.querySelectorAll(".provider-card")).toHaveLength(24);
  expect(host.querySelector(".explore-section button.load-more")).toBeNull();
  expect(nextRequests).toBe(0);
  const observed = [...observers].reverse().find(observer => observer.active)!;
  await act(async () => { intersect(); intersect(); });
  expect(nextRequests).toBe(1);
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => releaseNext(new Response(JSON.stringify(page(24)))));
  expect(host.querySelectorAll(".provider-card")).toHaveLength(25);
  expect(host.querySelector(".provider-scroll-sentinel")).toBeNull();
  // A queued callback from a disconnected observer cannot request another page.
  await act(async () => observed.callback([{ isIntersecting: true }]));
  expect(nextRequests).toBe(1);
});

it("stops automatic pagination on failure and retains the existing retry action", async () => {
  await render();
  await act(async () => intersect());
  await act(async () => releaseNext(new Response(JSON.stringify({ error: { message: "Unavailable" } }), { status: 503 })));
  expect(host.querySelector(".provider-scroll-sentinel")).toBeNull();
  expect(host.querySelector(".engine-error .button-primary")).not.toBeNull();
  expect(observers.some(observer => observer.active)).toBe(false);
  expect(nextRequests).toBe(1);
});

it("shows the arrow only when the third provider row is substantially visible, including after a responsive layout change", async () => {
  let columns = 3;
  vi.stubGlobal("scrollY", 0);
  vi.stubGlobal("innerHeight", 800);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const index = Array.from(this.parentElement?.children ?? []).indexOf(this);
    const rowHeight = columns === 3 ? 300 : 400;
    return new DOMRect(0, 1000 + Math.floor(index / columns) * rowHeight - window.scrollY, 250, rowHeight - 20);
  });
  await render();
  const arrow = () => host.querySelector<HTMLButtonElement>(".marketplace-scroll-top");
  const scroll = async (position: number) => act(async () => { vi.stubGlobal("scrollY", position); window.dispatchEvent(new Event("scroll")); });
  expect(arrow()).toBeNull();
  await scroll(400);
  expect(arrow()).toBeNull();
  await scroll(850); // Third row has only just entered the viewport.
  expect(arrow()).toBeNull();
  await scroll(1000);
  expect(arrow()).not.toBeNull();
  columns = 1;
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(arrow()).toBeNull();
  await scroll(1400);
  expect(arrow()).not.toBeNull();
  await scroll(0);
  expect(arrow()).toBeNull();
});
