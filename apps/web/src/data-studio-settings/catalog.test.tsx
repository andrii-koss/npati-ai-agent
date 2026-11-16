// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DataStudioSettingsPage } from "../DataStudioSettingsPage";
import type { DataStudioCatalog } from "./types";

const auth = vi.hoisted(() => ({ token: "" }));
vi.mock("../AuthContext", () => ({ getStoredAuthToken: () => auth.token }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ language: "en" }) }));
const items = Array.from({ length: 25 }, (_, i) => ({ id: `b${i}`, name: `Database ${i}`, companyId: `c${i % 2}`, companyName: `Company ${i % 2}`,
  provider: "shared_postgres", status: i === 24 ? "archived" : "ready", createdAt: new Date(Date.UTC(2026, 10, 25 - i)).toISOString(),
  attachedProjectCount: 1, tableCount: 2, environments: ["dev", "prod"].map(environment => ({ environment: environment as "dev" | "prod", status: "ready", syncStatus: "synced" })) }));
const companies = [{ id: "c0", name: "Company 0" }, { id: "c1", name: "Company 1" }];
function response(url: URL): DataStudioCatalog {
  const companyItems = items.filter(item => !url.searchParams.has("companyId") || item.companyId === url.searchParams.get("companyId"));
  const search = url.searchParams.get("search")?.toLowerCase() ?? "";
  const rows = companyItems.filter(item => item.name.toLowerCase().includes(search) && (url.searchParams.get("status") === "attention" ? item.status !== "ready" : url.searchParams.get("status") === "ready" ? item.status === "ready" : true));
  const start = Number(url.searchParams.get("cursor") ?? 0), limit = Number(url.searchParams.get("limit") ?? 10);
  return { companies, items: rows.slice(start, start + limit), stats: { total: companyItems.length, ready: companyItems.filter(i => i.status === "ready").length,
    attention: companyItems.filter(i => i.status !== "ready").length, tables: companyItems.length * 2, tableCountsKnown: companyItems.length,
    readyEnvironments: companyItems.length * 2, totalEnvironments: companyItems.length * 2, totalProjects: companyItems.length, attachedProjects: companyItems.length },
  pagination: { total: rows.length, nextCursor: start + limit < rows.length ? String(start + limit) : null } };
}
let host: HTMLDivElement, root: Root;
let observers: Array<{ callback: (entries: { isIntersecting: boolean }[]) => void; active: boolean }>;
let failNext: boolean, deferNext: boolean, release: () => void;
let tokenCount = 0;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), "http://localhost");
  if (url.pathname === "/api/data-studio/catalog") {
    if (url.searchParams.has("cursor")) {
      if (failNext) { failNext = false; return json({ error: { message: "Retry page" } }, 503); }
      if (deferNext) { deferNext = false; await new Promise<void>(resolve => { release = resolve; }); }
    }
    return json(response(url));
  }
  if (url.pathname.startsWith("/api/data-studio/databases/")) {
    const backend = items.find(item => item.name === decodeURIComponent(url.pathname.split("/").at(-1)!));
    return backend ? json(backend) : json({ error: { message: "Database not found" } }, 404);
  }
  const id = url.pathname.match(/\/data-backends\/(b\d+)\/workspace/)?.[1];
  if (id) {
    const backend = items.find(item => item.id === id)!;
    return json({ backend, projects: items.filter(item => item.companyId === backend.companyId).map(item => ({ id: `p${item.id}`, name: `Project ${item.id}`, companyId: item.companyId, dataBackendId: item.id })),
      environments: backend.environments, quotas: {} });
  }
  if (url.pathname.endsWith("/collections/counts")) {
    expect(JSON.parse(String(init?.body)).collections).toEqual(["table_a", "table_b"]);
    return json({ counts: { table_a: 7, table_b: 12 }, exact: true });
  }
  if (/\/data-studio\/(dev|prod)$/.test(url.pathname)) {
    const id = url.pathname.match(/\/projects\/p(b\d+)\//)![1]!;
    const backend = items.find(item => item.id === id)!;
    expect(url.pathname).toContain(`/companies/${backend.companyId}/`);
    return json({ backend, environment: { environment: "dev", status: "ready", syncStatus: "synced" },
      schema: { tables: ["table_a", "table_b"].map(name => ({ name, columns: [], indexes: [], constraints: [], policies: [], rlsEnabled: true })) },
      drift: null, lock: { held: false }, migrations: [] });
  }
  throw new Error(`Unexpected request: ${url.pathname}`);
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("scrollY", 0);
  auth.token = `catalog-user-${++tokenCount}`;
  localStorage.clear(); sessionStorage.clear(); observers = []; failNext = false; deferNext = false;
  vi.stubGlobal("IntersectionObserver", class {
    record: typeof observers[number];
    constructor(callback: typeof observers[number]["callback"]) { this.record = { callback, active: false }; observers.push(this.record); }
    observe() { this.record.active = true; } disconnect() { this.record.active = false; }
  });
  vi.stubGlobal("fetch", vi.fn(fetcher));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function RouteProbe() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output data-testid="url">{location.pathname}</output><button onClick={() => navigate(-1)}>Browser back</button><button onClick={() => navigate(1)}>Browser forward</button></>;
}
const render = async (url = "/settings/data-studio") => act(async () => root.render(<MemoryRouter initialEntries={[url]}><RouteProbe /><DataStudioSettingsPage /></MemoryRouter>));
const rows = () => host.querySelectorAll("tbody tr");
const urls = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url));
const click = async (button: HTMLElement) => act(async () => button.click());
const startScroll = async () => act(async () => { vi.stubGlobal("scrollY", 300); window.dispatchEvent(new Event("scroll")); });
const intersect = () => [...observers].reverse().find(observer => observer.active)!.callback([{ isIntersecting: true }]);

