import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { domainToASCII } from "node:url";

export class ProductionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const controlToken = process.env.NPATI_PRODUCTION_TOKEN ?? "";
if (controlToken.length < 32) throw new Error("Production control token must contain at least 32 characters");
export const tlsEnabled = Boolean(process.env.NPATI_PRODUCTION_ACME_EMAIL);
export const localEnabled = process.env.NPATI_PRODUCTION_LOCAL === "true";
const validDomain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const suffix = (process.env.NPATI_PRODUCTION_DOMAIN ?? "").trim().toLowerCase();
if (suffix && (!validDomain.test(suffix) || suffix.endsWith(".localhost"))) throw new Error("Invalid production domain suffix");

export const defaults = { cpu: 1, memoryMiB: 512, requestsPerSecond: 40, concurrency: 20, bodyMiB: 4, timeoutSeconds: 20 };
const settingsRange = {
  cpu: [0.25, 4], memoryMiB: [128, 2048], requestsPerSecond: [1, 500],
  concurrency: [1, 100], bodyMiB: [1, 32], timeoutSeconds: [1, 30],
};
export const projectKey = /^[a-f0-9]{64}$/;
export const maxSnapshotBytes = 24 * 1048576;
export const maxReleaseBytes = 512 * 1048576;
export const safeFile = (name) => typeof name === "string" && name.length <= 512 && name.split("/").every(
  part => part.length > 0 && part.length <= 220 && part !== "." && part !== ".." && !/[\\:\x00-\x1f\x7f]/.test(part),
);

export function authorized(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(controlToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function automaticDomain(key) {
  return suffix ? `project-${key.slice(0, 24)}.${suffix}` : localEnabled ? `project-${key.slice(0, 24)}.localhost` : "";
}

export function domainProof(key, domain) {
  domain = normalizeDomain(domain);
  if (!validDomain.test(domain) || domain.endsWith(".localhost")) return null;
  return {
    name: `_npati-verify.${domain}`,
    value: `npati=${createHmac("sha256", controlToken).update(`${key}:${domain}`).digest("hex")}`,
  };
}

function normalizeDomain(value) {
  const host = typeof value === "string" ? value.trim().replace(/\.$/, "") : "";
  if (!host || /[\s/:@\\?#%]/u.test(host)) return "";
  return domainToASCII(host).toLowerCase();
}

export const domainsFor = settings => settings.aliasDomain ? [settings.domain, settings.aliasDomain] : [settings.domain];

export function settingsFor(key, input) {
  if (input.domain !== undefined && typeof input.domain !== "string") throw new ProductionError(400, "Enter a valid domain.");
  const host = input.domain?.trim() ? normalizeDomain(input.domain) : automaticDomain(key);
  if (!validDomain.test(host)) throw new ProductionError(400, "Enter a valid domain, or configure a default production domain.");
  const aliasDomain = normalizeDomain(input.aliasDomain);
  if (input.aliasDomain && (!validDomain.test(aliasDomain) || aliasDomain === host)) {
    throw new ProductionError(400, "Enter a valid additional domain different from the primary domain.");
  }
  const local = host.endsWith(".localhost");
  if (local && !localEnabled) throw new ProductionError(400, "Local production domains are disabled.");
  if (aliasDomain && aliasDomain.endsWith(".localhost") !== local) {
    throw new ProductionError(400, "Use two public domains or two local domains for the same project.");
  }
  const rawPath = typeof input.path === "string" ? input.path.trim() : "/";
  if (!/^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?)?$/.test(rawPath) || rawPath.length > 180) {
    throw new ProductionError(400, "Enter a path such as / or /shop.");
  }
  const port = input.port ?? 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProductionError(400, "Enter a valid application port.");
  const tls = !local && input.tls !== false;
  if (tls && !tlsEnabled) throw new ProductionError(400, "HTTPS requires a Let's Encrypt email in the self-hosted configuration.");
  const entrypoint = input.entrypoint ?? "auto";
  if (!["auto", "web", "websecure"].includes(entrypoint) || (entrypoint === "websecure" && !tls)) {
    throw new ProductionError(400, "The HTTPS-only entrypoint requires HTTPS.");
  }
  if (entrypoint === "web" && tls) throw new ProductionError(400, "Enable both entrypoints or choose the HTTPS-only entrypoint for HTTPS.");
  const limits = {};
  for (const [name, [min, max]] of Object.entries(settingsRange)) {
    const value = input.limits?.[name] ?? defaults[name];
    if (typeof value !== "number" || value < min || value > max || !Number.isFinite(value) || (name === "cpu" ? value * 4 % 1 !== 0 : !Number.isInteger(value))) {
      throw new ProductionError(400, `Invalid ${name} limit (allowed: ${min}–${max}).`);
    }
    limits[name] = value;
  }
  return { domain: host, ...(aliasDomain ? { aliasDomain, redirectAlias: input.redirectAlias !== false } : {}),
    path: rawPath.replace(/\/$/, "") || "/", stripPath: input.stripPath === true, port, tls, entrypoint, limits };
}

export function runtimeEnvironment(input, existing) {
  if (input === undefined) return existing ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 32) {
    throw new ProductionError(400, "Runtime environment must be a JSON object with up to 32 string values.");
  }
  const env = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) ||
        /^(?:NPATI_|NPM_|NODE_|LD_|UV_|PATH$|HOME$|HOST$|HOSTNAME$|PORT$|TMPDIR$|ENV$|BASH_ENV$|SHELLOPTS$)/.test(name) ||
        typeof value !== "string" || value.length > 2048 || value.includes("\0")) {
      throw new ProductionError(400, "Invalid or reserved runtime environment variable.");
    }
    env[name] = value;
  }
  return env;
}

