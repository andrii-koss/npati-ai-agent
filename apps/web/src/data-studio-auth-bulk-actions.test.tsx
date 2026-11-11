// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataStudioAuthSection } from "./DataStudioAuthSection";
import { promptModal } from "./ConfirmDialog";

vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => "test-token" }));
vi.mock("./ConfirmDialog", () => ({ promptModal: vi.fn(), confirmModal: vi.fn() }));
let root: Root, host: HTMLDivElement;
const notify = vi.fn();
const requests: { url: string; method: string; body: any }[] = [];
let count = 3;
let failId = "";
const user = (index: number) => ({ id: `user-${index}`, email: `user${index}@example.com`,
  status: "active", roles: ["user"], emailVerified: true, createdAt: "2026-11-11T10:00:00Z", lastLogin: null });
const collections: string[] = [];

beforeEach(() => {
  count = 3; failId = ""; requests.length = 0; vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const url = new URL(path, "http://localhost");
    const method = init?.method ?? "GET";
    requests.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if ((method === "DELETE" || method === "PATCH") && path.includes(`/${failId}/`) && failId) {
      return new Response(JSON.stringify({ message: "Permission denied" }), { status: 403 });
    }
    let body: unknown = { success: true };
    if (method === "GET" && url.pathname.endsWith("/users")) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      body = { users: Array.from({ length: count }, (_, index) => user(index)).slice(offset, offset + limit), total: count };
    }
    if (path.endsWith("/preview")) body = { userId: "preview", collections: [], totalAffectedRows: 0 };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function render(environment: "dev" | "prod" = "dev") {
  await act(async () => root.render(<DataStudioAuthSection companyId="company" projectId="project"
    environment={environment} collections={collections} isUk={false} notify={notify} />));
}
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => (element as HTMLElement).click());
}
const button = (text: string) => [...host.querySelectorAll("button")].find(item => item.textContent === text) ?? null;
const checkbox = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

describe("Project Authentication bulk actions", () => {
  it("selects individual users, shows a mixed header, selects the visible list and clears it", async () => {
    await render();
    expect(host.querySelector(".auth-user-bulk-toolbar")).toBeNull();
    await click(checkbox("Select user0@example.com"));
    expect(checkbox("Select displayed users")?.indeterminate).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Selected: 1");
    await click(checkbox("Select displayed users"));
    expect(checkbox("Select displayed users")?.checked).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Selected: 3");
    await click(button("Clear selection"));
    expect(checkbox("Select displayed users")?.checked).toBe(false);
    expect(host.querySelector(".auth-user-bulk-toolbar")).toBeNull();
  });

  it("selects every user beyond the server's first page and applies deduplicated roles", async () => {
    count = 105;
    await render();
    await click(checkbox("Select displayed users"));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Selected: 50");
    await click(button("Select all (105)"));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Selected: 105");
    expect(requests.some(request => request.url.includes("offset=100"))).toBe(true);
    vi.mocked(promptModal).mockResolvedValueOnce("member, editor, member");
    await click(button("Change roles"));
    const mutations = requests.filter(request => request.method === "PATCH");
    expect(mutations).toHaveLength(105);
    expect(new Set(mutations.map(request => request.url)).size).toBe(105);
    expect(mutations.every(request => JSON.stringify(request.body.roles) === '["member","editor"]')).toBe(true);
    expect(mutations.every(request => request.url.includes("/dev/auth/users/"))).toBe(true);
    expect(host.querySelector(".auth-user-bulk-toolbar")).toBeNull();
  });

  it("retains only failed users after a partially successful role change", async () => {
    failId = "user-1";
    await render();
    await click(checkbox("Select displayed users"));
    vi.mocked(promptModal).mockResolvedValueOnce("member");
    await click(button("Change roles"));
    expect(checkbox("Select user0@example.com")?.checked).toBe(false);
    expect(checkbox("Select user1@example.com")?.checked).toBe(true);
    expect(checkbox("Select user2@example.com")?.checked).toBe(false);
    expect(notify).toHaveBeenCalledWith("Completed: 2 of 3. Permission denied", "error");
  });

  it("previews deletion and never deletes without the typed confirmation", async () => {
    await render();
    await click(checkbox("Select displayed users"));
    vi.mocked(promptModal).mockResolvedValueOnce(null);
    await click(button("Delete"));
    expect(requests.filter(request => request.url.endsWith("/delete/preview"))).toHaveLength(3);
    expect(requests.filter(request => request.method === "DELETE")).toHaveLength(0);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Selected: 3");
    vi.mocked(promptModal).mockResolvedValueOnce("delete");
    await click(button("Delete"));
    const deletes = requests.filter(request => request.method === "DELETE");
    expect(deletes).toHaveLength(3);
    expect(deletes.every(request => request.body.confirmed === true)).toBe(true);
  });

  it("clears selection across environments and does not restore stale selections", async () => {
    await render();
    await click(checkbox("Select displayed users"));
    await render("prod");
    expect(host.querySelector(".auth-user-bulk-toolbar")).toBeNull();
    await render("dev");
    expect(host.querySelector(".auth-user-bulk-toolbar")).toBeNull();
  });

  it("blocks invalid roles before sending mutations", async () => {
    await render();
    await click(checkbox("Select displayed users"));
    vi.mocked(promptModal).mockResolvedValueOnce("Admin!");
    await click(button("Change roles"));
    expect(requests.some(request => request.method === "PATCH")).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("lowercase"), "error");
  });

  it("does not apply a role prompt to another environment after navigation", async () => {
    await render();
    await click(checkbox("Select displayed users"));
    let resolve!: (value: string | null) => void;
    vi.mocked(promptModal).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await click(button("Change roles"));
    expect(checkbox("Select displayed users")?.disabled).toBe(true);
    await render("prod");
    await act(async () => { resolve("admin"); });
    expect(requests.some(request => request.method === "PATCH")).toBe(false);
    expect(host.querySelector(".auth-user-bulk-toolbar")).toBeNull();
  });

  it("does not silently select a truncated or changed server list", async () => {
    count = 105;
    await render();
    await click(checkbox("Select displayed users"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ users: [], total: 105 }))));
    await click(button("Select all (105)"));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Selected: 50");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("list changed"), "error");
  });
});
