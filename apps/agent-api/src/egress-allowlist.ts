import type { NetworkPhase } from "./network-activity";
import { hasAdminPermission } from "./code-rbac";

/**
 * C4b: the single source of truth for the sandbox egress hostname allowlist.
 *
 * The enforcement probe (`sandbox-egress-enforcement.ts`), the sandbox provider and the egress
 * proxy (`sandbox-egress-proxy.mjs`, which reads `ALLOWED_HOSTS`) must all read this module, so an
 * operator cannot end up with two different policies. Phases are explicit: dependency fetching may
 * reach registries, execution may reach configured git hosts, and the build phase has **no network
 * at all**.
 *
 * Entries are operator configuration until C5a: the mutating methods below already enforce
 * owner/admin rights and write to the tamper-evident AuditLog before anything changes, but they are
 * deliberately not exposed over HTTP yet — `TODO(C5a): expose behind approval + RBAC routes`.
 */

export type EgressNetworkPhase = Exclude<NetworkPhase, "tool"> | "build";
export type ConfigurableEgressPhase = "install" | "run";

export interface EgressAllowlistConfig {
  install: string[];
  run: string[];
}

export interface EgressDecision {
  allowed: boolean;
  host: string;
  phase: EgressNetworkPhase;
  code?: string;
  matchedPattern?: string;
}

export class EgressDeniedError extends Error {
  readonly code: string;
  readonly httpStatus = 403;
  readonly retryable = false;
  constructor(code: string, message: string) {
    // The code is part of the message so logs and assertions can rely on either form.
    super(`[${code}] ${message}`);
    this.name = "EgressDeniedError";
    this.code = code;
  }
}

export class EgressAllowlistError extends Error {
  readonly code: string;
  readonly httpStatus = 400;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "EgressAllowlistError";
    this.code = code;
  }
}

/**
 * Official package registries are the conservative default for the install phase. This is the
 * approved set: no extra vendor mirrors and no broad wildcards. Anything beyond it is added by the
 * operator through configuration (and, from C5a, through RBAC + approval + AuditLog).
 */
export const DEFAULT_INSTALL_ALLOWLIST: readonly string[] = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "repo.packagist.org",
  "repo.maven.apache.org",
  "plugins.gradle.org",
  "pub.dev",
] as const;

/**
 * The run phase defaults to **deny all** (owner decision): git hosts and every other destination are
 * added explicitly by the operator per project or company.
 * TODO(C5a): add hosts through RBAC + approval + AuditLog and scope them per project/company.
 */
export const DEFAULT_RUN_ALLOWLIST: readonly string[] = [] as const;

/**
 * Localhost, metadata and NPATI-internal service names are never allowed, even when an operator adds
 * them explicitly. Exported so the webhook destination policy reuses exactly this set.
 */
export const EGRESS_FORBIDDEN_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "169.254.169.254",
  "postgres",
  "postgres-projects",
  "agent-api",
  "sandbox-runner",
  "egress",
]);

const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
/**
 * Encoded IPv4 forms: a single all-digits label (integer form such as `2130706433`), any dotted
 * form whose octets are not plain decimal (octal `0177.0.0.1`, overflowed octets, extra labels) and
 * hex/octal integers. A legitimate hostname can never be made of digits and dots only.
 */
const ENCODED_IPV4_PATTERN = /^(0x[0-9a-f]+|0[0-7]+|\d+|[0-9.]+)$/i;
const IPV6_PATTERN = /^\[?[0-9a-f:]+\]?$/i;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?))*$/;
const WILDCARD_PATTERN = /^\*\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const FORBIDDEN_HOSTS = EGRESS_FORBIDDEN_HOSTS;

/**
 * Validates one allowlist entry. Rejects anything that is not a plain hostname: schemes, paths,
 * ports, credentials, `*` on its own, IP literals in every documented encoding (dotted, integer,
 * hex, octal, IPv6 — including IPv4-mapped forms), non-ASCII homoglyphs, and the well-known
 * metadata/localhost names. Wildcards are only accepted as `*.domain.tld` (exactly one label).
 */
