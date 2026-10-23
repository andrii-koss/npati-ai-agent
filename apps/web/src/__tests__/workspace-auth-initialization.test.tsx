// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ token: null as string | null, isLoading: true }));
vi.mock("../AuthContext", () => ({ useAuth: () => auth, getStoredAuthToken: () => auth.token }));
import { WorkspaceProvider, useWorkspace } from "../business-workspace-shared";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); auth.token = null; auth.isLoading = true; document.body.innerHTML = ""; });
it("waits for sign-in restoration, then loads workspace with the restored token", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ businesses: [], companies: [], currentBusiness: null })));
  vi.stubGlobal("fetch", fetch);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  cleanup = () => act(async () => root.unmount());
  function View() { const { loading, overview } = useWorkspace(); return <div>{overview ? "ready" : loading ? "loading" : "unavailable"}</div>; }
  const render = () => act(async () => { root.render(<WorkspaceProvider><View /></WorkspaceProvider>); });
  await render(); expect(fetch).not.toHaveBeenCalled();
  auth.isLoading = false; await render(); expect(fetch).not.toHaveBeenCalled();
  auth.token = "restored-test-token"; await render();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]).toEqual(["/api/workspace/context", expect.objectContaining({ headers: { authorization: "Bearer restored-test-token" } })]);
  expect(host.textContent).toBe("ready");
});
