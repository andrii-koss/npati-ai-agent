// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentPage, contentExportFileName } from "./ContentPage";
const auth = vi.hoisted(() => ({ token: "test" }));
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => auth.token }));
vi.mock("./i18n", async () => ({ I18nContextRef: (await import("react")).createContext(null), executionTraceText: (s: string) => s, useTranslation: () => ({ language: "en", t: (s: string) => s }) }));
let root: Root, host: HTMLDivElement;
beforeEach(() => { auth.token += "-next"; localStorage.clear(); sessionStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("Content Hub company scope", () => {
  it("keeps the page header visible without loading text or zero counts before an empty result", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => (await pending).clone()));
    await act(async () => root.render(<MemoryRouter><ContentPage /></MemoryRouter>));
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector(".content-hub-header")).not.toBeNull();
    expect(host.querySelector(".pill-counter")).toBeNull();
    expect(host.querySelector(".content-studio-layout")).toBeNull();
    expect(host.querySelector(".content-summary-card")).toBeNull();
    expect(host.querySelector(".content-empty-card")).toBeNull();
    await act(async () => {
      release(new Response(JSON.stringify({ runs: [] })));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector(".content-empty-card h3")?.textContent).toBe("contentPage.empty.readyTitle");
    expect(host.querySelector(".content-studio-layout")).toBeNull();
  });

  it("shows content of a company beyond the first company page and the first five companies", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requested.push(url);
      const body = { runs: [{
        id: "late-run", companyId: "late", companyName: "Late company",
        task: "Social post about rye bread", result: "Fresh rye bread today.", createdAt: "2026-10-28T10:00:00Z",
        override: { title: "Edited rye bread post" },
      }] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }));
    await act(async () => { root.render(<MemoryRouter><ContentPage /></MemoryRouter>); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector(".content-card-title")?.textContent).toBe("Edited rye bread post");
    expect(host.querySelector(".pill-counter")?.textContent).toBe("1");
    expect(requested).toEqual(["/api/content/open"]);
  });
  it("keeps Cyrillic letters in the exported Markdown file name", () => {
    expect(contentExportFileName("R118366 Хліб дня")).toBe("r118366-хліб-дня.md");
    expect(contentExportFileName("«Житній»")).toBe("житній.md");
    expect(contentExportFileName("!!!")).toBe("content-draft.md");
  });
});