export function validateAllowlistEntry(raw: unknown): string {
  if (typeof raw !== "string") throw new EgressAllowlistError("invalid_allowlist_entry", "Allowlist entries must be strings");
  const value = raw.trim().toLowerCase();
  if (!value) throw new EgressAllowlistError("invalid_allowlist_entry", "Allowlist entries must not be empty");
  if (value === "*") throw new EgressAllowlistError("invalid_allowlist_entry", "A bare wildcard is not allowed");
  if (/[^\x20-\x7e]/.test(value)) throw new EgressAllowlistError("invalid_allowlist_entry", "Allowlist entries must be ASCII hostnames (no homoglyphs)");
  if (value.includes("://") || value.includes("/") || value.includes("@") || value.includes("?") || value.includes("#")) {
    throw new EgressAllowlistError("invalid_allowlist_entry", "Allowlist entries must be hostnames without scheme, path or credentials");
  }
  if (/:\d+$/.test(value)) throw new EgressAllowlistError("invalid_allowlist_entry", "Allowlist entries must not carry a port");
  const bare = value.startsWith("*.") ? value.slice(2) : value;
  if (IPV4_PATTERN.test(bare) || ENCODED_IPV4_PATTERN.test(bare)) {
    throw new EgressAllowlistError("invalid_allowlist_entry", "IP literals are not allowed in the allowlist");
  }
  if (bare.includes(":") || IPV6_PATTERN.test(bare) && bare.includes(":")) {
    throw new EgressAllowlistError("invalid_allowlist_entry", "IPv6 literals are not allowed in the allowlist");
  }
  if (FORBIDDEN_HOSTS.has(bare)) throw new EgressAllowlistError("invalid_allowlist_entry", "Localhost and metadata hosts are not allowed");
  if (value.startsWith("*.")) {
    if (!WILDCARD_PATTERN.test(value)) throw new EgressAllowlistError("invalid_allowlist_entry", "Wildcards are only allowed as *.domain.tld");
    return value;
  }
  if (!HOSTNAME_PATTERN.test(value)) throw new EgressAllowlistError("invalid_allowlist_entry", "Not a valid hostname");
  return value;
}

/** Normalises a hostname that is being requested (not an allowlist entry). */
export function normalizeRequestHost(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new EgressDeniedError("egress_invalid_host", "Missing host");
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (/[^\x20-\x7e]/.test(value)) throw new EgressDeniedError("egress_invalid_host", "Host must be ASCII");
  if (value.includes("://") || value.includes("/") || value.includes("@")) {
    throw new EgressDeniedError("egress_invalid_host", "Host must be a plain hostname");
  }
  return value;
}

/** True when the requested host is an address literal rather than a DNS name. */
export function isAddressLiteral(raw: unknown): boolean {
  const value = String(raw ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return false;
  if (IPV4_PATTERN.test(value)) return true;
  if (ENCODED_IPV4_PATTERN.test(value)) return true;
  if (value.includes(":")) return true;
  return false;
}

/**
 * Matches a requested host against an allowlist. Exact hosts match exactly; `*.domain.tld` matches
 * **one** label only, so `a.domain.tld` matches while `domain.tld`, `a.b.domain.tld` and
 * `evil.domain.tld.attacker.com` do not.
 */
export function matchEgressHost(host: string, patterns: readonly string[]): string | null {
  const value = normalizeRequestHost(host);
  for (const pattern of patterns) {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".domain.tld"
      if (!value.endsWith(suffix)) continue;
      const label = value.slice(0, value.length - suffix.length);
      if (label && !label.includes(".")) return pattern;
      continue;
    }
    if (value === pattern) return pattern;
  }
  return null;
}

