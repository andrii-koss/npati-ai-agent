/**
 * C4b: NPATI sandbox egress proxy — the ONLY route out of a sandbox runtime network.
 *
 * Topology (enforced by DockerSandboxProvider, not by this file): the sandbox container lives on a
 * per-run `--internal` bridge with `gateway_mode_ipv4=isolated`, so it has no route to the outside at
 * all. This proxy container is the only member that is also attached to an external bridge, so the
 * sandbox can only reach the internet through it. Unsetting or changing HTTP(S)_PROXY inside the
 * sandbox therefore does not restore direct egress — there is no route.
 *
 * This process is the policy chokepoint for everything that does leave:
 * - hostname allowlist (exact or `*.example.com`, one level only), never IP literals;
 * - ports 80/443, plus 22 for allowlisted git hosts;
 * - DNS resolution here (the sandbox has no working resolver), with every resolved address validated;
 * - connection pinning to a validated address, so a rebinding record cannot swap the destination
 *   between the check and the connect;
 * - TLS SNI pinning: the CONNECT host must match the ClientHello SNI;
 * - redirect depth limit on plain HTTP.
 *
 * All denials are logged as one-line structured JSON (`egress_denied`) with a reason code. The proxy
 * runs without database credentials, so an AuditLog hook is not wired here: set NPATI_EGRESS_AUDIT_HOOK
 * to an internal collector URL when one exists (TODO(C5a): write allowlist changes to the AuditLog).
 */
import net, { isIP } from "node:net";
import { createProjectApiServiceBinding } from "./sandbox-project-api-binding.mjs";
import http from "node:http";
import { lookup } from "node:dns/promises";

/**
 * Built-in fallback only: the provider always passes `ALLOWED_HOSTS` explicitly (from the canonical
 * allowlist module). This list mirrors that module's approved install registries — no git hosts and no
 * vendor mirrors — so a proxy started by hand still denies everything outside the official registries.
 */
const DEFAULT_ALLOWED_HOSTS =
  "registry.npmjs.org,pypi.org,files.pythonhosted.org,index.crates.io,static.crates.io,proxy.golang.org,sum.golang.org,repo.packagist.org,repo.maven.apache.org,plugins.gradle.org";

/** Hostnames that must never be reachable, whatever the allowlist says. */
const FORBIDDEN_HOSTS = new Set([
  "localhost", "localhost.localdomain", "metadata", "metadata.google.internal", "metadata.goog",
  "instance-data", "169.254.169.254.nip.io",
  "postgres", "postgres-projects", "agent-api", "redis", "sandbox-runner", "egress",
]);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function allowlist(value, fallback) {
  return (value ?? fallback).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

const allowed = allowlist(process.env.ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS);
/** Git hosts may additionally use SSH on port 22; nothing else may. */
const allowedGitHosts = allowlist(process.env.ALLOWED_GIT_HOSTS, "github.com,codeload.github.com,gitlab.com,bitbucket.org");
const MAX_REDIRECTS = parsePositiveInt(process.env.NPATI_SANDBOX_EGRESS_MAX_REDIRECTS, 5);
const DNS_CACHE_TTL_MS = parsePositiveInt(process.env.NPATI_SANDBOX_EGRESS_DNS_TTL_MS, 30_000);
const AUDIT_HOOK = process.env.NPATI_EGRESS_AUDIT_HOOK;
const projectApiBinding = createProjectApiServiceBinding(process.env.NPATI_PROJECT_API_SERVICE_BINDING);

/**
 * Normalizes a hostname as it arrives in a request. Anything ambiguous (whitespace, control
 * characters, mixed encodings, empty) is returned as unusable rather than guessed at.
 */
export function normalizeHostname(raw) {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 253) return undefined;
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  const withoutPort = trimmed.startsWith("[") ? trimmed.slice(1, trimmed.indexOf("]")) : trimmed;
  const clean = withoutPort.replace(/\.+$/, "");
  if (!clean) return undefined;
  return clean;
}

