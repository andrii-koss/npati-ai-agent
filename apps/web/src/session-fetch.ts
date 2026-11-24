import { SESSION_MARKER_PREFIX } from "./AuthContext";
import { STEP_UP_HEADER, confirmStepUp } from "./passkey-step-up";

/**
 * Security audit 2026-11-24, L6 stage 2. The session is an HttpOnly cookie, so same-origin API requests authenticate
 * without page code ever holding the credential. Page code that still builds `Authorization: Bearer <token>` holds the
 * non-secret session marker instead; this wrapper removes that header from same-origin `/api` requests (a real token in
 * a header, e.g. from an API key flow, is left alone) and adds the double-submit CSRF header to unsafe methods.
 * Requests to other origins are not touched.
 */
const CSRF_COOKIE = "npati_csrf";
const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function readCsrfCookie(cookie = typeof document === "undefined" ? "" : document.cookie): string | undefined {
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === CSRF_COOKIE) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return part.slice(index + 1).trim(); }
    }
  }
  return undefined;
}

export function isSameOriginApi(url: string, origin: string): boolean {
  try {
    const target = new URL(url, origin);
    return target.origin === origin && (target.pathname === "/api" || target.pathname.startsWith("/api/"));
  } catch {
    return false;
  }
}

/** The headers a same-origin API request should carry in cookie-session mode. */
export function sessionHeaders(headers: Headers, method: string, csrf: string | undefined): Headers {
  const next = new Headers(headers);
  const authorization = next.get("authorization");
  if (authorization && authorization.slice(7).trim().startsWith(SESSION_MARKER_PREFIX)) next.delete("authorization");
  if (!SAFE_METHODS.has(method.toUpperCase()) && csrf && !next.has(CSRF_HEADER)) next.set(CSRF_HEADER, csrf);
  return next;
}

let installed = false;
export function installSessionFetch(target: typeof globalThis = globalThis): void {
  if (installed || typeof target.fetch !== "function" || typeof target.location === "undefined") return;
  installed = true;
  const original = target.fetch.bind(target);
  target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isSameOriginApi(url, target.location.origin)) return original(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const baseHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const headers = sessionHeaders(baseHeaders, method, readCsrfCookie());
    const retryable = input instanceof Request && !init ? input.clone() : null;
    const send = (sendHeaders: Headers) => retryable
      ? original(new Request(retryable.clone(), { headers: sendHeaders, credentials: "same-origin" }))
      : original(input, { ...init, headers: sendHeaders, credentials: init?.credentials ?? "same-origin" });
    return send(headers).then((response) => stepUpIfAsked(response, headers, send, target.fetch));
  }) as typeof fetch;
}

/**
 * A sensitive action answered 403 STEP_UP_REQUIRED / PASSKEY_REQUIRED: ask for the passkey confirmation and send the
 * request once more with its single-use token. Without a confirmation the original answer is returned unchanged.
 */
async function stepUpIfAsked(response: Response, headers: Headers, send: (headers: Headers) => Promise<Response>, fetcher: typeof fetch): Promise<Response> {
  if (response.status !== 403 || headers.has(STEP_UP_HEADER) || typeof document === "undefined") return response;
  const body = await response.clone().json().catch(() => null) as { error?: { code?: string; purpose?: string } } | null;
  const code = body?.error?.code;
  if ((code !== "STEP_UP_REQUIRED" && code !== "PASSKEY_REQUIRED") || !body?.error?.purpose) return response;
  const token = await confirmStepUp(body.error.purpose, code, fetcher);
  if (!token) return response;
  const retryHeaders = new Headers(headers);
  retryHeaders.set(STEP_UP_HEADER, token);
  return send(retryHeaders);
}