it("shows complete statistics and rows together without temporary zeros or an empty-list flash", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(fetch).mockImplementationOnce(async (input, init) => { await pending; return fetcher(input, init); });
  const frames: Array<{ busy: boolean; values: string[]; company: string; count: number; skeleton: boolean }> = [];
  const capture = () => {
    const stats = host.querySelector(".ds-catalog-stats")!;
    frames.push({ busy: stats.getAttribute("aria-busy") === "true", values: [...stats.querySelectorAll("strong")].map(el => el.textContent!),
      company: stats.querySelector("small")!.textContent!, count: rows().length, skeleton: Boolean(host.querySelector("tbody tr[style]")) });
  };
  const renderTracked = () => act(async () => root.render(<React.Profiler id="catalog" onRender={capture}><MemoryRouter><DataStudioSettingsPage /></MemoryRouter></React.Profiler>));
  await renderTracked();
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every(frame => frame.busy && frame.values.every(value => value === "—"))).toBe(true);
  expect(rows()).toHaveLength(10);
  await act(async () => finish());
  const ready = frames.filter(frame => !frame.busy);
  expect(ready.length).toBeGreaterThan(0);
  for (const frame of ready) {
    expect(frame.values).toEqual(["25", "50 / 50", "50", "25"]);
    expect(frame.company).toBe("across 2 companies"); expect(frame.count).toBe(10); expect(frame.skeleton).toBe(false);
  }
  await act(async () => root.unmount()); root = createRoot(host); frames.length = 0;
  await renderTracked();
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every(frame => !frame.busy && frame.count === 10 && !frame.skeleton)).toBe(true);
  expect(urls()).toHaveLength(1);
});

it("loads exactly ten newest databases with one request, then appends pages after scrolling without duplicate requests", async () => {
  await render(); expect(rows()).toHaveLength(10); expect(rows()[0]?.textContent).toContain("Database 0");
  expect(urls()).toHaveLength(1); expect(urls()[0]).toContain("/api/data-studio/catalog?");
  expect(observers.some(o => o.active)).toBe(false);
  expect(host.textContent).toContain("Showing 10 of 25");
  await startScroll(); deferNext = true;
  await act(async () => { intersect(); intersect(); });
  expect(urls()).toHaveLength(2); expect(rows()).toHaveLength(10);
  await act(async () => release()); expect(rows()).toHaveLength(20);
  await act(async () => intersect()); expect(rows()).toHaveLength(25);
  expect(host.querySelector(".data-studio-catalog-sentinel")).toBeNull();
  expect(urls().every(url => url.includes("/data-studio/catalog?"))).toBe(true);
});

it("reuses the catalog on remount and never performs a second cached-company fanout", async () => {
  localStorage.setItem("npati_cached_companies_v1", JSON.stringify(companies));
  await render(); expect(urls()).toHaveLength(1);
  await act(async () => root.unmount()); root = createRoot(host);
  await render(); expect(rows()).toHaveLength(10); expect(urls()).toHaveLength(1);
});

it("searches all databases rather than only the first page and sends server company/status filters", async () => {
  await render();
  const search = host.querySelector<HTMLInputElement>('[role="searchbox"]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { set.call(search, "Database 24"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 280)); });
  expect(rows()).toHaveLength(1); expect(rows()[0]?.textContent).toContain("Database 24");
  expect(urls().at(-1)).toContain("search=Database+24");
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="Company"]')!);
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === "Company 0")!.click());
  expect(urls().at(-1)).toContain("companyId=c0");
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent?.includes("Needs attention"))!);
  expect(urls().at(-1)).toContain("status=attention"); expect(rows()).toHaveLength(1);
});

