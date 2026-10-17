// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CodeFlagsPanel } from "../CodeFlagsPanel";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("C1a UI: CodeFlagsPanel DOM Interaction", () => {
  it("renders flags, allows toggling a sub-flag, and loads flag change history", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let readEnabled = false;

    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/code/flags")) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          expect(body.flagKey).toBe("code.read");
          expect(body.enabled).toBe(true);
          readEnabled = true;
          return json({ flag: { key: "code.read", enabled: true, stage: "internal", scope: "company" } });
        }
        return json({
          master: { key: "coding_agent.enabled", enabled: true, stage: "internal", scope: "company" },
          defaultsEnabled: false,
          management: { company: true, global: true },
          featuresInitialized: true,
          flags: [
            { key: "code.read", enabled: readEnabled, stage: readEnabled ? "internal" : "off", scope: "company" },
            { key: "code.write", enabled: false, stage: "off", scope: "company" },
          ],
        });
      }
      if (url.includes("/code/flags/history")) {
        return json({
          history: [
            {
              id: "hist-1",
              flagKey: "code.read",
              scope: "company",
              previousValue: { enabled: false, stage: "off" },
              nextValue: { enabled: true, stage: "internal" },
              actor: "user-admin",
              createdAt: "2026-10-17T03:00:00Z",
            },
          ],
        });
      }
      throw new Error("Unexpected request: " + url);
    });
    vi.stubGlobal("fetch", fetcher);

    const notify = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <MemoryRouter>
            <CodeFlagsPanel companyId="company-c1" isUk={false} notify={notify} />
          </MemoryRouter>,
        );
      });

      await vi.waitFor(() => {
        expect(host.textContent).toContain("code.read");
      });

      // Find toggle checkbox for code.read
      const readRow = [...host.querySelectorAll("tr")].find((tr) => tr.textContent?.includes("code.read"));
      expect(readRow).toBeTruthy();

      const toggleInput = readRow!.querySelector<HTMLInputElement>("input[type='checkbox']");
      expect(toggleInput).toBeTruthy();

      // Click to toggle on
      await act(async () => {
        toggleInput!.click();
      });

      await vi.waitFor(() => {
        expect(notify).toHaveBeenCalledWith("success", expect.stringContaining("code.read"));
      });

      const putCall = fetcher.mock.calls.find(([u, init]) => String(u).endsWith("/code/flags") && init?.method === "PUT");
      expect(putCall).toBeTruthy();

      // Check history section by opening details
      const details = host.querySelector<HTMLDetailsElement>("details.code-limits");
      expect(details).toBeTruthy();
      await act(async () => {
        details!.open = true;
        details!.dispatchEvent(new Event("toggle"));
      });
      await vi.waitFor(() => {
        expect(fetcher.mock.calls.some(([u]) => String(u).includes("/code/flags/history"))).toBe(true);
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
});
