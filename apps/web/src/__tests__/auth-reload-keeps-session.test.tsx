// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, getStoredAuthUser, setStoredAuthUser, useAuth } from "../AuthContext";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); document.body.innerHTML = ""; });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** F5 with an access token that expired: /auth/me says 401 and the installation session decides what happens next. */
async function reloadWithExpiredToken(installationSession: () => Response | Promise<Response>) {
  localStorage.setItem("npati_agent_session_marker", "npati-cookie-session:expired");
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
  it("keeps the stored avatar when a local fallback profile omits it", async () => {
    const stored = { id: "u1", email: "owner@example.com", displayName: "Owner", username: "owner", role: "user", avatar: "/uploads/avatar.png" };
    localStorage.setItem("npati_agent_session_marker", "npati-cookie-session:stored");
    setStoredAuthUser(stored);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(200, url.endsWith("/auth/me")
      ? { success: true, data: { user: { id: "u1", displayName: "Owner" } } }
      : { success: true, data: { connected: true, deploymentType: "self_hosted" } })));
    const avatars: Array<string | null | undefined> = [];
    function Probe() { avatars.push(useAuth().user?.avatar); return null; }
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<AuthProvider><Probe /></AuthProvider>));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(avatars.length).toBeGreaterThan(1);
    expect(avatars.every(avatar => avatar === stored.avatar)).toBe(true);
    expect(getStoredAuthUser()?.avatar).toBe(stored.avatar);
  });
  it("accepts an explicit avatar removal and does not copy an avatar to a different account", () => {
    const owner = { id: "u1", email: "owner@example.com", displayName: "Owner", username: "owner", role: "user" };
    setStoredAuthUser({ ...owner, avatar: "/uploads/avatar.png" });
    setStoredAuthUser({ ...owner, avatar: null });
    expect(getStoredAuthUser()?.avatar).toBeNull();
    setStoredAuthUser({ ...owner, avatar: "/uploads/avatar.png" });
    setStoredAuthUser({ ...owner, id: "u2" });
    expect(getStoredAuthUser()?.avatar).toBeUndefined();
  });
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

  it("takes the renewed cookie session and keeps the same session identity (audit L6 stage 2)", async () => {
    const { seen } = await reloadWithExpiredToken(() => json(200, { success: true, data: { session: { mode: "cookie", expiresAt: new Date(Date.now() + 900_000).toISOString() }, user: { id: "u1", email: "owner@example.com" } } }));
    expect(seen.token).toBe("npati-cookie-session:expired");
    expect(seen.user?.email).toBe("owner@example.com");
  });

  it("never stores a credential in page storage, even when an older server still returns one", async () => {
    await reloadWithExpiredToken(() => json(200, { success: true, data: { accessToken: "eyJ.fresh.token", user: { id: "u1", email: "owner@example.com" } } }));
    const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? "").join(" ");
    expect(stored).not.toContain("eyJ.fresh.token");
    expect(localStorage.getItem("npati_agent_session_marker")).toMatch(/^npati-cookie-session:/);
  });

  it("signs out when the installation session is refused for good", async () => {
    const { calls, seen } = await reloadWithExpiredToken(() => json(401, { success: false, error: { code: "LOCAL_SESSION_REQUIRED" } }));
    expect(calls.some(url => url.endsWith("/api/auth/installation/browser-logout"))).toBe(true);
    expect(seen.user).toBeNull();
  });
});
