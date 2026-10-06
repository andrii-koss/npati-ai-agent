/**
 * C4b: shared SSRF policy.
 *
 * This module is the single source of truth for "may NPATI talk to this destination?":
 * scheme, port, host shape, hostname allowlist semantics and IP classification (including every
 * alternative encoding of an IPv4 literal). The sandbox egress proxy has its own small IPv4 check
 * (`publicAddress` in `sandbox-egress-proxy.mjs`) because that file runs inside the proxy image and
 * cannot import application code; the test suite asserts that both agree on a broad address corpus so
 * the two implementations cannot drift apart silently.
 *
 * Unknown or ambiguous encodings are always denied (fail closed).
 */

export type SsrfErrorCode =
  | "ssrf_blocked_scheme"
  | "ssrf_blocked_port"
  | "ssrf_blocked_private_ip"
  | "ssrf_blocked_credentials"
  | "host_not_allowed"
  | "invalid_url"
  | "invalid_host"
  | "dns_resolution_failed"
  // Client-side transport outcomes (raised by `ssrf-safe-http`):
  | "dns_rebinding_detected"
  | "too_many_redirects"
  | "response_too_large"
  | "request_timeout";

export class SsrfPolicyError extends Error {
  readonly status: "error" = "error";
  readonly code: SsrfErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: SsrfErrorCode, message: string, options: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "SsrfPolicyError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 403;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON() {
    return { status: this.status, code: this.code, httpStatus: this.httpStatus, retryable: this.retryable, message: this.message, details: this.details };
  }
}

/** Schemes NPATI is ever allowed to speak. Everything else (file, gopher, ftp, data, ...) is denied. */
export const ALLOWED_SCHEMES = ["http:", "https:"] as const;
/** Default allowed ports; 22 is opt-in for allowlisted git hosts only. */
export const DEFAULT_ALLOWED_PORTS = [80, 443] as const;

/**
 * Normalizes a host value coming from a URL, a header or a model-provided string:
 * lower-cases, strips a single trailing dot, converts IDN to punycode and rejects anything with
 * whitespace, control characters or an empty label.
 */
export function normalizeHostInput(value: string): string {
  if (typeof value !== "string") throw new SsrfPolicyError("invalid_host", "Host must be a string");
  const trimmed = value.trim();
  if (!trimmed) throw new SsrfPolicyError("invalid_host", "Host is empty");
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) throw new SsrfPolicyError("invalid_host", "Host contains whitespace or control characters");
  const withoutDot = trimmed.replace(/\.$/, "");
  const lowered = withoutDot.toLowerCase();
  if (!lowered) throw new SsrfPolicyError("invalid_host", "Host is empty");
  let ascii: string;
  try {
    ascii = new URL(`http://${lowered.includes(":") && !lowered.startsWith("[") ? `[${lowered}]` : lowered}`).hostname;
  } catch {
    throw new SsrfPolicyError("invalid_host", "Host is not a valid hostname");
  }
  const bare = ascii.replace(/^\[/, "").replace(/\]$/, "");
  if (!bare || bare.includes("..")) throw new SsrfPolicyError("invalid_host", "Host is not a valid hostname");
  return bare;
}

/**
 * True when any dotted part uses a leading zero (`08`, `010`, `0177`), which different resolvers read
 * as decimal or as octal. Such literals are ambiguous and are therefore denied outright rather than
 * interpreted: `010.0.0.1` is octal 8 (= public) for one resolver and decimal 10 (= private) for
 * another, so interpreting it could let a private target through.
 */
export function hasAmbiguousLeadingZero(text: string): boolean {
  return text.split(".").some((part) => /^0[0-9]+$/i.test(part));
}

/** True when the text is an IPv4/IPv6 literal in any of the encodings we must recognise. */
export function looksLikeIpLiteral(text: string): boolean {
  return /^[0-9a-fx.:\[\]]+$/i.test(text) && (/^\[/.test(text) || /^[0-9]/.test(text) || text.includes(":"));
}

/**
 * Parses an IPv4 literal written as dotted quad, shortened form (`127.1`), decimal (`2130706433`),
 * hexadecimal (`0x7f000001`, `0x7f.1`) or octal (`0177.0.0.1`). Returns the four octets or undefined
 * when the text is not a valid IPv4 literal.
 */
export function parseIpv4Literal(text: string): number[] | undefined {
  const raw = text.trim();
  if (!raw || !/^[0-9a-fx.]+$/i.test(raw)) return undefined;
  const parts = raw.split(".");
  if (parts.length === 0 || parts.length > 4) return undefined;
  const octets: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (part === "") return undefined;
    let value: number;
    if (/^0x[0-9a-f]+$/i.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^[0-9]+$/.test(part)) {
      // Ambiguous leading zero ("08"): decimal 8 in some resolvers, an invalid octal in others. The
      // contract is fail closed, so such a literal is not a usable IPv4 address and is denied.
      if (part.length > 1 && part.startsWith("0")) return undefined;
      value = Number.parseInt(part, 10);
    } else return undefined;
    if (!Number.isFinite(value) || value < 0) return undefined;
    const isLast = index === parts.length - 1;
    if (isLast) {
      // inet_aton semantics: the trailing part fills all remaining octets.
      const remaining = 4 - octets.length;
      const max = 256 ** remaining;
      if (value >= max) return undefined;
      for (let shift = remaining - 1; shift >= 0; shift -= 1) octets.push(Math.floor(value / 256 ** shift) % 256);
    } else {
      if (value > 255) return undefined;
      octets.push(value);
    }
  }
  return octets.length === 4 ? octets : undefined;
}

