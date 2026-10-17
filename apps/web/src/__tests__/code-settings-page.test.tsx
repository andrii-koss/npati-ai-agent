// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { CodeSettingsPage } from "../CodeSettingsPage";

vi.mock("../i18n", () => ({ useTranslation: () => ({ language: "en" }) }));
vi.mock("../CodeFlagsPanel", () => ({ CodeFlagsPanel: () => null }));
vi.mock("../CodeSandboxImagesPanel", () => ({ CodeSandboxImagesPanel: () => null }));
vi.mock("../CodeDataPolicyPanel", () => ({ CodeDataPolicyPanel: () => null }));
vi.mock("../CodeQueuePanel", () => ({ CodeQueuePanel: () => null }));
vi.mock("../CodeMembershipPanel", () => ({ CodeMembershipPanel: () => null }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); document.body.innerHTML = ""; });
function Location() { return <output data-route>{useLocation().pathname + useLocation().search}</output>; }
const json = (body: unknown) => new Response(JSON.stringify(body));
it("renders the selected Company's code projects/sessions and opens the exact saved session", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const sessionId = "11223344-5566-7788-99aa-bbccddeeff00";
  const fetcher = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = String(input);
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
    const open = [...row!.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Open Workspace");
    expect(open).toBeTruthy();
    await act(async () => { open!.click(); });
    const request = fetcher.mock.calls.find(([url]) => String(url).endsWith("/code/active-context"));
    expect(request).toBeTruthy();
    expect(JSON.parse(String(request![1]?.body))).toEqual({ contextType: "project", projectId: "project-c1", sessionId });
    expect(host.querySelector("[data-route]")?.textContent).toBe("/settings/code/company-c1/project-c1?session=" + sessionId);
  } finally { await act(async () => root.unmount()); }
});