export async function verifyDomains(key, settings, previous) {
  const verified = previous ? domainsFor(previous) : [];
  await Promise.all(domainsFor(settings).filter(domain => !verified.includes(domain)).map(domain => verifyDomain(key, domain)));
}

async function verifyDomain(key, domain) {
  if (domain.endsWith(".localhost") || domain === automaticDomain(key)) return;
  if (suffix && (domain === suffix || domain.endsWith(`.${suffix}`))) {
    throw new ProductionError(400, "That domain is reserved for automatically assigned project URLs.");
  }
  const proof = domainProof(key, domain);
  const records = await resolveTxt(proof.name).catch(() => []);
  if (!records.some(record => record.join("") === proof.value)) {
    throw new ProductionError(422, `Add the TXT record shown for ${proof.name}, then publish again.`);
  }
}

export function publicOrigin(settings) {
  const protocol = settings.tls ? "https" : "http";
  const port = Number(process.env[settings.tls ? "NPATI_PRODUCTION_HTTPS_PORT" : "NPATI_PRODUCTION_HTTP_PORT"]) || (settings.tls ? 443 : 80);
  return `${protocol}://${settings.domain}${port === (settings.tls ? 443 : 80) ? "" : `:${port}`}`;
}

export const publicUrl = settings => publicOrigin(settings) + (settings.path === "/" ? "/" : `${settings.path}/`);

export async function writeJson(path, value, mode = 0o600) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode });
  await rename(tmp, path);
}

export async function writeRoutes(directory, records) {
  const routers = {};
  const middlewares = { https: { redirectScheme: {
    scheme: "https", permanent: true, port: String(Number(process.env.NPATI_PRODUCTION_HTTPS_PORT) || 443),
  } } };
  for (const [key, { release }] of records) {
    if (!release) continue;
    const { aliasDomain, redirectAlias, path, tls, entrypoint } = release.settings;
    for (const domain of domainsFor(release.settings)) {
      const alias = domain === aliasDomain;
      const id = alias ? `${key}-alias` : key;
      const rule = "Host(`" + domain + "`)" + (path === "/" ? "" : " && (Path(`" + path + "`) || PathPrefix(`" + path + "/`))");
      const router = { rule, service: "production" };
      if (!tls) routers[id] = { ...router, entryPoints: ["web"] };
      else {
        routers[id] = { ...router, entryPoints: ["websecure"], tls: { certResolver: "npati" } };
        // Redirecting aliases can reach the canonical HTTPS URL in one hop.
        if (entrypoint !== "websecure") routers[`${id}-redirect`] = { ...router, entryPoints: ["web"],
          ...(alias && redirectAlias ? {} : { middlewares: ["https"] }) };
      }
    }
  }
  // JSON is YAML-compatible. The temporary extension is ignored by the file provider.
  await writeJson(join(directory, "projects.yml"), {
    http: { ...(Object.keys(routers).length ? { routers } : {}), middlewares, services: { production: {
      loadBalancer: { servers: [{ url: "http://production:8090" }] },
    } } },
  }, 0o644);
}