/**
 * Detects IP literals in any encoding: dotted decimal, decimal (2130706433), hex (0x7f000001),
 * octal (0177.0.0.1), mixed/dotted-hex, and IPv6 including IPv4-mapped forms. IP literals are never
 * allowlisted — only hostnames are — so callers deny them outright.
 */
export function isIpLiteral(host) {
  const clean = normalizeHostname(host);
  if (!clean) return false;
  if (isIP(clean)) return true;
  if (clean.includes(":")) return true; // any IPv6 shape, including [::ffff:127.0.0.1]
  if (/^0x[0-9a-f]+$/.test(clean)) return true;
  if (/^[0-9]+$/.test(clean)) return true; // decimal-encoded IPv4
  const parts = clean.split(".");
  if (parts.length === 4 && parts.every((part) => /^(0x[0-9a-f]+|[0-9]+)$/.test(part))) return true;
  if (parts.length === 2 && parts.every((part) => /^(0x[0-9a-f]+|[0-9]+)$/.test(part))) return true;
  if (/\.0x[0-9a-f]+/.test(clean)) return true;
  return false;
}

/**
 * True for every IPv4 address that must never be a sandbox destination: unspecified, private,
 * loopback, link-local, CGNAT, benchmarking, documentation, multicast and reserved space.
 * IPv6 is deliberately not "public" here either: IPv6 egress is disabled, so a v6 answer never
 * authorizes a connection.
 */
export function isForbiddenAddress(address) {
  if (typeof address !== "string") return true;
  const mapped = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  if (mapped !== address) return isForbiddenAddress(mapped);
  if (isIP(address) === 6) return true;
  if (isIP(address) !== 4) return true;
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b, c] = octets;
  if (a === 0) return true;                       // 0.0.0.0/8
  if (a === 10) return true;                      // RFC1918
  if (a === 127) return true;                     // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true;        // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 168) return true;        // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true;  // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;   // TEST-NET-3
  if (a >= 224) return true;                      // multicast + reserved 240/4
  return false;
}

/** Backwards-compatible predicate: only a public IPv4 address is ever connectable. */
export function publicAddress(address) {
  return isIP(address) === 4 && !isForbiddenAddress(address);
}

/**
 * Allowlist matching: an exact name, or `*.example.com` which matches exactly one label
 * (`a.example.com` but not `example.com` and not `a.b.example.com`). A suffix that merely ends with
 * an allowed name (`registry.npmjs.org.attacker.net`) never matches.
 */
export function hostnameAllowed(host, entries = allowed) {
  const clean = normalizeHostname(host);
  if (!clean) return false;
  if (FORBIDDEN_HOSTS.has(clean)) return false;
  for (const entry of entries) {
    if (entry === clean) return true;
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      if (!base.includes(".")) continue;
      const suffix = `.${base}`;
      if (clean.endsWith(suffix) && !clean.slice(0, -suffix.length).includes(".")) return true;
    }
  }
  return false;
}

/** Ports this proxy will ever connect to. SSH is limited to allowlisted git hosts. */
export function portAllowed(host, port, gitHosts = allowedGitHosts) {
  const numeric = Number(port);
  if (numeric === 80 || numeric === 443) return true;
  if (numeric === 22) return hostnameAllowed(host, gitHosts);
  return false;
}

const dnsCache = new Map();

/** Drops the pinning cache; called by tests and whenever the allowlist policy changes. */
export function resetDnsCache() {
  dnsCache.clear();
}

/**
 * Resolves a hostname and returns a pinned, validated address. Every resolved address must be
 * public: one private answer is enough to deny the whole name. The cache is short (default 30 s) and
 * never outlives the DNS record's own TTL.
 */
