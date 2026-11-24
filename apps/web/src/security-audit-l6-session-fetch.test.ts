import { describe, expect, it, vi } from "vitest";
import { installSessionFetch, isSameOriginApi, readCsrfCookie, sessionHeaders } from "./session-fetch";

/** Security audit 2026-11-24, L6 stage 2: page code never sends a credential; the HttpOnly cookie does. */
describe("L6 stage 2: session fetch wrapper", () => {
  const marker = "Bearer npati-cookie-session:00112233445566778899aabbccddeeff";

  it("removes the session marker and adds CSRF to unsafe same-origin API requests", () => {
    const post = sessionHeaders(new Headers({ authorization: marker, "content-type": "application/json" }), "POST", "csrf-1");
    expect(post.get("authorization")).toBeNull();
    expect(post.get("x-csrf-token")).toBe("csrf-1");
    expect(post.get("content-type")).toBe("application/json");
    const get = sessionHeaders(new Headers({ authorization: marker }), "GET", "csrf-1");
    expect(get.get("x-csrf-token")).toBeNull();
  });

  it("keeps a real Authorization header (API keys, CLI-style tokens)", () => {
    expect(sessionHeaders(new Headers({ authorization: "Bearer npati_live_abc" }), "POST", "c").get("authorization")).toBe("Bearer npati_live_abc");
  });

  it("only same-origin /api requests are rewritten", () => {
    expect(isSameOriginApi("/api/companies", "https://app.example.com")).toBe(true);
    expect(isSameOriginApi("https://app.example.com/api/x", "https://app.example.com")).toBe(true);
    expect(isSameOriginApi("https://api.npati.com/api/v1/auth/logout", "https://app.example.com")).toBe(false);
    expect(isSameOriginApi("/assets/app.js", "https://app.example.com")).toBe(false);
  });

  it("reads the CSRF cookie", () => {
    expect(readCsrfCookie("a=1; npati_csrf=tok%2Den; b=2")).toBe("tok-en");
    expect(readCsrfCookie("a=1")).toBeUndefined();
  });

  it("the installed wrapper rewrites API calls and leaves other origins alone", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const target = { fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init }); return new Response("{}"); }), location: { origin: "https://app.example.com" } } as unknown as typeof globalThis;
    installSessionFetch(target);
    await target.fetch("/api/companies", { method: "DELETE", headers: { authorization: marker } });
    await target.fetch("https://api.npati.com/api/v1/auth/logout", { method: "POST", credentials: "include", headers: { authorization: marker } });
    const first = new Headers(calls[0]!.init!.headers);
    expect(first.get("authorization")).toBeNull();
    expect(calls[0]!.init!.credentials).toBe("same-origin");
    expect(new Headers(calls[1]!.init!.headers).get("authorization")).toBe(marker);
    expect(calls[1]!.init!.credentials).toBe("include");
  });
});
