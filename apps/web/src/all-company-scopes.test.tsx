// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { GoalsPage } from "./GoalsPage";
import { MemoryPage } from "./MemoryPage";
import { AutomationsPage } from "./AutomationsPage";
import { ActivityPage } from "./ActivityPage";
import { EmailSettingsPage } from "./EmailSettingsPage";
import { EmailInboxPage } from "./EmailInboxPage";
import { CodeSettingsPage } from "./CodeSettingsPage";
import { BusinessPage } from "./business-workspace-page-views";
import { clearSettingsSnapshots } from "./settings-page-cache";

const fixture = vi.hoisted(() => {
  const companies = [{ id: "alpha", name: "Alpha Company", businessStage: "active" }, { id: "beta", name: "Beta Company", businessStage: "active" }];
  return { companies, workspace: { overview: { businesses: companies, currentBusiness: companies[0], onboardings: [], companies: [], currentGoals: [], memory: [] }, loading: false, error: null, refresh: async () => {}, switchBusiness: vi.fn(async () => {}) } };
});
vi.mock("./i18n", async () => ({ I18nContextRef: (await import("react")).createContext(null), useTranslation: () => ({ language: "en", t: (key: string) => key }) }));
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => "test-all-scope", getStoredAuthUser: () => ({ id: "user" }), useAuth: () => ({ token: "test-all-scope", user: { id: "user" } }) }));
vi.mock("./BusinessWorkspace", () => ({ useWorkspace: () => fixture.workspace }));
vi.mock("./business-workspace-shared", async importOriginal => ({ ...await importOriginal<object>(), useWorkspace: () => fixture.workspace }));
vi.mock("./website-builder-cache", () => ({ listProjectCompanies: async () => fixture.companies }));
vi.mock("./CodeRunMonitor", () => ({ CodeRunMonitor: ({ companyId }: { companyId: string }) => <output data-owner>{companyId}</output> }));
let host: HTMLDivElement, root: Root;
const requests: string[] = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  clearSettingsSnapshots(); requests.length = 0; localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("npati_selected_company_id_v1", "beta");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    const id = url.match(/\/(?:companies|businesses)\/(alpha|beta)/)?.[1] ?? "alpha";
    const item = { id: `${id}-item`, companyId: id, businessId: id, title: `Record ${id}`, name: `Record ${id}`, description: "Details", content: "Content", source: "user", type: "business_fact", confidence: 1, status: "active", priority: 2, prompt: "Task", cronExpression: "0 9 * * *", createdAt: "2026-11-16", updatedAt: "2026-11-16" };
    let data: unknown = {};
    if (url.startsWith("/api/goals/page") || url.startsWith("/api/memory/page")) {
      const businessId = new URL(url, "http://localhost").searchParams.get("businessId");
      const ids = businessId ? [businessId] : ["alpha", "beta"];
      const records = ids.map(id => ({ ...item, id: `${id}-item`, businessId: id, title: `Record ${id}` }));
      data = url.startsWith("/api/memory/") ? {
        items: records.map(record => record.businessId === "alpha" ? { ...record, source: "chat:" + "a".repeat(64) } : record),
        counts: { all: ids.length, facts: ids.length, audience: 0, brand: 0, decisions: 0, product: 0, other: 0 },
        nextCursor: null,
      } : {
        goals: records,
        counts: { total: ids.length, active: ids.length, paused: 0, completed: 0, highPriority: 0 },
        nextCursor: null,
      };
    }
    else if (/\/businesses\/.*\/(goals|memory)$/.test(url)) data = [item];
    else if (url.endsWith("/automations")) data = { automations: [item] };
    else if (url.endsWith("/agents")) data = { agents: [] };
    else if (url.endsWith("/browser-targets")) data = { targets: [], emailAccounts: [] };
    else if (url.includes("/code/projects?")) data = { projects: [{ ...item, revision: 1 }] };
    else if (url.endsWith("/code/sessions")) data = { sessions: [] };
    else if (url.endsWith("/code/limits")) data = { limits: {} };
    else if (url.includes("/code/monitor/runs")) data = { runs: [], nextCursor: null };
    else if (url.includes("/runs?")) data = { runs: [{ ...item, task: `Record ${id}`, requestedMode: "coding", effectiveMode: "coding", status: "completed" }] };
    else if (url.endsWith("/email-accounts")) data = { accounts: [{ ...item, emailAddress: `${id}@example.com`, provider: "imap_smtp", mode: "manual", testMode: true, status: "connected", imapConfig: {}, smtpConfig: {}, rateLimits: {}, followupConfig: {}, signatureConfig: {} }] };
    else if (url.endsWith("/email-inbox/analytics")) data = { analytics: null };
    else if (url.includes("/email-inbox/threads?")) data = { threads: [{ ...item, subject: `Record ${id}`, customerEmail: `${id}@example.com`, folder: "inbox", unreadCount: 0, lastMessageAt: "2026-11-16", priority: "normal", status: "new" }] };
    else if (url.includes("/email-inbox/folder-counts")) data = { counts: { inbox: 1, sent: 0, drafts: 0, archived: 0, spam: 0 } };
    else if (url.endsWith("/notifications")) data = { notifications: [] };
    else if (url.includes("/email-inbox/threads/") && !url.endsWith("/audit")) data = { thread: { ...item, subject: `Record ${id}`, customerEmail: `${id}@example.com`, folder: "inbox", unreadCount: 0, lastMessageAt: "2026-11-16", priority: "normal", status: "new" }, messages: [], contact: null, customerContext: { previousThreads: [], tasks: [] } };
    else if (url.endsWith("/audit")) data = { logs: [] };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  }));
});