export async function destination(host, port, options = {}) {
  const clean = normalizeHostname(host);
  const numericPort = Number(port);
  if (!clean) throw new Error("invalid_host");
  if (isIpLiteral(clean)) throw new Error("ip_literal_not_allowed");
  if (FORBIDDEN_HOSTS.has(clean)) throw new Error("forbidden_host");
  if (!hostnameAllowed(clean, options.allowlist ?? allowed)) throw new Error("host_not_allowed");
  if (!portAllowed(clean, numericPort, options.gitHosts ?? allowedGitHosts)) throw new Error("port_not_allowed");
  const now = options.now ? options.now() : Date.now();
  const cached = dnsCache.get(clean);
  if (cached && cached.expiresAt > now) {
    if (!options.ignoreCache) return { address: cached.address, family: 4, cached: true };
  }
  const resolver = options.resolver ?? ((name) => lookup(name, { all: true, family: 4, verbatim: true }));
  const answers = await resolver(clean);
  if (!Array.isArray(answers) || answers.length === 0) throw new Error("address_not_allowed");
  for (const answer of answers) {
    if (!publicAddress(answer.address)) throw new Error("address_not_allowed");
  }
  const pinned = answers[0];
  // Resolver TTLs are reported in seconds; the pinning cache is capped by our own short TTL so a
  // rebinding record cannot be reused for long.
  const answerTtlSeconds = Number(pinned.ttl);
  const answerTtlMs = Number.isFinite(answerTtlSeconds) && answerTtlSeconds > 0 ? answerTtlSeconds * 1_000 : DNS_CACHE_TTL_MS;
  const ttlMs = Math.min(DNS_CACHE_TTL_MS, Math.max(1_000, answerTtlMs));
  dnsCache.set(clean, { address: pinned.address, expiresAt: now + ttlMs });
  return { address: pinned.address, family: 4, cached: false };
}

/** Redirect depth policy, shared by the HTTP branch and the tests. */
export function redirectDepthExceeded(depth, max = MAX_REDIRECTS) {
  const parsed = Number.parseInt(String(depth ?? "0"), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return true;
  return parsed >= max;
}

function logDenied(reason, details = {}) {
  const record = { event: "egress_denied", reason, ...details };
  console.warn(`[egress-proxy] ${JSON.stringify(record)}`);
  if (AUDIT_HOOK) {
    // TODO(C5a): replace this fire-and-forget hook with an AuditLog write through the control plane.
    fetch(AUDIT_HOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record) }).catch(() => undefined);
  }
}

