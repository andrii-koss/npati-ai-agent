import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Security audit 2026-11-24, L6 stage 2: the browser session lives in HttpOnly cookies, not in page JavaScript.
 *
 *  - `npati_access`  HttpOnly, SameSite=Lax, Path=/            the access token (JWT) for every /api request
 *  - `npati_refresh` HttpOnly, SameSite=Strict, Path=/api/auth  a refresh token, when the sign-in method has one
 *  - `npati_csrf`    readable, SameSite=Strict, Path=/          double-submit value for unsafe methods
 *
 * A token-issuing response to a browser request (one that carries an `Origin` header, which page script can neither
 * remove nor forge) sets these cookies and has its tokens removed from the body: an XSS that calls the same endpoint
 * gets a user profile, never a credential it could take away. Non-browser clients (CLI, server to server) send no
 * Origin and keep receiving tokens in the body, as before.
 */
export const ACCESS_COOKIE = "npati_access";
export const REFRESH_COOKIE = "npati_refresh";
export const CSRF_COOKIE = "npati_csrf";
export const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_ACCESS_AGE_SECONDS = 24 * 60 * 60;
const REFRESH_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Routes whose successful JSON responses may carry tokens (browser paths, with and without /api). */
export const TOKEN_ISSUING_ROUTES: ReadonlySet<string> = new Set([
  "/auth/installation/session", "/auth/installation/poll", "/auth/login", "/auth/register", "/auth/refresh", "/auth/oidc/login",
  "/api/auth/installation/session", "/api/auth/installation/poll", "/api/auth/login", "/api/auth/register", "/api/auth/refresh", "/api/auth/oidc/login",
]);

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try { return decodeURIComponent(value); } catch { return value; }
    }
  }
  return undefined;
}

export function accessTokenFromCookie(request: Pick<FastifyRequest, "headers">): string | undefined {
  const value = readCookie(request.headers.cookie, ACCESS_COOKIE);
  return value && value.split(".").length === 3 ? value : undefined;
}

export function isBrowserRequest(request: Pick<FastifyRequest, "headers">): boolean {
  return typeof request.headers.origin === "string" && request.headers.origin.length > 0;
}

function isSecure(request: FastifyRequest): boolean {
  return request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
}

/** Seconds until the JWT expires (capped), or the cap when the token carries no readable expiry. */
export function accessTokenMaxAge(token: string, now = Date.now()): { maxAge: number; expiresAt: string } {
  let exp: number | undefined;
  try { exp = (JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number }).exp; } catch { /* opaque */ }
  const remaining = typeof exp === "number" && Number.isFinite(exp) ? Math.floor(exp - now / 1000) : MAX_ACCESS_AGE_SECONDS;
  const maxAge = Math.max(0, Math.min(MAX_ACCESS_AGE_SECONDS, remaining));
  return { maxAge, expiresAt: new Date(now + maxAge * 1000).toISOString() };
}

function cookie(name: string, value: string, attributes: string[]): string {
  return [`${name}=${encodeURIComponent(value)}`, ...attributes].join("; ");
}

/** The Set-Cookie headers for a browser session (access token, CSRF value and, when present, a refresh token). */
export function sessionCookies(request: FastifyRequest, tokens: { accessToken: string; refreshToken?: string }): { cookies: string[]; expiresAt: string } {
  const secure = isSecure(request) ? ["Secure"] : [];
  const { maxAge, expiresAt } = accessTokenMaxAge(tokens.accessToken);
  const csrf = readCookie(request.headers.cookie, CSRF_COOKIE) || randomBytes(24).toString("base64url");
  const cookies = [
    cookie(ACCESS_COOKIE, tokens.accessToken, ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...secure]),
    cookie(CSRF_COOKIE, csrf, ["Path=/", "SameSite=Strict", `Max-Age=${REFRESH_AGE_SECONDS}`, ...secure]),
  ];
  if (tokens.refreshToken) {
    cookies.push(cookie(REFRESH_COOKIE, tokens.refreshToken, ["Path=/api/auth", "HttpOnly", "SameSite=Strict", `Max-Age=${REFRESH_AGE_SECONDS}`, ...secure]));
  }
  return { cookies, expiresAt };
}

