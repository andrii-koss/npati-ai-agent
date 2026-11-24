import net from "node:net";
import tls from "node:tls";
import { isForbiddenIp, normalizeHostInput, canonicalIp, parseDestination, resolveAndValidate, SsrfPolicyError, type ResolverPort } from "./ssrf-policy";
import { defaultResolver, ssrfSafeFetch } from "./ssrf-safe-http";

/**
 * Security audit 2026-11-24, M2: IMAP/SMTP host and port came straight from the request, so the connection test was a
 * port scanner of every network the API is attached to (and of the Docker host via host.docker.internal), returning
 * the remote banner in its error message.
 *
 * A mail destination is now resolved once, every address is classified with the shared SSRF policy, and the socket is
 * opened to the validated address (TLS still verifies the certificate for the configured name). Public mail servers
 * are reachable on mail ports only. A self-hosted installation whose mail server lives on its own LAN may opt in with
 * NPATI_MAIL_ALLOW_PRIVATE_HOSTS=true; an NPATI-hosted (multi-tenant) installation never may.
 */
export const MAIL_PORTS: ReadonlySet<number> = new Set([25, 465, 587, 2525, 143, 993]);

export function privateMailHostsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NPATI_MAIL_ALLOW_PRIVATE_HOSTS === "true" && env.NPATI_DEPLOYMENT_TYPE !== "npati_hosted";
}

export async function resolveMailDestination(host: string, port: number, options: { resolve?: ResolverPort; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const env = options.env ?? process.env;
  const allowPrivate = privateMailHostsAllowed(env);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new SsrfPolicyError("ssrf_blocked_port", "Mail port is invalid");
  if (!allowPrivate && !MAIL_PORTS.has(port)) {
    throw new SsrfPolicyError("ssrf_blocked_port", `Mail port ${port} is not allowed; use 25, 465, 587, 2525, 143 or 993`, { details: { port } });
  }
  const name = normalizeHostInput(host);
  const literal = canonicalIp(name);
  if (!literal && !name.includes(".") && !allowPrivate) throw new SsrfPolicyError("host_not_allowed", "Single-label mail hosts are not allowed");
  const addresses = literal ? [literal] : await (options.resolve ?? defaultResolver())(name).catch(() => {
    throw new SsrfPolicyError("dns_resolution_failed", "Mail host could not be resolved", { httpStatus: 502, retryable: true });
  });
  if (!addresses.length) throw new SsrfPolicyError("dns_resolution_failed", "Mail host has no addresses", { httpStatus: 502, retryable: true });
  if (!allowPrivate && addresses.some((address) => isForbiddenIp(address))) {
    throw new SsrfPolicyError("ssrf_blocked_private_ip", "Mail host resolves to a private, loopback or reserved address");
  }
  return addresses[0]!;
}

/**
 * Security audit 2026-11-24, M1: the OAuth token endpoint is called by the server, so it gets the full SSRF policy:
 * HTTPS on port 443, every resolved address public, the connection pinned to the validated address, no redirects.
 * (The old string check let https://127.0.0.1, https://169.254.169.254 and names resolving to private addresses through,
 * and the refresh in the email worker followed redirects to plain-HTTP internal services.)
 */
export async function assertOAuthTokenEndpoint(value: string, resolve?: ResolverPort): Promise<URL> {
  const destination = parseDestination(value, { allowlist: ["*"], allowedPorts: [443] });
  if (destination.url.protocol !== "https:") throw new SsrfPolicyError("ssrf_blocked_scheme", "The OAuth token endpoint must use HTTPS");
  await resolveAndValidate(destination, resolve ?? defaultResolver());
  return destination.url;
}

export async function postOAuthTokenRequest(tokenUrl: string, body: URLSearchParams, options: { fetch?: typeof ssrfSafeFetch } = {}): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  await assertOAuthTokenEndpoint(tokenUrl);
  const response = await (options.fetch ?? ssrfSafeFetch)(tokenUrl, {
    allowlist: ["*"], allowedPorts: [443], method: "POST", maxRedirects: 0, timeoutMs: 15_000, maxBytes: 256 * 1024,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString(),
  });
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(response.body.toString("utf8")) as Record<string, unknown>; } catch { /* not JSON */ }
  return { ok: response.ok, status: response.status, json };
}

/** Opens the mail socket to the validated address; TLS keeps the configured name for SNI and certificate checks. */
export async function openMailSocket(host: string, port: number, secure: boolean): Promise<net.Socket | tls.TLSSocket> {
  const address = await resolveMailDestination(host, port);
  const servername = net.isIP(host) ? undefined : host;
  return secure
    ? tls.connect({ host: address, port, servername, rejectUnauthorized: true })
    : net.createConnection({ host: address, port });
}