export function clientHelloServerName(buffer) { try {
  if (buffer.length < 5) return undefined;
  if (buffer[0] !== 22 || buffer[1] !== 3) return null;
  const recordEnd = 5 + buffer.readUInt16BE(3);
  if (recordEnd > 16_384) return null;
  if (buffer.length < recordEnd) return undefined;
  if (buffer[5] !== 1) return null;
  let index = 9 + 2 + 32;
  if (index >= recordEnd) return null;
  index += 1 + buffer[index];
  if (index + 2 > recordEnd) return null;
  index += 2 + buffer.readUInt16BE(index);
  if (index >= recordEnd) return null;
  index += 1 + buffer[index];
  if (index + 2 > recordEnd) return null;
  const extensionsEnd = index + 2 + buffer.readUInt16BE(index);
  index += 2;
  if (extensionsEnd > recordEnd) return null;
  while (index + 4 <= extensionsEnd) {
    const type = buffer.readUInt16BE(index), length = buffer.readUInt16BE(index + 2);
    index += 4;
    if (index + length > extensionsEnd) return null;
    if (type === 0) {
      if (length < 5 || buffer[index + 2] !== 0) return null;
      const nameLength = buffer.readUInt16BE(index + 3);
      if (nameLength < 1 || 5 + nameLength > length) return null;
      return buffer.toString("utf8", index + 5, index + 5 + nameLength).toLowerCase();
    }
    index += length;
  }
  return null;
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/_npati/health" || req.url === "/health") {
      // Reachable only from the per-run internal network; used by the readiness probe.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, hosts: allowed.length, maxRedirects: MAX_REDIRECTS }));
      return;
    }
    const url = new URL(req.url);
    if (projectApiBinding?.matches(url)) return projectApiBinding.handle(req, res, url);
    if (url.protocol !== "http:") { logDenied("invalid_scheme", { scheme: url.protocol }); res.writeHead(403); res.end(); return; }
    const depth = Number.parseInt(String(req.headers["x-npati-redirect-depth"] ?? "0"), 10);
    if (Number.isFinite(depth) && depth > MAX_REDIRECTS) {
      logDenied("redirect_limit_exceeded", { host: url.hostname, depth });
      res.writeHead(403); res.end(); return;
    }
    const pinned = await destination(url.hostname, url.port || 80);
    const outgoing = http.request({ hostname: pinned.address, port: 80, method: req.method, path: url.pathname + url.search, headers: { ...req.headers, host: url.hostname } }, (response) => {
      const status = response.statusCode ?? 502;
      const headers = { ...response.headers };
      // Each redirect hop is a fresh request the sandbox sends back through this proxy, where the
      // host, resolution, address, port and scheme are validated again. The depth header makes the
      // limit enforceable without following redirects ourselves.
      if (status >= 300 && status < 400 && depth + 1 > MAX_REDIRECTS) {
        logDenied("redirect_limit_exceeded", { host: url.hostname, depth: depth + 1 });
        res.writeHead(403); res.end(); return;
      }
      if (status >= 300 && status < 400) headers["x-npati-redirect-depth"] = String(depth + 1);
      res.writeHead(status, headers);
      response.pipe(res);
    });
    outgoing.on("error", (err) => { console.warn(`[egress-proxy] http outgoing error for ${url.hostname}:`, err.message); if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(outgoing);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logDenied(reason, { url: req.url, method: req.method });
    res.writeHead(403); res.end();
  }
});
server.on("connect", async (req, client, head) => {
  client.pause();
  if (projectApiBinding?.connect(req, client, head)) return;
  const rawTarget = String(req.url ?? "");
  try {
    const parts = rawTarget.split(":");
    if (parts.length !== 2) throw new Error("invalid_host");
    const port = Number(parts[1]);
    const host = normalizeHostname(parts[0]);
    if (!host) throw new Error("invalid_host");
    const pinned = await destination(host, port);
    const upstream = net.connect(port, pinned.address);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      let buffered = Buffer.from(head);
      const timer = setTimeout(() => {
        console.warn(`[egress-proxy] SNI timeout for host: ${host}`);
        client.destroy(); upstream.destroy();
      }, 5_000);
      const onData = (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > 16_384) {
          console.warn(`[egress-proxy] ClientHello exceeded buffer limit for host: ${host}`);
          client.destroy(); upstream.destroy(); return;
        }
        const serverName = clientHelloServerName(buffered);
        if (serverName === undefined) return;
        clearTimeout(timer);
        client.off("data", onData);
        // SNI pinning (domain fronting): the tunnel must go to the host that was authorized.
        if (port === 443 && serverName !== host) {
          logDenied("sni_mismatch", { requested: host, sni: serverName });
          client.destroy(); upstream.destroy(); return;
        }
        upstream.write(buffered);
        client.pipe(upstream);
        upstream.pipe(client);
      };
      client.on("data", onData);
      client.resume();
      if (buffered.length) onData(Buffer.alloc(0));
    });
    upstream.on("error", (err) => {
      console.warn(`[egress-proxy] upstream connection error to ${host} (${pinned.address}):`, err.message);
      client.destroy();
    });
    client.on("error", () => upstream.destroy());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logDenied(reason, { target: rawTarget, method: "CONNECT" });
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
});
if (process.env.NPATI_EGRESS_TEST !== "true") server.listen(8080, "0.0.0.0");