/** Expands an IPv6 literal (with optional embedded IPv4) into eight 16-bit groups, or undefined. */
export function parseIpv6Literal(text: string): number[] | undefined {
  let raw = text.trim().replace(/^\[/, "").replace(/\]$/, "");
  const zone = raw.indexOf("%");
  if (zone >= 0) raw = raw.slice(0, zone);
  if (!raw.includes(":")) return undefined;
  const embedded = raw.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const octets = parseIpv4Literal(embedded[2]!);
    if (!octets) return undefined;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    raw = `${embedded[1]}${high}:${low}`;
  }
  const halves = raw.split("::");
  if (halves.length > 2) return undefined;
  const parseGroups = (value: string) => (value === "" ? [] : value.split(":").map((group) => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return Number.NaN;
    return Number.parseInt(group, 16);
  }));
  const head = parseGroups(halves[0]!);
  const tail = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if ([...head, ...tail].some((group) => Number.isNaN(group))) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function forbiddenIpv4(octets: number[]): boolean {
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 175 && c === 48) return true; // AS112
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function forbiddenIpv6(groups: number[]): boolean {
  const [g0, g1] = groups as [number, number];
  const allZero = groups.every((group) => group === 0);
  if (allZero) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:0:0/96) and IPv4-translated (::ffff:0:0:0/96) forms: classify the embedded v4.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const octets = [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff];
    return forbiddenIpv4(octets);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2002) return true; // 6to4 (can embed private v4)
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // NAT64 well-known prefix
  return false;
}

/**
 * Classifies an IP literal (any supported encoding). Returns true when the address must never be
 * reached. Anything that cannot be parsed is treated as forbidden.
 */
export function isForbiddenIp(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  if (text.includes(":")) {
    const groups = parseIpv6Literal(text);
    if (!groups) return true;
    return forbiddenIpv6(groups);
  }
  if (hasAmbiguousLeadingZero(text)) return true;
  const octets = parseIpv4Literal(text);
  if (!octets) return true;
  return forbiddenIpv4(octets);
}

/** Canonical dotted-quad form of an IP literal, or undefined when it is not a valid literal. */
export function canonicalIp(value: string): string | undefined {
  const text = value.trim();
  if (text.includes(":")) {
    const groups = parseIpv6Literal(text);
    if (!groups) return undefined;    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
    }
    return groups.map((group) => group.toString(16)).join(":");
  }
  if (hasAmbiguousLeadingZero(text)) return undefined;
  const octets = parseIpv4Literal(text);
  return octets ? octets.join(".") : undefined;
}

/**
 * Strict allowlist semantics for host patterns:
 * - an exact entry matches only itself;
 * - `*.example.com` matches exactly one extra label (`a.example.com`) and never `example.com`,
 *   `a.b.example.com`, `example.com.attacker.net` or `evil.example.com.attacker.net`;
 * - a bare `*` entry is rejected outright.
 */
export function isHostnameAllowed(host: string, allowlist: readonly string[]): boolean {
  const target = normalizeHostInput(host);
  for (const entry of allowlist) {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === "*") continue;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2).replace(/\.$/, "");
      if (!suffix || suffix.includes("*") || target.length <= suffix.length + 1) continue;
      if (!target.endsWith(`.${suffix}`)) continue;
      const label = target.slice(0, target.length - suffix.length - 1);
      if (!label || label.includes(".")) continue;
      return true;
    }
    if (pattern.includes("*")) continue;
    if (target === pattern.replace(/\.$/, "")) return true;
  }
  return false;
}

export interface SsrfPolicyOptions {
  /** Hostname allowlist; an empty allowlist denies every host. */
  allowlist?: readonly string[];
  allowedPorts?: readonly number[];
  /** Extra ports permitted for allowlisted hosts only (for example 22 for git over SSH). */
  privilegedPorts?: readonly number[];
}

export interface ParsedDestination {
  url: URL;
  host: string;
  port: number;
  isIpLiteral: boolean;
}

