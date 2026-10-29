// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentPage, contentExportFileName } from "./ContentPage";
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => "test" }));
vi.mock("./i18n", () => ({ useTranslation: () => ({ language: "en", t: (s: string) => s }) }));
let root: Root, host: HTMLDivElement;
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("Content Hub company scope", () => {
  it("shows content of a company beyond the first company page and the first five companies", async () => {
    const early = Array.from({ length: 10 }, (_, index) => ({ id: `early-${index}`, name: `Early ${index}` }));
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requested.push(url);
      const body = url.includes("/content/overrides") ? { overrides: {} }
        : url.includes("/companies/late/runs") ? { runs: [{ id: "late-run", task: "Social post about rye bread", result: "Fresh rye bread today.", createdAt: "2026-10-28T10:00:00Z", status: "completed" }] }
        : url.includes("/runs") ? { runs: [] }
        : url.includes("cursor=") ? { companies: [{ id: "late", name: "Late company" }], pagination: { nextCursor: null } }
        : { companies: early, pagination: { nextCursor: "next-page" } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }));
    await act(async () => { root.render(<MemoryRouter><ContentPage /></MemoryRouter>); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect([...host.querySelectorAll(".content-card-title")].map((node) => node.textContent)).toContain("Social post about rye bread");
    expect(requested.filter((url) => url.includes("/runs")).length).toBe(11);
  });
  it("keeps Cyrillic letters in the exported Markdown file name", () => {
    expect(contentExportFileName("R118366 Хліб дня")).toBe("r118366-хліб-дня.md");
    expect(contentExportFileName("«Житній»")).toBe("житній.md");
    expect(contentExportFileName("!!!")).toBe("content-draft.md");
  });
});
