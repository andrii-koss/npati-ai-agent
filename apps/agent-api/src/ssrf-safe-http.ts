import http from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import {
  SsrfPolicyError, parseDestination, resolveAndValidate,
  type ParsedDestination, type ResolverPort, type SsrfPolicyOptions,
} from "./ssrf-policy";

/**
 * C4b: one SSRF-safe HTTP client for every NPATI-side outbound request.
 *
 * Guarantees:
 * - the client resolves DNS itself and validates **every** returned address before connecting;
 * - the connection is **pinned** to the validated IP, so a second lookup cannot swap in a private
 *   address between the check and the socket (DNS rebinding); TLS keeps the original hostname for SNI
 *   and certificate validation;
 * - **every** redirect is re-validated in full (scheme, host, allowlist, DNS, IP, port) and counts
 *   against the same redirect budget;
 * - `Authorization`, `Cookie` and `Proxy-Authorization` are dropped when a redirect leaves the host;
 * - response size and total time are bounded, with a streaming abort when a limit is exceeded.
 *
 * Both the resolver and the transport are injected ports, so tests never touch the network.
 */

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);

export interface SsrfTransportRequest {
  url: URL;
  /** Pinned, already validated address. */
  ip: string;
  /** Hostname used for the `Host` header and TLS SNI/certificate validation. */
  servername: string;
  method: string;
  headers: Record<string, string>;
  /** Optional request body; forwarded to the pinned connection. */
  body?: string | Uint8Array;
  signal: AbortSignal;
}

export interface SsrfTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array> | Readable;
}

export type SsrfTransportPort = (request: SsrfTransportRequest) => Promise<SsrfTransportResponse>;

export interface SsrfFetchOptions extends SsrfPolicyOptions {
  phase?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Resolution cache TTL; keeps the validated answer for a short window (default 30s). */
  resolutionCacheTtlMs?: number;
  resolve?: ResolverPort;
  transport?: SsrfTransportPort;
  now?: () => number;
}

export interface SsrfFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  bytes: number;
  redirects: Array<{ from: string; to: string; status: number }>;
  resolvedIp: string;
  finalUrl: string;
  decision: { allowed: true; host: string; phase?: string };
}

/**
 * The production DNS resolver: the lookup the shared SSRF policy uses. Exported so a caller that must run the
 * same validation (the C13 hook webhook transport, which goes through the webhook destination policy) uses
 * **this** resolver instead of writing a second one.
 */
export function defaultResolver(): ResolverPort {
  return async (host: string) => {
    const { lookup } = await import("node:dns/promises");
    const entries = await lookup(host, { all: true, verbatim: true });
    return entries.map((entry) => entry.address);
  };
}

/** Node transport: connects to the pinned IP while preserving Host/SNI. */
export function createNodeTransport(): SsrfTransportPort {
  return (request) => new Promise<SsrfTransportResponse>((resolve, reject) => {
    const client = request.url.protocol === "https:" ? https : http;
    const port = request.url.port ? Number.parseInt(request.url.port, 10) : request.url.protocol === "https:" ? 443 : 80;
    const outgoing = client.request({
      protocol: request.url.protocol,
      host: request.ip,
      port,
      method: request.method,
      path: `${request.url.pathname}${request.url.search}`,
      headers: { ...request.headers, host: request.servername },
      servername: request.url.protocol === "https:" ? request.servername : undefined,
      signal: request.signal,
      // Pin the socket to the address we validated; never let Node resolve again.
      lookup: (_hostname, _options, callback) => callback(null, request.ip, request.ip.includes(":") ? 6 : 4),
    } as http.RequestOptions, (response) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === "string") headers[key.toLowerCase()] = value;
        else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(", ");
      }
      resolve({ status: response.statusCode ?? 0, headers, body: response });
    });
    outgoing.on("error", reject);
    if (request.body) outgoing.write(request.body);
    outgoing.end();
  });
}