it("keeps company summary cards unchanged through pending, rapid, and cached status-tab changes", async () => {
  const frames: string[] = [];
  let track = false;
  const capture = () => { if (track) frames.push(host.querySelector(".ds-catalog-stats")!.outerHTML); };
  await act(async () => root.render(<React.Profiler id="tabs" onRender={capture}><MemoryRouter initialEntries={["/settings/data-studio"]}><DataStudioSettingsPage /></MemoryRouter></React.Profiler>));
  const original = host.querySelector(".ds-catalog-stats")!.outerHTML;
  const pending: Array<() => void> = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    await new Promise<void>(resolve => pending.push(resolve));
    return fetcher(input, init);
  });
  track = true;
  const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent?.startsWith(label))!;
  await click(tab("Ready"));
  expect(pending).toHaveLength(1);
  expect(host.querySelector(".ds-catalog-stats")!.getAttribute("aria-busy")).toBe("false");
  expect(host.querySelector('button[aria-label="Company"]')).not.toBeNull();
  await click(tab("Needs attention"));
  expect(pending).toHaveLength(2);
  await act(async () => pending[0]!());
  expect(tab("Needs attention").getAttribute("aria-selected")).toBe("true");
  await act(async () => pending[1]!());
  expect(rows()).toHaveLength(1);
  await click(tab("All"));
  expect(rows()).toHaveLength(10);
  expect(pending).toHaveLength(2);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every(frame => frame === original)).toBe(true);
});

it("loads workspace and schema only on opening a database, uses its own company, and returns real bulk row counts", async () => {
  await render(); await click(host.querySelectorAll<HTMLButtonElement>(".ds-name-link")[1]!);
  expect(host.querySelector('[data-testid="url"]')?.textContent).toBe("/settings/data-studio/Database%201");
  expect(urls()).toHaveLength(3);
  expect(urls()[1]).toBe("/api/companies/c1/data-backends/b1/workspace");
  expect(urls()[2]).toBe("/api/companies/c1/projects/pb1/data-studio/dev");
  await click([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Count rows"))!);
  expect(urls()).toHaveLength(4); expect(urls().at(-1)).toContain("/collections/counts");
  expect([...rows()].map(row => row.children[5]?.textContent)).toEqual(["7", "12"]);
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="All databases"]')!);
  expect(rows()).toHaveLength(10); expect(urls()).toHaveLength(4);
});

it("restores a direct database URL outside the first page after a full remount and supports browser history", async () => {
  const url = "/settings/data-studio/Database%2024";
  await render(url);
  expect(host.querySelector("h1")?.textContent).toContain("Database 24");
  expect(urls()).toContain("/api/data-studio/databases/Database%2024");
  expect(urls()).toContain("/api/companies/c0/data-backends/b24/workspace");
  expect(urls()).toContain("/api/companies/c0/projects/pb24/data-studio/dev");
  expect(host.querySelector(".ds-catalog-stats")).toBeNull();
  await act(async () => root.unmount()); root = createRoot(host);
  await render(url);
  expect(host.querySelector("h1")?.textContent).toContain("Database 24");
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="All databases"]')!);
  expect(host.querySelector('[data-testid="url"]')?.textContent).toBe("/settings/data-studio");
  await click([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Browser back")!);
  expect(host.querySelector("h1")?.textContent).toContain("Database 24");
  await click([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Browser forward")!);
  expect(rows()).toHaveLength(10);
});

it("shows a missing-database error on its own URL without falling back to the catalog", async () => {
  await render("/settings/data-studio/missing");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Database not found");
  expect(host.querySelector(".ds-catalog-stats")).toBeNull();
  expect(host.querySelector('[data-testid="url"]')?.textContent).toBe("/settings/data-studio/missing");
});

it("selects all matching databases across unloaded pages only on explicit user action", async () => {
  await render();
  await click(host.querySelector<HTMLButtonElement>(".ds-bulk-select-link")!);
  expect(rows()).toHaveLength(25); expect(urls()).toHaveLength(2);
  expect(host.textContent).toContain("Selected: 25");
  const checkbox = host.querySelector<HTMLInputElement>('thead input[type="checkbox"]')!;
  expect(checkbox.checked).toBe(true);
  await click(checkbox); expect(checkbox.checked).toBe(false);
  expect([...host.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')].every(input => !input.checked)).toBe(true);
});

it("keeps loaded rows on a failed next page and retries without silently skipping records", async () => {
  await render(); await startScroll(); failNext = true;
  await act(async () => intersect());
  expect(rows()).toHaveLength(10); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Retry page");
  expect(observers.some(o => o.active)).toBe(false);
  await click(host.querySelector<HTMLButtonElement>(".data-studio-catalog-sentinel button")!);
  expect(rows()).toHaveLength(20); expect(urls()[1]).toBe(urls()[2]);
});
