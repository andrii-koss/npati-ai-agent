import { isIP } from "node:net";
import { DataStudioError } from "./data-studio/identifier";

/** Static preflight only; the existing egress proxy still validates DNS, IPs and every destination. */
export function assertSandboxProjectApiUrl(value: string, serviceBinding = false): void {
  let url: URL;
  try { url = new URL(value); } catch { throw configurationError(); }
  const host = url.hostname.toLowerCase();
  if (serviceBinding && url.href === "http://project-api.npati.internal/") return;
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".")
    || /(^|\.)(localhost|local|internal)$/.test(host)
    || /(^|[.-])(postgres|postgresql|database|redis|metadata)([.-]|$)/.test(host)
    || url.port) throw configurationError();
}
function configurationError(): DataStudioError {
  return new DataStudioError(503, "gateway",
    "Project API URL is incompatible with sandbox egress. Configure an existing reachable HTTP(S) hostname on port 80/443; loopback, private services and database access remain blocked.",
    false, "PROJECT_API_UNREACHABLE_CONFIGURATION");
}
