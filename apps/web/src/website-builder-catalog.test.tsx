// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebsiteBuilderDashboard } from "./WebsiteBuilderDashboard";
import { getCachedWebsites, updateCachedWebsites } from "./website-builder-cache";
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => "test" }));
vi.mock("./i18n", () => ({ useTranslation: () => ({ language: "en", t: (s: string) => s }) }));
vi.mock("./website-builder-card", () => ({ WebsiteProjectCard: ({ site, companyId }: { site: { name: string }; companyId: string }) => <article data-project data-company={companyId}>{site.name}</article>, invalidateWebsitePreviewCache: vi.fn() }));
vi.mock("./website-builder-drawer", () => ({ CreateWebsiteDrawer: () => null }));
let root: Root, host: HTMLDivElement;
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const project = (id: string, companyId: string) => ({ id, companyId, name: id, type: "code_project" as const, status: "ready", revision: 1, updatedAt: "2026-10-27" });
const render = () => act(async () => { root.render(<MemoryRouter><WebsiteBuilderDashboard /></MemoryRouter>); });

describe("Projects catalog company scope and freshness", () => {
  it("does not use another company's latest cache for an uncached company", () => {
    updateCachedWebsites("a", [project("a-project", "a")]);
    expect(getCachedWebsites("b")).toBeNull();
  });
  it("loads all company pages so projects of later companies are reachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/projects") ? { projects: [] }
      : url.includes("cursor=") ? { companies: [{ id: "page-b", name: "Second page company" }], pagination: { nextCursor: null } }
        : { companies: [{ id: "page-a", name: "First page company" }], pagination: { nextCursor: "next-page" } }), { headers: { "content-type": "application/json" } })));
    await render();
    expect(host.querySelector('option[value="page-b"]')?.getAttribute("title")).toBe("Second page company");
  });
  it("refreshes new projects on focus instead of keeping the old list for five minutes", async () => {
    let rows = [project("focus-original", "focus-company")];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/projects") ? { projects: rows }
      : { companies: [{ id: "focus-company", name: "Focus company" }], pagination: { nextCursor: null } }), { headers: { "content-type": "application/json" } })));
    await render();
    expect(host.querySelectorAll("[data-project]")).toHaveLength(1);
    rows = [...rows, project("created-in-chat", "focus-company")];
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(host.querySelectorAll("[data-project]")).toHaveLength(2);
  });
  it("defaults to all companies, keeps card ownership, filters by company and constrains the selector", async () => {
    localStorage.setItem("npati_selected_company_id_v1", "company-a");
    const longName = "A company name that is far too long for the filter";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/projects")
      ? { projects: url.includes("/company-a/") ? [project("project-a", "company-a")] : [project("project-b", "company-b")] }
      : { companies: [{ id: "company-a", name: longName }, { id: "company-b", name: "Company B" }], pagination: { nextCursor: null } }), { headers: { "content-type": "application/json" } })));
    await render();
    const selector = host.querySelector<HTMLSelectElement>(".company-select")!;
    expect(selector.value).toBe("");
    expect(selector.options[0]?.textContent).toBe("All");
    expect(selector.style.width).toBe("130px");
    expect(host.querySelector('option[value="company-a"]')?.textContent).toMatch(/…$/);
    expect(host.querySelector('option[value="company-a"]')?.getAttribute("title")).toBe(longName);
    expect([...host.querySelectorAll("[data-project]")].map(node => node.getAttribute("data-company"))).toEqual(["company-a", "company-b"]);
    expect([...host.querySelectorAll("button")].some(button => button.textContent?.trim() === "Refresh")).toBe(false);
    await act(async () => { selector.value = "company-b"; selector.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.querySelectorAll("[data-project]")).toHaveLength(1);
    expect(host.querySelector("[data-project]")?.textContent).toBe("project-b");
  });
});
