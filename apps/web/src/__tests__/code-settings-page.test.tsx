// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { CodeSettingsPage } from "../CodeSettingsPage";
import { CodeAgentsPage } from "../CodeAgentsPage";

vi.mock("../i18n", () => ({ useTranslation: () => ({ language: "en" }) }));
vi.mock("../website-builder-cache", () => ({ listProjectCompanies: async () => (await (await fetch("/api/companies?limit=50")).json()).companies }));
vi.mock("../CodeFlagsPanel", () => ({ CodeFlagsPanel: () => <section className="code-flags"><h2>Feature flags (experimental)</h2></section> }));
vi.mock("../CodeSandboxImagesPanel", () => ({ CodeSandboxImagesPanel: () => null }));
vi.mock("../CodeDataPolicyPanel", () => ({ CodeDataPolicyPanel: () => null }));
vi.mock("../CodeQueuePanel", () => ({ CodeQueuePanel: () => null }));
vi.mock("../CodeMembershipPanel", () => ({ CodeMembershipPanel: () => null }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); document.body.innerHTML = ""; });
function Location() { return <output data-route>{useLocation().pathname + useLocation().search}</output>; }
const json = (body: unknown) => new Response(JSON.stringify(body));

it("shows the Npati settings arrow at Feature flags and scrolls to the top with the shared button", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollY", 0);
  vi.stubGlobal("innerHeight", 800);
  const scrollTo = vi.fn();
  vi.stubGlobal("scrollTo", scrollTo);
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === "/api/companies?limit=50") return json({ companies: [{ id: "company-flags", name: "Flags Company" }] });
    if (url.includes("/code/projects?")) return json({ projects: [] });
    if (url.endsWith("/code/sessions")) return json({ sessions: [] });
    if (url.endsWith("/code/limits")) return json({ limits: {} });
    throw new Error("Unexpected request: " + url);
  }));
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.classList.contains("code-flags") ? new DOMRect(0, 1400 - window.scrollY, 600, 1400) : new DOMRect();
  });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const arrow = () => host.querySelector<HTMLButtonElement>(".marketplace-scroll-top");
  const scroll = async (position: number) => act(async () => { vi.stubGlobal("scrollY", position); window.dispatchEvent(new Event("scroll")); });
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={["/settings/code?agent=npati"]}><CodeAgentsPage /></MemoryRouter>));
    await act(async () => host.querySelector<HTMLButtonElement>('.company-scope-trigger')!.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === "Flags Company")!.click());
    expect(host.querySelector(".code-flags")).not.toBeNull();
    expect(arrow()).toBeNull();
    await scroll(500);
    expect(arrow()).toBeNull();
    await scroll(850);
    expect(arrow()).not.toBeNull();
    await act(async () => arrow()!.click());
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    await scroll(1400);
    expect(arrow()).not.toBeNull();
    await scroll(0);
    expect(arrow()).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
it("renders the selected Company's code projects/sessions and opens the exact saved session", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const sessionId = "11223344-5566-7788-99aa-bbccddeeff00";
  const fetcher = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/projects/project-c1/code/sessions") && _init?.method === "POST") {
      expect(JSON.parse(String(_init.body)).mode).toBe("auto");
      return json({ id: sessionId, projectId: "project-c1", companyId: "company-c1", mode: "auto", status: "active" });
    }
    if (url === "/api/companies?limit=50") return json({ companies: [{ id: "company-c1", name: "C1 Company" }] });
    if (url.includes("/code/projects?")) return json({ projects: [{
      id: "project-c1", companyId: "company-c1", name: "Audited repository", type: "code_project", status: "ready",
      dataClassification: "restricted", retentionClass: "until_deleted", revision: 3,
      createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z",
      toolchain: { languages: ["node"], packageManagers: ["npm"], verifyCommands: { test: "npm test" }, source: "detected", evidence: ["package.json"] },
    }] });
    if (url.endsWith("/code/sessions")) return json({ sessions: [{
      id: sessionId, projectId: "project-c1", companyId: "company-c1", projectName: "Audited repository",
      mode: "plan", status: "active", dataClassification: "restricted", retentionClass: "until_deleted",
      createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z",
    }] });
    if (url.endsWith("/code/limits")) return json({ limits: { maxStepsPerRun: 40 } });
    if (url.endsWith("/code/active-context")) return json({ persisted: true });
    throw new Error("Unexpected request: " + url);
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<MemoryRouter initialEntries={["/settings/code"]}><CodeSettingsPage /><Location /></MemoryRouter>); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(host.textContent, JSON.stringify(fetcher.mock.calls)).toContain("Audited repository");
    });
    const row = [...host.querySelectorAll("tr")].find(row => row.textContent?.includes("11223344"));
    expect(row).toBeTruthy();
    const open = row!.querySelector<HTMLButtonElement>('button[aria-label="Open Workspace"]');
    expect(open).toBeTruthy();
    await act(async () => { open!.click(); });
    const request = fetcher.mock.calls.find(([url]) => String(url).endsWith("/code/active-context"));
    expect(request).toBeTruthy();
    expect(JSON.parse(String(request![1]?.body))).toEqual({ contextType: "project", projectId: "project-c1", sessionId });
    expect(host.querySelector("[data-route]")?.textContent).toBe("/settings/code/company-c1/project-c1?session=" + sessionId);
    const chat = row!.querySelector<HTMLButtonElement>('button[aria-label="Open in chat"]');
    await act(async () => { chat!.click(); });
    expect(host.querySelector("[data-route]")?.textContent).toBe("/chat?company=company-c1&project=project-c1");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "＋ New session")!.click());
    const dialog = host.querySelector('[role="dialog"]')!;
    await act(async () => {
      const mode = dialog.querySelectorAll("select")[1]!;
      mode.value = "auto_edit"; mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Create session")!.click());
    expect(fetcher.mock.calls.some(([url, init]) => String(url).includes("/projects/project-c1/code/sessions") && init?.method === "POST")).toBe(true);
  } finally { await act(async () => root.unmount()); }
});
