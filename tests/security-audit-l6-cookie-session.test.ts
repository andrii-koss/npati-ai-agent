import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { NpatiBackendAuthProvider, createMockNpatiJwt } from "../apps/agent-api/src/auth";
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE, csrfFailure, registerBrowserSessionCookies } from "../apps/agent-api/src/browser-session";

/**
 * Security audit 2026-11-24, L6 stage 2: the browser session is an HttpOnly cookie. A token-issuing response to a
 * browser never carries the token in its body (an XSS calling the endpoint gets no credential); cookie-authenticated
 * unsafe requests need the double-submit CSRF header; non-browser clients keep receiving tokens as before.
 */
const secret = "cookie-session-test-jwt-secret-0123456789abcdef";
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });
const jwt = () => createMockNpatiJwt({ userId: "cookie-user" }, secret);

function tokenApp() {
  const app = Fastify();
  registerBrowserSessionCookies(app);
  app.post("/auth/installation/session", async () => ({ success: true, data: { accessToken: jwt(), user: { id: "cookie-user" } } }));
  app.post("/auth/refresh", async () => ({ success: true, tokens: { accessToken: jwt(), refreshToken: "refresh-secret" }, data: { tokens: { accessToken: jwt(), refreshToken: "refresh-secret" } } }));
  return app;
}
const setCookies = (headers: Record<string, unknown>) => ([] as string[]).concat((headers["set-cookie"] as string | string[] | undefined) ?? []);

describe("L6 stage 2: token-issuing responses", () => {
  it("a browser request gets HttpOnly cookies and a body without any token", async () => {
    const app = tokenApp();
    try {
      const response = await app.inject({ method: "POST", url: "/auth/installation/session", headers: { origin: "http://localhost:3000", host: "localhost:3000" } });
      const body = response.json() as { data: Record<string, unknown> };
      expect(JSON.stringify(body)).not.toMatch(/eyJ/);
      expect(body.data).toMatchObject({ user: { id: "cookie-user" }, session: { mode: "cookie" } });
      const cookies = setCookies(response.headers);
      expect(cookies.find((c) => c.startsWith(`${ACCESS_COOKIE}=`))).toMatch(/HttpOnly; SameSite=Lax/);
      expect(cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`))).not.toMatch(/HttpOnly/);
    } finally { await app.close(); }
  });

  it("a refresh token goes into an HttpOnly cookie scoped to /api/auth", async () => {
    const app = tokenApp();
    try {
      const response = await app.inject({ method: "POST", url: "/auth/refresh", headers: { origin: "http://localhost:3000", host: "localhost:3000" } });
      expect(response.body).not.toContain("refresh-secret");
      expect(setCookies(response.headers).find((c) => c.startsWith(`${REFRESH_COOKIE}=`))).toMatch(/Path=\/api\/auth; HttpOnly; SameSite=Strict/);
    } finally { await app.close(); }
  });

  it("a non-browser client (no Origin) still receives tokens in the body", async () => {
    const app = tokenApp();
    try {
      const response = await app.inject({ method: "POST", url: "/auth/installation/session" });
      expect((response.json() as { data: { accessToken?: string } }).data.accessToken).toMatch(/^eyJ/);
      expect(setCookies(response.headers)).toHaveLength(0);
    } finally { await app.close(); }
  });
});

describe("L6 stage 2: cookie authentication and CSRF", () => {
  const provider = () => new NpatiBackendAuthProvider({ jwtSecret: secret, workspaceStore: { initialize: async () => undefined } as never });
  const request = (method: string, headers: Record<string, string>) => ({ method, url: "/companies", headers, query: {} }) as never;
  const cookieHeader = (csrf = "csrf-value-123") => `${ACCESS_COOKIE}=${jwt()}; ${CSRF_COOKIE}=${csrf}`;

  it("a GET authenticates from the HttpOnly cookie", async () => {
    await expect(provider().authenticate(request("GET", { cookie: cookieHeader() }))).resolves.toMatchObject({ userId: "cookie-user" });
  });

  it("an unsafe request needs the CSRF header that matches the cookie", async () => {
    await expect(provider().authenticate(request("POST", { cookie: cookieHeader() }))).rejects.toMatchObject({ status: 403, code: "CSRF_TOKEN_REQUIRED" });
    await expect(provider().authenticate(request("POST", { cookie: cookieHeader(), "x-csrf-token": "other" }))).rejects.toMatchObject({ code: "CSRF_TOKEN_MISMATCH" });
    await expect(provider().authenticate(request("POST", { cookie: cookieHeader(), "x-csrf-token": "csrf-value-123", origin: "http://localhost:3000", host: "localhost:3000" })))
      .resolves.toMatchObject({ userId: "cookie-user" });
  });

  it("a foreign Origin is refused even with a matching CSRF value", () => {
    process.env.NODE_ENV = "production";
    expect(csrfFailure({ method: "POST", headers: { origin: "https://evil.example", host: "app.example.com", cookie: `${CSRF_COOKIE}=x`, "x-csrf-token": "x" } } as never)).toBe("CSRF_ORIGIN_MISMATCH");
    expect(csrfFailure({ method: "POST", headers: { origin: "https://app.example.com", host: "app.example.com", cookie: `${CSRF_COOKIE}=x`, "x-csrf-token": "x" } } as never)).toBeNull();
  });

  it("the page's session marker is never a credential; the cookie behind it is", async () => {
    const marker = "Bearer npati-cookie-session:0123456789abcdef";
    await expect(provider().authenticate(request("GET", { authorization: marker }))).rejects.toMatchObject({ status: 401 });
    await expect(provider().authenticate(request("GET", { authorization: marker, cookie: cookieHeader() }))).resolves.toMatchObject({ userId: "cookie-user" });
  });

  it("a Bearer header (CLI, API clients) needs no CSRF header", async () => {
    await expect(provider().authenticate(request("POST", { authorization: `Bearer ${jwt()}` }))).resolves.toMatchObject({ userId: "cookie-user" });
  });
});
