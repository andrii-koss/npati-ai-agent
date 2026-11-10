// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../AuthContext";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); document.body.innerHTML = ""; });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** F5 with an access token that expired: /auth/me says 401 and the installation session decides what happens next. */
async function reloadWithExpiredToken(installationSession: () => Response | Promise<Response>) {
  localStorage.setItem("npati_agent_access_token", "expired-token");
  localStorage.setItem("npati_agent_user", JSON.stringify({ id: "u1", email: "owner@example.com", displayName: "Owner", username: "owner", role: "user" }));
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith("/api/auth/me")) return json(401, { success: false });
    if (url.endsWith("/api/auth/installation/session")) return installationSession();
    if (url.endsWith("/api/auth/installation/status")) return json(200, { success: true, data: { connected: true, deploymentType: "self_hosted" } });
    return json(200, { success: true });
  }));
  let seen: ReturnType<typeof useAuth> | undefined;
  function Probe() { seen = useAuth(); return null; }
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<AuthProvider><Probe /></AuthProvider>); });
  for (let i = 0; i < 10 && seen?.isLoading; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  return { calls, seen: seen! };
}

describe("reloading the app while the access token has expired", () => {
  it.each([
    ["a server error", () => json(503, { success: false, error: { code: "NPATI_BACKEND_UNAVAILABLE" } })],
    ["a rate limit", () => json(429, { success: false })],
    ["a failed request", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("keeps the session and this browser's installation cookie after %s", async (_label, answer) => {
    const { calls, seen } = await reloadWithExpiredToken(answer);
    expect(calls.some(url => url.endsWith("/api/auth/installation/browser-logout"))).toBe(false);
    expect(seen.user?.email).toBe("owner@example.com");
    expect(localStorage.getItem("npati_agent_user")).toContain("owner@example.com");
  });

  it("takes the new token when the installation session answers", async () => {
    const { seen } = await reloadWithExpiredToken(() => json(200, { success: true, data: { accessToken: "fresh-token", user: { id: "u1", email: "owner@example.com" } } }));
    expect(seen.token).toBe("fresh-token");
    expect(localStorage.getItem("npati_agent_access_token")).toBe("fresh-token");
  });

  it("signs out when the installation session is refused for good", async () => {
    const { calls, seen } = await reloadWithExpiredToken(() => json(401, { success: false, error: { code: "LOCAL_SESSION_REQUIRED" } }));
    expect(calls.some(url => url.endsWith("/api/auth/installation/browser-logout"))).toBe(true);
    expect(seen.user).toBeNull();
  });
});
