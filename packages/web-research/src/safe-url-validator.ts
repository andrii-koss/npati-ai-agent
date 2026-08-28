import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set([
  "localhost", "localhost.localdomain", "host.docker.internal", "gateway.docker.internal",
  "omniroute", "crawler", "agent-api", "web", "postgres", "redis",
  "metadata.google.internal", "metadata",
]);

function blockedIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const a = parts[0]!;
  const b = parts[1]!;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0) || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function blockedIp(address: string) {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (normalized.startsWith("::ffff:")) return blockedIpv4(normalized.slice(7));
  if (isIP(normalized) === 4) return blockedIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8");
}

export class UnsafeUrlError extends Error {
  readonly code = "UNSAFE_URL";
}

export class SafeUrlValidator {
  async validate(value: string): Promise<URL> {
    let url: URL;
    try { url = new URL(value); } catch { throw new UnsafeUrlError("Enter a valid public HTTP or HTTPS URL."); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("Only public HTTP and HTTPS URLs are allowed.");
    if (url.username || url.password) throw new UnsafeUrlError("URLs containing credentials are not allowed.");
    if (url.port && !["80", "443"].includes(url.port)) throw new UnsafeUrlError("Only standard public web ports are allowed.");
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || BLOCKED_HOSTS.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || (!hostname.includes(".") && isIP(hostname) === 0)) {
      throw new UnsafeUrlError("Private and internal network destinations are blocked.");
    }
    if (isIP(hostname)) {
      if (blockedIp(hostname)) throw new UnsafeUrlError("Private and reserved IP destinations are blocked.");
      return url;
    }
    let addresses: Array<{ address: string }>;
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new UnsafeUrlError("The public hostname could not be resolved."); }
    if (addresses.length === 0 || addresses.some((entry) => blockedIp(entry.address))) {
      throw new UnsafeUrlError("The hostname resolves to a private or reserved network.");
    }
    return url;
  }

  async validateRedirect(initialUrl: string, finalUrl?: string) {
    await this.validate(initialUrl);
    if (finalUrl) await this.validate(finalUrl);
  }
}