export function clearSessionCookies(request: FastifyRequest): string[] {
  const secure = isSecure(request) ? ["Secure"] : [];
  return [
    cookie(ACCESS_COOKIE, "", ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...secure]),
    cookie(REFRESH_COOKIE, "", ["Path=/api/auth", "HttpOnly", "SameSite=Strict", "Max-Age=0", ...secure]),
    cookie(CSRF_COOKIE, "", ["Path=/", "SameSite=Strict", "Max-Age=0", ...secure]),
  ];
}

export function appendSetCookies(reply: FastifyReply, cookies: string[]): void {
  const existing = reply.getHeader("set-cookie");
  const current = Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : [];
  reply.header("set-cookie", [...current, ...cookies]);
}

/**
 * CSRF for cookie-authenticated requests with an unsafe method: the Origin (when sent) must be this host or the
 * configured web origin, and the `x-csrf-token` header must equal the `npati_csrf` cookie (a cross-site page can
 * neither read that cookie nor set the header without a CORS preflight this API refuses).
 */
export function csrfFailure(request: Pick<FastifyRequest, "headers" | "method">, env: NodeJS.ProcessEnv = process.env): string | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin) {
    let host: string;
    try { host = new URL(origin).host; } catch { return "CSRF_ORIGIN_INVALID"; }
    const configured = env.NPATI_WEB_ORIGIN?.split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean) ?? [];
    // The Vite dev server proxies /api with changeOrigin, so Host is the API's while Origin is the dev server's.
    const devLoopback = env.NODE_ENV !== "production" && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
    if (host !== request.headers.host && !configured.includes(origin.replace(/\/+$/, "")) && !devLoopback) return "CSRF_ORIGIN_MISMATCH";
  }
  const expected = readCookie(request.headers.cookie, CSRF_COOKIE);
  const provided = request.headers[CSRF_HEADER];
  if (!expected || typeof provided !== "string") return "CSRF_TOKEN_REQUIRED";
  const a = Buffer.from(expected), b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b) ? null : "CSRF_TOKEN_MISMATCH";
}

type TokenBody = { success?: boolean; data?: Record<string, unknown>; tokens?: Record<string, unknown> } & Record<string, unknown>;

/** Moves tokens out of a token-issuing response into cookies for browser requests. Exported for tests. */
export function stripSessionTokens(request: FastifyRequest, reply: FastifyReply, body: TokenBody): TokenBody {
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
  const nested = (data.tokens && typeof data.tokens === "object" ? data.tokens : body.tokens && typeof body.tokens === "object" ? body.tokens : {}) as Record<string, unknown>;
  const accessToken = [data.accessToken, nested.accessToken].find((value): value is string => typeof value === "string" && value.length > 0);
  if (!accessToken) return body;
  const refreshToken = [data.refreshToken, nested.refreshToken].find((value): value is string => typeof value === "string" && value.length > 0);
  const { cookies, expiresAt } = sessionCookies(request, { accessToken, refreshToken });
  appendSetCookies(reply, cookies);
  const strip = (record: Record<string, unknown>) => {
    const { accessToken: _a, refreshToken: _r, tokens: _t, ...rest } = record;
    return rest;
  };
  const session = { mode: "cookie", expiresAt };
  const { tokens: _bodyTokens, ...bodyRest } = body;
  return { ...bodyRest, data: { ...strip(data), session } };
}

export function registerBrowserSessionCookies(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    const route = request.routeOptions?.url;
    if (!route || !TOKEN_ISSUING_ROUTES.has(route) || !isBrowserRequest(request) || reply.statusCode >= 300) return payload;
    if (typeof payload !== "string" || !payload.startsWith("{")) return payload;
    let body: TokenBody;
    try { body = JSON.parse(payload) as TokenBody; } catch { return payload; }
    const stripped = stripSessionTokens(request, reply, body);
    return stripped === body ? payload : JSON.stringify(stripped);
  });
}