it("paints email accounts without waiting for slow analytics", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  let release!: () => void;
  const analytics = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).endsWith("/email-inbox/analytics")) { await analytics; return new Response(JSON.stringify({ analytics: null })); }
    return original(input, init);
  });
  await act(async () => root.render(<MemoryRouter><EmailSettingsPage /></MemoryRouter>));
  expect(host.textContent).toContain("alpha@example.com");
  expect(host.textContent).toContain("beta@example.com");
  await act(async () => release());
});

it("keeps code records visible immediately on remount while the refresh is pending", async () => {
  await act(async () => root.render(<MemoryRouter><CodeSettingsPage /></MemoryRouter>));
  expect(host.textContent).toContain("Record alpha");
  await act(async () => root.unmount()); root = createRoot(host);
  const original = vi.mocked(fetch).getMockImplementation()!;
  let release!: () => void;
  const refresh = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fetch).mockImplementation(async (input, init) => { await refresh; return original(input, init); });
  await act(async () => root.render(<MemoryRouter><CodeSettingsPage /></MemoryRouter>));
  expect(host.textContent).toContain("Record alpha");
  expect(host.textContent).toContain("Record beta");
  await act(async () => release());
});

it("mounts the first business cards immediately and loads more on demand without losing totals", async () => {
  const previous = fixture.workspace.overview.businesses;
  fixture.workspace.overview.businesses = Array.from({ length: 40 }, (_, index) => ({ id: `business-${index}`, name: `Business ${index}`, businessStage: "active" }));
  try {
    await act(async () => root.render(<MemoryRouter><BusinessPage /></MemoryRouter>));
    expect(host.querySelectorAll(".biz-card")).toHaveLength(12);
    expect(host.querySelector(".business-stats-grid")?.textContent).toContain("40");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Load more")!.click());
    expect(host.querySelectorAll(".biz-card")).toHaveLength(24);
  } finally { fixture.workspace.overview.businesses = previous; }
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("shows a ready Inbox conversation and its body before slow companies, counts, notifications and audit finish", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/beta/email-inbox/threads?") || url.includes("/folder-counts") || url.endsWith("/notifications") || url.endsWith("/audit")) await slow;
    return original(input, init);
  });
  await act(async () => root.render(<MemoryRouter><EmailInboxPage /></MemoryRouter>));
  expect(host.querySelector(".email-inbox-thread-card")?.textContent).toContain("Record alpha");
  expect(host.querySelector(".email-inbox-detail-header")?.textContent).toContain("Record alpha");
  expect(host.querySelector(".email-inbox-threads-scroll")?.textContent).not.toContain("Record beta");
  await act(async () => release());
  expect(host.querySelector(".email-inbox-threads-scroll")?.textContent).toContain("Record beta");
});