async function readBounded(stream: AsyncIterable<Uint8Array> | Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new SsrfPolicyError("response_too_large", `Response exceeded ${maxBytes} bytes`, { httpStatus: 413, details: { maxBytes } });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function resolveRedirect(current: URL, location: string): string {
  try {
    return new URL(location, current).toString();
  } catch {
    throw new SsrfPolicyError("invalid_url", "Redirect location is not a valid URL", { httpStatus: 502 });
  }
}

/**
 * Performs a single request with the full SSRF policy applied to the target and to every redirect.
 */
export async function ssrfSafeFetch(input: string, options: SsrfFetchOptions = {}): Promise<SsrfFetchResult> {
  const allowlist = options.allowlist ?? [];
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const cacheTtlMs = options.resolutionCacheTtlMs ?? 30_000;
  const resolve = options.resolve ?? defaultResolver();
  const transport = options.transport ?? createNodeTransport();
  const now = options.now ?? (() => Date.now());
  const policy: SsrfPolicyOptions = { allowlist, allowedPorts: options.allowedPorts, privilegedPorts: options.privilegedPorts };

  // Per-call resolution cache: a host validated once in this chain keeps the same pinned address.
  const pinnedByHost = new Map<string, { ip: string; expiresAt: number }>();
  const resolvePinned = async (destination: ParsedDestination): Promise<string> => {
    if (destination.isIpLiteral) return (await resolveAndValidate(destination, resolve)).ip;
    const cached = pinnedByHost.get(destination.host);
    if (cached && cached.expiresAt > now()) return cached.ip;
    const { ip } = await resolveAndValidate(destination, resolve);
    if (cached && cached.expiresAt > now() && cached.ip !== ip) {
      throw new SsrfPolicyError("dns_rebinding_detected", "The hostname resolved to a different address inside the pinning window", {
        details: { host: destination.host, first: cached.ip, second: ip },
      });
    }
    pinnedByHost.set(destination.host, { ip, expiresAt: now() + cacheTtlMs });
    return ip;
  };

  let current = input;
  let redirects: Array<{ from: string; to: string; status: number }> = [];
  let headers: Record<string, string> = { ...(options.headers ?? {}) };
  let redirectCount = 0;

  for (;;) {
    const destination = parseDestination(current, policy);
    const ip = await resolvePinned(destination);

    const controller = new AbortController();
    let timer: NodeJS.Timeout;
    const timeoutError = new SsrfPolicyError("request_timeout", `Request exceeded ${timeoutMs} ms`, { httpStatus: 504, retryable: true });
    // The deadline is enforced by the client itself, not only through the abort signal, so a transport
    // that ignores the signal (or stalls before writing) can never hang the caller.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(timeoutError); reject(timeoutError); }, timeoutMs);
    });
    let response: SsrfTransportResponse;
    try {
      response = await Promise.race([
        transport({
          url: destination.url,
          ip,
          servername: destination.host,
          method: options.method ?? "GET",
          headers,
          body: options.body,
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (error) {
      clearTimeout(timer!);
      if (error instanceof SsrfPolicyError) throw error;
      if (controller.signal.aborted) throw timeoutError;
      throw new SsrfPolicyError("dns_resolution_failed", `Transport failed: ${error instanceof Error ? error.message : String(error)}`, { httpStatus: 502, retryable: true });
    }

    const location = response.headers.location;
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) {
      let body: Buffer;
      try {
        body = await readBounded(response.body, maxBytes);
      } finally {
        clearTimeout(timer!);
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        headers: response.headers,
        body,
        bytes: body.length,
        redirects,
        resolvedIp: ip,
        finalUrl: destination.url.toString(),
        decision: { allowed: true, host: destination.host, phase: options.phase },
      };
    }

    // Drain the redirect body so the socket is released, then re-validate the next hop in full.
    try {
      for await (const _chunk of response.body as AsyncIterable<Uint8Array>) { void _chunk; break; }
    } catch { /* the body of a redirect is irrelevant */ }
    clearTimeout(timer!);

    if (redirectCount >= maxRedirects) {
      throw new SsrfPolicyError("too_many_redirects", `More than ${maxRedirects} redirects`, { httpStatus: 502, details: { maxRedirects, redirects } });
    }
    const next = resolveRedirect(destination.url, location);
    const nextDestination = parseDestination(next, policy);
    if (nextDestination.host !== destination.host) {
      headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase())));
    }
    redirects = [...redirects, { from: destination.url.toString(), to: next, status: response.status }];
    redirectCount += 1;
    current = next;
  }
}