/** Parses and validates scheme, credentials, port and host shape (no DNS yet). */
export function parseDestination(input: string, options: SsrfPolicyOptions = {}): ParsedDestination {
  // Reject ambiguous literals *before* the WHATWG parser normalizes them: `http://010.0.0.1/` is
  // octal 8 for some resolvers and decimal 10 for others, so it must never be interpreted at all.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(input.trim())?.[1];
  if (authority) {
    const hostPart = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
    const hostOnly = (hostPart.startsWith("[") ? hostPart.slice(0, hostPart.indexOf("]") + 1) : hostPart.split(":")[0]!).replace(/^\[|\]$/g, "");
    if (hasAmbiguousLeadingZero(hostOnly)) {
      throw new SsrfPolicyError("ssrf_blocked_private_ip", "Ambiguous numeric host literal is not allowed", { details: { host: hostOnly } });
    }
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfPolicyError("invalid_url", "Not a valid absolute URL");
  }
  if (!(ALLOWED_SCHEMES as readonly string[]).includes(url.protocol)) {
    throw new SsrfPolicyError("ssrf_blocked_scheme", `Scheme ${url.protocol} is not allowed`, { details: { scheme: url.protocol } });
  }
  if (url.username || url.password) {
    throw new SsrfPolicyError("ssrf_blocked_credentials", "URLs containing credentials are not allowed");
  }
  const host = normalizeHostInput(url.hostname);
  const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const privilegedPorts = options.privilegedPorts ?? [];
  if (!allowedPorts.includes(port)) {
    const privilegedAllowed = privilegedPorts.includes(port) && isHostnameAllowed(host, options.allowlist ?? []);
    if (!privilegedAllowed) {
      throw new SsrfPolicyError("ssrf_blocked_port", `Port ${port} is not allowed`, { details: { port } });
    }
  }
  const isIpLiteral = canonicalIp(host) !== undefined;
  if (isIpLiteral) {
    if (isForbiddenIp(host)) {
      throw new SsrfPolicyError("ssrf_blocked_private_ip", "Private, loopback or reserved addresses are blocked", { details: { host, ip: canonicalIp(host) } });
    }
    // A literal destination still has to satisfy the host allowlist when one is configured.
    if ((options.allowlist ?? []).length > 0 && !isHostnameAllowed(host, options.allowlist ?? [])) {
      throw new SsrfPolicyError("host_not_allowed", "Destination host is not in the allowlist", { details: { host } });
    }
  } else if (!(options.allowlist ?? []).length) {
    throw new SsrfPolicyError("host_not_allowed", "No hostname allowlist is configured, so no host is reachable");
  } else if (!isHostnameAllowed(host, options.allowlist ?? [])) {
    throw new SsrfPolicyError("host_not_allowed", "Destination host is not in the allowlist", { details: { host } });
  }
  if (!host.includes(".") && !isIpLiteral) {
    throw new SsrfPolicyError("host_not_allowed", "Single-label hostnames are not allowed", { details: { host } });
  }
  return { url, host, port, isIpLiteral };
}

export type ResolverPort = (host: string) => Promise<string[]>;

/** Resolves the host and validates **every** returned address (fail closed on any private result). */
export async function resolveAndValidate(
  destination: ParsedDestination,
  resolve: ResolverPort,
): Promise<{ addresses: string[]; ip: string }> {
  if (destination.isIpLiteral) {
    const ip = canonicalIp(destination.host)!;
    return { addresses: [ip], ip };
  }
  let addresses: string[];
  try {
    addresses = await resolve(destination.host);
  } catch (error) {
    throw new SsrfPolicyError("dns_resolution_failed", `DNS resolution failed for ${destination.host}`, {
      httpStatus: 502, retryable: true, details: { host: destination.host, reason: error instanceof Error ? error.message : String(error) },
    });
  }
  const usable = addresses.map((address) => address.trim()).filter(Boolean);
  if (!usable.length) {
    throw new SsrfPolicyError("dns_resolution_failed", `No addresses for ${destination.host}`, { httpStatus: 502, retryable: true });
  }
  for (const address of usable) {
    if (isForbiddenIp(address)) {
      throw new SsrfPolicyError("ssrf_blocked_private_ip", "The hostname resolves to a private or reserved address", {
        details: { host: destination.host, address: canonicalIp(address) ?? address },
      });
    }
  }
  return { addresses: usable, ip: usable[0]! };
}

export interface SafeUrlValidatorLike {
  validate(value: string): Promise<URL>;
  validateRedirect(initialUrl: string, finalUrl?: string): Promise<void>;
}

/**
 * Adapter that exposes this policy through the `SafeUrlValidator` shape used by the web-research
 * package, so the hardened policy can be injected instead of the package's lighter default.
 */
export function createSafeUrlValidatorAdapter(options: SsrfPolicyOptions & { resolve?: ResolverPort } = {}): SafeUrlValidatorLike {
  const resolve: ResolverPort = options.resolve ?? (async (host) => {
    const { lookup } = await import("node:dns/promises");
    const entries = await lookup(host, { all: true, verbatim: true });
    return entries.map((entry) => entry.address);
  });
  return {
    async validate(value: string) {
      const destination = parseDestination(value, options);
      await resolveAndValidate(destination, resolve);
      return destination.url;
    },
    async validateRedirect(initialUrl: string, finalUrl?: string) {
      const initial = parseDestination(initialUrl, options);
      await resolveAndValidate(initial, resolve);
      if (finalUrl) {
        const final = parseDestination(finalUrl, options);
        await resolveAndValidate(final, resolve);
      }
    },
  };
}