it("restores Inbox conversations and the selected body immediately while the refresh is pending", async () => {
  await act(async () => root.render(<MemoryRouter><EmailInboxPage /></MemoryRouter>));
  expect(host.querySelector(".email-inbox-detail-header")).not.toBeNull();
  await act(async () => root.unmount()); root = createRoot(host);
  const original = vi.mocked(fetch).getMockImplementation()!;
  let release!: () => void;
  const refresh = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fetch).mockImplementation(async (input, init) => { await refresh; return original(input, init); });
  await act(async () => root.render(<MemoryRouter><EmailInboxPage /></MemoryRouter>));
  expect(host.querySelectorAll(".email-inbox-thread-card")).toHaveLength(2);
  expect(host.querySelector(".email-inbox-detail-header")?.textContent).toContain("Record alpha");
  await act(async () => release());
});

it("ignores delayed Inbox search results after the query changes", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  let release!: () => void;
  const oldQuery = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/threads?") && (url.includes("search=old") || url.includes("search=new"))) {
      const old = url.includes("search=old");
      if (old) await oldQuery;
      const id = url.includes("/alpha/") ? "alpha" : "beta";
      return new Response(JSON.stringify({ threads: [{ id: `${id}-${old ? "old" : "new"}`, companyId: id, subject: old ? "Obsolete result" : "Newest result", customerEmail: `${id}@example.com`, unreadCount: 0, lastMessageAt: "2026-11-16", folder: "inbox", status: "new", priority: "normal" }] }));
    }
    return original(input, init);
  });
  await act(async () => root.render(<MemoryRouter><EmailInboxPage /></MemoryRouter>));
  const input = host.querySelector<HTMLInputElement>('input[aria-label="emailInbox.threadsList.searchAria"]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { set.call(input, "old"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { set.call(input, "new"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(host.querySelector(".email-inbox-threads-scroll")?.textContent).toContain("Newest result");
  await act(async () => release());
  expect(host.querySelector(".email-inbox-threads-scroll")?.textContent).not.toContain("Obsolete result");
});

it.each([
  ["goals", GoalsPage, "Record alpha", "Record beta"],
  ["memory", MemoryPage, "Record alpha", "Record beta"],
  ["automations", AutomationsPage, "Record alpha", "Record beta"],
  ["activity", ActivityPage, "Record alpha", "Record beta"],
  ["email", EmailSettingsPage, "alpha@example.com", "beta@example.com"],
  ["email/inbox", EmailInboxPage, "Record alpha", "Record beta"],
  ["code", CodeSettingsPage, "Record alpha", "Record beta"],
  ["business", BusinessPage, "Alpha Company", "Beta Company"],
] as const)("%s defaults to all companies, aggregates records and filters to one company", async (page, Component, first, second) => {
  await act(async () => root.render(<MemoryRouter initialEntries={[`/settings/${page}`]}><Component /></MemoryRouter>));
  const selector = host.querySelector<HTMLButtonElement>(".company-scope-trigger")!;
  expect(selector?.textContent).toBe("All companies");
  expect(host.textContent).toContain(first);
  expect(host.textContent).toContain(second);
  expect(requests.some(url => url.includes("/companies/all/") || url.includes("/businesses/all/"))).toBe(false);
  if (page === "goals") {
    expect(requests).toEqual(["/api/goals/page?workspace=1"]);
    expect([...host.querySelectorAll(".tab-count")].map(count => count.textContent)).toEqual(["2", "2", "0", "0"]);
  }
  if (page === "memory") {
    expect(requests).toEqual(["/api/memory/page?workspace=1"]);
    expect([...host.querySelectorAll(".tab-count")].map(count => count.textContent)).toEqual(["2", "2", "0", "0", "0", "0", "0"]);
    const source = host.querySelector(".memory-source-tag");
    expect(source?.textContent).toBe("memoryPage.sources.chatConfirmed");
    expect(source?.getAttribute("title")).toBe("memoryPage.sources.sourcePrefix: memoryPage.sources.chatConfirmed");
  }
  await act(async () => selector.click());
  expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe("All companies");
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === "Beta Company")!.click());
  expect(selector.textContent).toBe("Beta Company");
  expect(host.textContent).toContain(second);
  expect(page === "business" ? host.querySelector(".biz-cards-grid, .biz-cards-list")?.textContent : host.textContent).not.toContain(first);
});
