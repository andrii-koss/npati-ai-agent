import type { TyposquatEcosystem } from "./code-typosquat-dataset";

/**
 * C4a: the conservative official registry allowlist.
 *
 * Only the official hosts below are trusted, by exact match or by subdomain of a listed host. There is
 * deliberately **no** wildcard support: `*`, suffix patterns and empty entries are rejected, because a
 * wildcard in a registry allowlist turns the whole supply-chain check into a formality.
 *
 * C4b requirement (not implemented here): when the egress proxy follows a redirect, the redirect target
 * must be re-validated against this same policy after DNS resolution — an allowlisted host must not be
 * able to bounce the request to an arbitrary one.
 */
export const DEFAULT_REGISTRY_ALLOWLIST: Readonly<Record<TyposquatEcosystem, readonly string[]>> = {
  npm: ["registry.npmjs.org"],
  pypi: ["pypi.org", "files.pythonhosted.org"],
  cargo: ["index.crates.io", "static.crates.io"],
  go: ["proxy.golang.org", "sum.golang.org"],
  composer: ["repo.packagist.org"],
  maven: ["repo.maven.apache.org", "plugins.gradle.org"],
};

export type RegistryAllowlist = Record<TyposquatEcosystem, string[]>;

export class RegistryAllowlistError extends Error {
  readonly status = "error" as const;
  constructor(readonly code: "invalid_allowlist_entry" | "registry_allowlist_empty" | "registry_not_allowed", message: string, readonly httpStatus = 403) {
    super(message);
    this.name = "RegistryAllowlistError";
  }
}

export function defaultRegistryAllowlist(): RegistryAllowlist {
  return Object.fromEntries(
    Object.entries(DEFAULT_REGISTRY_ALLOWLIST).map(([ecosystem, hosts]) => [ecosystem, [...hosts]]),
  ) as RegistryAllowlist;
}

/**
 * Resolution order: the shipped defaults, then the optional `NPATI_CODE_REGISTRY_ALLOWLIST` JSON
 * override **added on top of them** (an administrator can only widen the list deliberately, and never
 * with a wildcard). Invalid entries throw instead of being ignored.
 */
export function resolveRegistryAllowlist(env: NodeJS.ProcessEnv = process.env): RegistryAllowlist {
  const allowlist = defaultRegistryAllowlist();
  const override = env.NPATI_CODE_REGISTRY_ALLOWLIST;
  if (!override || !override.trim()) return allowlist;
  let parsed: unknown;
  try {
    parsed = JSON.parse(override);
  } catch (error) {
    throw new RegistryAllowlistError("invalid_allowlist_entry", `NPATI_CODE_REGISTRY_ALLOWLIST is not valid JSON: ${(error as Error)?.message ?? "parse error"}`, 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RegistryAllowlistError("invalid_allowlist_entry", "NPATI_CODE_REGISTRY_ALLOWLIST must be a JSON object of ecosystem -> hosts", 400);
  }
  for (const [ecosystem, hosts] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(ecosystem in allowlist)) throw new RegistryAllowlistError("invalid_allowlist_entry", `Unknown ecosystem "${ecosystem}" in the registry allowlist override`, 400);
    if (!Array.isArray(hosts)) throw new RegistryAllowlistError("invalid_allowlist_entry", `Allowlist for "${ecosystem}" must be an array of hosts`, 400);
    for (const host of hosts) {
      if (typeof host !== "string" || !host.trim()) throw new RegistryAllowlistError("invalid_allowlist_entry", `Empty host in the allowlist for "${ecosystem}"`, 400);
      const normalized = host.trim().toLowerCase();
      if (normalized.includes("*")) throw new RegistryAllowlistError("invalid_allowlist_entry", `Wildcards are not allowed in the registry allowlist: "${host}"`, 400);
      if (/^\.|\.$|^https?:|[/\\]/.test(normalized)) throw new RegistryAllowlistError("invalid_allowlist_entry", `Host must be a bare hostname: "${host}"`, 400);
      if (!allowlist[ecosystem as TyposquatEcosystem].includes(normalized)) allowlist[ecosystem as TyposquatEcosystem].push(normalized);
    }
  }
  return allowlist;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Exact host match or subdomain of a listed host. `registry.npmjs.org.evil.com` and `pypi.org.evil.com`
 * therefore fail, which a naive `endsWith` check would have allowed.
 */
export function isRegistryHostAllowed(ecosystem: TyposquatEcosystem, host: string, allowlist: RegistryAllowlist = defaultRegistryAllowlist()): boolean {
  const hosts = allowlist[ecosystem] ?? [];
  if (hosts.length === 0) return false;
  const candidate = normalizeHost(host);
  if (!candidate) return false;
  return hosts.some((allowed) => candidate === allowed || candidate.endsWith(`.${allowed}`));
}

/** Fail-closed assertion used before any registry request is planned. */
export function assertRegistryHostAllowed(ecosystem: TyposquatEcosystem, host: string, allowlist: RegistryAllowlist = defaultRegistryAllowlist()): void {
  const hosts = allowlist[ecosystem] ?? [];
  if (hosts.length === 0) {
    throw new RegistryAllowlistError("registry_allowlist_empty", `No registry hosts are allowlisted for "${ecosystem}"; refusing every registry operation`);
  }
  if (!isRegistryHostAllowed(ecosystem, host, allowlist)) {
    throw new RegistryAllowlistError("registry_not_allowed", `Registry host "${host}" is not allowlisted for "${ecosystem}" (allowed: ${hosts.join(", ")})`);
  }
}

export function registryAllowlistSnapshot(allowlist: RegistryAllowlist = defaultRegistryAllowlist()): RegistryAllowlist {
  return Object.fromEntries(Object.entries(allowlist).map(([ecosystem, hosts]) => [ecosystem, [...hosts]])) as RegistryAllowlist;
}
