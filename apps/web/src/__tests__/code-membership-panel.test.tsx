// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeMembershipPanel } from "../CodeMembershipPanel";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("C5a UI: Code Membership, Role Management & Denial Reasoning", () => {
  it("C5a.L0610.02: displays current role and allowed permissions badge", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const fetcher = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/code/members")) {
        return json({
          members: [
            {
              companyId: "comp-1",
              userId: "user-admin",
              role: "admin",
              revision: 2,
              createdAt: "2026-10-17T00:00:00Z",
              updatedAt: "2026-10-17T01:00:00Z",
            },
          ],
          roles: ["owner", "admin", "member", "readonly"],
        });
      }
      throw new Error("Unexpected request: " + url);
    });
    vi.stubGlobal("fetch", fetcher);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<CodeMembershipPanel companyId="comp-1" isUk={false} />);
      });

      await vi.waitFor(() => {
        expect(host.querySelector("#current-role-badge")?.textContent).toBe("admin");
      });

      expect(host.querySelector("#current-role-banner")?.textContent).toContain("Your Current Role");
      expect(host.querySelector("#current-role-banner")?.textContent).toContain("Full access to code and settings");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("C5a.L0610.01: lists company members and executes role changes with expected revision", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let currentRole = "member";
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/code/members")) {
        return json({
          members: [
            {
              companyId: "comp-1",
              userId: "user-bob",
              role: currentRole,
              revision: 1,
              createdAt: "2026-10-17T00:00:00Z",
              updatedAt: "2026-10-17T01:00:00Z",
            },
          ],
          roles: ["owner", "admin", "member", "readonly"],
        });
      }
      if (url.includes("/code/members/user-bob") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        expect(body.role).toBe("admin");
        expect(body.expectedRevision).toBe(1);
        currentRole = "admin";
        return json({
          member: {
            companyId: "comp-1",
            userId: "user-bob",
            role: "admin",
            revision: 2,
            createdAt: "2026-10-17T00:00:00Z",
            updatedAt: "2026-10-17T02:00:00Z",
          },
        });
      }
      throw new Error("Unexpected request: " + url);
    });
    vi.stubGlobal("fetch", fetcher);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<CodeMembershipPanel companyId="comp-1" isUk={false} />);
      });

      await vi.waitFor(() => {
        expect(host.querySelector("#member-row-user-bob")).toBeTruthy();
      });

      const select = host.querySelector<HTMLSelectElement>("#role-select-user-bob");
      expect(select).toBeTruthy();
      expect(select?.value).toBe("member");

      // Change role to admin
      await act(async () => {
        select!.value = "admin";
        select!.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await vi.waitFor(() => {
        expect(host.querySelector("#membership-success-alert")?.textContent).toContain("User role updated to admin");
      });

      const patchCall = fetcher.mock.calls.find(([url, init]) => String(url).includes("/code/members/user-bob") && init?.method === "PATCH");
      expect(patchCall).toBeTruthy();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("C5a.L0610.03: displays structured denial reason with error code and explanation message", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/code/members")) {
        return json({
          members: [
            {
              companyId: "comp-1",
              userId: "user-sole-owner",
              role: "owner",
              revision: 4,
              createdAt: "2026-10-17T00:00:00Z",
              updatedAt: "2026-10-17T01:00:00Z",
            },
          ],
          roles: ["owner", "admin", "member", "readonly"],
        });
      }
      if (url.includes("/code/members/user-sole-owner") && init?.method === "PATCH") {
        return json(
          {
            error: {
              code: "last_owner_protected",
              message: "Cannot demote or remove the last remaining owner of the company",
              details: { action: "code.membership.role_change" },
            },
          },
          403,
        );
      }
      throw new Error("Unexpected request: " + url);
    });
    vi.stubGlobal("fetch", fetcher);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<CodeMembershipPanel companyId="comp-1" isUk={false} />);
      });

      await vi.waitFor(() => {
        expect(host.querySelector("#role-select-user-sole-owner")).toBeTruthy();
      });

      const select = host.querySelector<HTMLSelectElement>("#role-select-user-sole-owner");
      await act(async () => {
        select!.value = "member";
        select!.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await vi.waitFor(() => {
        expect(host.querySelector("#membership-denial-alert")).toBeTruthy();
      });

      expect(host.querySelector("#denial-code")?.textContent).toBe("last_owner_protected");
      expect(host.querySelector("#denial-message")?.textContent).toContain("Cannot demote or remove the last remaining owner");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
