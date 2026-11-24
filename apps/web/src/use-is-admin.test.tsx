// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => "token" }));

let root: Root;
let host: HTMLDivElement;
let permissions: string[] = [];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: { permissions } }), { status: 200 })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function open(path: string) {
  const { AdminOnly } = await import("./use-is-admin");
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings" element={<p>settings home</p>} />
          <Route path="/settings/connections" element={<AdminOnly><p>server health</p></AdminOnly>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return host.textContent;
}

it("sends an ordinary account from an administrator page back to Settings", async () => {
  permissions = ["workspace:read", "workspace:write", "business:manage", "chat:use"];
  expect(await open("/settings/connections")).toBe("settings home");
});

it("opens the page for the installation owner and for NPATI administrators", async () => {
  permissions = ["workspace:read", "owner"];
  expect(await open("/settings/connections")).toBe("server health");
  vi.resetModules();
  permissions = ["workspace:read", "admin:all"];
  expect(await open("/settings/connections")).toBe("server health");
});

it("recognises administrator permissions exactly as the server does", async () => {
  const { hasAdminPermission } = await import("./use-is-admin");
  expect(hasAdminPermission(["*"])).toBe(true);
  expect(hasAdminPermission(["owner"])).toBe(true);
  expect(hasAdminPermission(["admin:all"])).toBe(true);
  expect(hasAdminPermission(["workspace:write", "business:manage", "audit:read"])).toBe(false);
  expect(hasAdminPermission(undefined)).toBe(false);
});