export interface EgressAllowlistOptions {
  install?: readonly string[];
  run?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the effective allowlist. The install phase defaults to the official registries, the run
 * phase to the configured git hosts; operator configuration is **additive** and validated, so a
 * typo cannot silently open a wildcard.
 */
export function resolveEgressAllowlist(options: EgressAllowlistOptions = {}): EgressAllowlistConfig {
  const env = options.env ?? process.env;
  const fromEnv = (name: string): string[] =>
    (env[name] ?? "").split(",").map((item) => item.trim()).filter(Boolean).map(validateAllowlistEntry);
  const install = dedupe([...(options.install ?? DEFAULT_INSTALL_ALLOWLIST), ...fromEnv("NPATI_SANDBOX_EGRESS_ALLOWLIST_INSTALL")]);
  const run = dedupe([...(options.run ?? DEFAULT_RUN_ALLOWLIST), ...fromEnv("NPATI_SANDBOX_EGRESS_ALLOWLIST_RUN")]);
  return { install, run };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
}

/** The build phase performs no network access at all, so it never has an allowlist. */
export function resolveAllowlistForPhase(phase: EgressNetworkPhase, config: EgressAllowlistConfig): string[] {
  if (phase === "build") return [];
  return phase === "install" ? [...config.install] : [...config.run];
}

export function allowsNetworkForPhase(phase: EgressNetworkPhase): boolean {
  return phase !== "build";
}

/** Full decision for one request: phase, host shape, address literals and allowlist match. */
export function evaluateEgressRequest(input: { host: string; phase: EgressNetworkPhase; config: EgressAllowlistConfig }): EgressDecision {
  const phase = input.phase;
  if (!allowsNetworkForPhase(phase)) return { allowed: false, host: String(input.host ?? ""), phase, code: "egress_phase_has_no_network" };
  let host: string;
  try {
    host = normalizeRequestHost(input.host);
  } catch {
    return { allowed: false, host: String(input.host ?? ""), phase, code: "egress_invalid_host" };
  }
  const list = resolveAllowlistForPhase(phase, input.config);
  if (!list.length) return { allowed: false, host, phase, code: "egress_allowlist_empty" };
  if (isAddressLiteral(host)) return { allowed: false, host, phase, code: "egress_address_literal_denied" };
  if (FORBIDDEN_HOSTS.has(host)) return { allowed: false, host, phase, code: "egress_host_not_allowed" };
  const matched = matchEgressHost(host, list);
  if (!matched) return { allowed: false, host, phase, code: "egress_host_not_allowed" };
  return { allowed: true, host, phase, matchedPattern: matched };
}

export function assertEgressAllowed(input: { host: string; phase: EgressNetworkPhase; config: EgressAllowlistConfig }): EgressDecision {
  const decision = evaluateEgressRequest(input);
  if (!decision.allowed) throw new EgressDeniedError(decision.code ?? "egress_host_not_allowed", `Egress denied for ${decision.host} (${decision.phase})`);
  return decision;
}

/** The exact value the existing proxy consumes (`ALLOWED_HOSTS`), so both read one policy. */
export function toProxyAllowedHosts(config: EgressAllowlistConfig, phases: readonly ConfigurableEgressPhase[] = ["install", "run"]): string {
  const hosts = phases.flatMap((phase) => resolveAllowlistForPhase(phase, config).map((entry) => entry.replace(/^\*\./, "")));
  return dedupe(hosts).join(",");
}

export interface EgressAllowlistActor {
  userId: string;
  permissions: string[];
}

export interface EgressAllowlistAudit {
  record(context: unknown, input: {
    companyId: string;
    actor: string;
    actorRole: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    decision: "allowed" | "denied" | "approved" | "rejected";
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface EgressAllowlistManagerOptions {
  companyId: string;
  config?: EgressAllowlistConfig;
  audit?: EgressAllowlistAudit;
  env?: NodeJS.ProcessEnv;
}

function isAdmin(actor: EgressAllowlistActor): boolean {
  return hasAdminPermission(actor.permissions);
}

/**
 * Allowlist administration. Until C5a the effective allowlist comes from operator configuration;
 * these methods exist so C5a can expose them over HTTP with approval, and they already enforce the
 * two invariants that matter: only owner/admin may change the list, and the change is written to
 * the AuditLog **before** it is applied (an audit outage refuses the change).
 *
 * TODO(C5a): expose behind approval + RBAC routes (`network-routes.ts` reads state only today).
 */
export class EgressAllowlistManager {
  private config: EgressAllowlistConfig;
  private readonly audit?: EgressAllowlistAudit;
  private readonly companyId: string;

  constructor(options: EgressAllowlistManagerOptions) {
    this.companyId = options.companyId;
    this.audit = options.audit;
    this.config = options.config ?? resolveEgressAllowlist({ env: options.env });
  }

  getAllowlist(): EgressAllowlistConfig {
    return { install: [...this.config.install], run: [...this.config.run] };
  }

  resolveForPhase(phase: EgressNetworkPhase): string[] {
    return resolveAllowlistForPhase(phase, this.config);
  }

  evaluate(input: { host: string; phase: EgressNetworkPhase }): EgressDecision {
    return evaluateEgressRequest({ host: input.host, phase: input.phase, config: this.config });
  }

  proxyAllowedHosts(): string {
    return toProxyAllowedHosts(this.config);
  }

  async addHost(actor: EgressAllowlistActor, host: string, phase: ConfigurableEgressPhase): Promise<EgressAllowlistConfig> {
    const entry = validateAllowlistEntry(host);
    return this.mutate(actor, "egress_allowlist.add", phase, entry, "add");
  }

  async removeHost(actor: EgressAllowlistActor, host: string, phase: ConfigurableEgressPhase): Promise<EgressAllowlistConfig> {
    const entry = validateAllowlistEntry(host);
    if (!this.config[phase].includes(entry)) throw new EgressAllowlistError("allowlist_entry_absent", `${entry} is not present in the ${phase} allowlist`);
    return this.mutate(actor, "egress_allowlist.remove", phase, entry, "remove");
  }

  private async mutate(actor: EgressAllowlistActor, action: string, phase: ConfigurableEgressPhase, entry: string, operation: "add" | "remove"): Promise<EgressAllowlistConfig> {
    if (!isAdmin(actor)) throw new EgressDeniedError("egress_allowlist_admin_required", "Only an owner or admin may change the egress allowlist");
    // Fail closed: the journal is written before the change, so an audit outage leaves the policy untouched.
    if (!this.audit) throw new EgressDeniedError("audit_unavailable", "The egress allowlist cannot be changed without the audit journal");
    await this.audit.record({}, {
      companyId: this.companyId,
      actor: actor.userId,
      actorRole: isAdmin(actor) ? "admin" : "user",
      action,
      resourceType: "egress_allowlist",
      resourceId: `${phase}:${entry}`,
      decision: "allowed",
      metadata: { phase, host: entry, operation },
    });
    const next = new Set(this.config[phase]);
    if (operation === "add") next.add(entry); else next.delete(entry);
    this.config = { ...this.config, [phase]: [...next].sort() };
    return this.getAllowlist();
  }
}
