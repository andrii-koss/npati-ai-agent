/**
 * C4a: dependency vulnerability audit.
 *
 * The audit itself runs **in the sandbox** through an injected runner; this module owns the command
 * selection, the parsing of the common tool formats and the commit/PR gate. If the runner is missing we
 * report `audit_unavailable` rather than assuming the tree is clean — an unknown state is never a pass.
 */
import type { DependencyManager } from "./code-deps-guard";

export type AuditSeverity = "critical" | "high" | "moderate" | "low";

export interface AuditAdvisory {
  id: string;
  package: string;
  severity: AuditSeverity;
  title: string;
  fixedIn?: string;
}

export interface AuditReport {
  manager: DependencyManager;
  parsed: boolean;
  critical: number;
  high: number;
  moderate: number;
  low: number;
  advisories: AuditAdvisory[];
  /** Present only when the format could not be parsed; already truncated for transport. */
  raw?: string;
  exitCode?: number;
}

export interface AuditRunner {
  (input: { manager: DependencyManager; command: string; lockfilePath: string }): Promise<{ exitCode: number; stdout: string; stderr?: string }>;
}

export class AuditUnavailableError extends Error {
  readonly code = "audit_unavailable";
  readonly status = 503;
  readonly retryable = true;
  constructor(message = "Dependency audit is unavailable: no sandbox audit runner is configured") {
    super(message);
    this.name = "AuditUnavailableError";
  }
}

const MAX_RAW_CHARS = 4000;
const SEVERITY_ORDER: AuditSeverity[] = ["critical", "high", "moderate", "low"];

/** Canonical command per manager; the runner executes it inside the sandbox. */
export function auditCommandFor(manager: DependencyManager): string {
  switch (manager) {
    case "npm": return "npm audit --json";
    case "pnpm": return "pnpm audit --json";
    case "yarn": return "yarn npm audit --json";
    case "pip":
    case "poetry": return "pip-audit --format json";
    case "composer": return "composer audit --format json";
    case "cargo": return "cargo audit --json";
    case "go": return "osv-scanner --format json -r .";
    default: return "osv-scanner --format json -r .";
  }
}

function normalizeSeverity(value: unknown): AuditSeverity {
  const text = String(value ?? "").toLowerCase();
  if (text.startsWith("crit")) return "critical";
  if (text.startsWith("high")) return "high";
  if (text.startsWith("mod") || text.startsWith("med")) return "moderate";
  if (text === "low" || text === "info" || text === "negligible") return "low";
  return "moderate";
}

function emptyReport(manager: DependencyManager, exitCode?: number): AuditReport {
  return { manager, parsed: false, critical: 0, high: 0, moderate: 0, low: 0, advisories: [], exitCode };
}

function summarize(manager: DependencyManager, advisories: AuditAdvisory[], exitCode?: number): AuditReport {
  const counts: Record<AuditSeverity, number> = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const advisory of advisories) counts[advisory.severity] += 1;
  return {
    manager,
    parsed: true,
    critical: counts.critical,
    high: counts.high,
    moderate: counts.moderate,
    low: counts.low,
    advisories,
    exitCode,
  };
}

function parseNpmLike(manager: DependencyManager, payload: Record<string, unknown>, exitCode?: number): AuditReport {
  const advisories: AuditAdvisory[] = [];
  const vulnerabilities = payload.vulnerabilities as Record<string, any> | undefined;
  if (vulnerabilities && typeof vulnerabilities === "object") {
    for (const [name, entry] of Object.entries(vulnerabilities)) {
      const via = Array.isArray(entry?.via) ? entry.via : [];
      const objects = via.filter((item: unknown) => item && typeof item === "object") as Array<Record<string, any>>;
      if (!objects.length) {
        // A transitive entry without details still counts, using the entry severity.
        advisories.push({ id: `npm:${name}`, package: name, severity: normalizeSeverity(entry?.severity), title: "transitive vulnerability" });
        continue;
      }
      for (const item of objects) {
        advisories.push({
          id: String(item.source ?? item.url ?? `npm:${name}`),
          package: String(item.name ?? name),
          severity: normalizeSeverity(item.severity ?? entry?.severity),
          title: String(item.title ?? "vulnerability"),
          fixedIn: typeof entry?.fixAvailable === "object" ? String(entry.fixAvailable.version ?? "") || undefined : undefined,
        });
      }
    }
    return summarize(manager, advisories, exitCode);
  }
  const legacy = payload.advisories as Record<string, any> | undefined;
  if (legacy && typeof legacy === "object") {
    for (const [id, entry] of Object.entries(legacy)) {
      advisories.push({
        id: String(entry?.id ?? id),
        package: String(entry?.module_name ?? entry?.name ?? "unknown"),
        severity: normalizeSeverity(entry?.severity),
        title: String(entry?.title ?? "advisory"),
        fixedIn: entry?.patched_versions ? String(entry.patched_versions) : undefined,
      });
    }
    return summarize(manager, advisories, exitCode);
  }
  // A valid audit report with neither `vulnerabilities` nor `advisories` means the audit ran and found
  // nothing: it is a *parsed, clean* report. Treating it as unparsed would make `shouldBlockCommit`
  // block every commit on a healthy tree. An audit that actually failed reports an `error` field, and
  // that stays unparsed (fail closed) with the raw output attached.
  const error = (payload as Record<string, unknown>).error;
  const auditFailed = error !== undefined && error !== null
    && !(typeof error === "object" && !Array.isArray(error) && Object.keys(error as object).length === 0);
  if (auditFailed) return { ...emptyReport(manager, exitCode), raw: JSON.stringify(payload).slice(0, MAX_RAW_CHARS) };
  return summarize(manager, advisories, exitCode);
}

function parsePipAudit(manager: DependencyManager, payload: unknown, exitCode?: number): AuditReport {
  const advisories: AuditAdvisory[] = [];
  const dependencies = Array.isArray(payload) ? payload : (payload as Record<string, any>)?.dependencies;
  if (!Array.isArray(dependencies)) return emptyReport(manager, exitCode);
  for (const dependency of dependencies) {
    const name = String(dependency?.name ?? "unknown");
    const vulns = Array.isArray(dependency?.vulns) ? dependency.vulns : [];
    for (const vuln of vulns) {
      advisories.push({
        id: String(vuln?.id ?? "PYSEC-UNKNOWN"),
        package: name,
        severity: normalizeSeverity(vuln?.severity),
        title: String(vuln?.description ?? vuln?.id ?? "vulnerability"),
        fixedIn: Array.isArray(vuln?.fix_versions) && vuln.fix_versions.length ? String(vuln.fix_versions[0]) : undefined,
      });
    }
  }
  return summarize(manager, advisories, exitCode);
}

function parseComposer(manager: DependencyManager, payload: Record<string, any>, exitCode?: number): AuditReport {
  const advisories: AuditAdvisory[] = [];
  const table = payload.advisories;
  if (!table || typeof table !== "object") return emptyReport(manager, exitCode);
  for (const [name, list] of Object.entries(table as Record<string, any>)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      advisories.push({
        id: String(entry?.advisoryId ?? entry?.cve ?? "composer-advisory"),
        package: name,
        severity: normalizeSeverity(entry?.severity ?? entry?.cvss?.severity),
        title: String(entry?.title ?? "advisory"),
        fixedIn: entry?.affectedVersions ? String(entry.affectedVersions) : undefined,
      });
    }
  }
  return summarize(manager, advisories, exitCode);
}

function parseCargo(manager: DependencyManager, payload: Record<string, any>, exitCode?: number): AuditReport {
  const advisories: AuditAdvisory[] = [];
  const list = payload?.vulnerabilities?.list;
  if (!Array.isArray(list)) return emptyReport(manager, exitCode);
  for (const entry of list) {
    const advisory = entry?.advisory ?? {};
    const versions = entry?.versions ?? {};
    const patched = Array.isArray(versions?.patched) && versions.patched.length ? String(versions.patched[0]) : undefined;
    advisories.push({
      id: String(advisory?.id ?? "RUSTSEC-UNKNOWN"),
      package: String(entry?.package?.name ?? "unknown"),
      severity: normalizeSeverity(advisory?.severity ?? advisory?.cvss ?? (advisory?.id ? "moderate" : "moderate")),
      title: String(advisory?.title ?? "advisory"),
      fixedIn: patched,
    });
  }
  return summarize(manager, advisories, exitCode);
}

function parseOsv(manager: DependencyManager, payload: Record<string, any>, exitCode?: number): AuditReport {
  const advisories: AuditAdvisory[] = [];
  const results = Array.isArray(payload?.results) ? payload.results : [];
  for (const result of results) {
    const packages = Array.isArray(result?.packages) ? result.packages : [];
    for (const entry of packages) {
      const name = String(entry?.package?.name ?? "unknown");
      const vulns = Array.isArray(entry?.vulnerabilities) ? entry.vulnerabilities : [];
      for (const vuln of vulns) {
        const severity = vuln?.database_specific?.severity ?? (Array.isArray(vuln?.severity) ? vuln.severity[0]?.score : undefined);
        advisories.push({
          id: String(vuln?.id ?? "OSV-UNKNOWN"),
          package: name,
          severity: normalizeSeverity(severity),
          title: String(vuln?.summary ?? vuln?.details ?? "vulnerability").slice(0, 300),
          fixedIn: Array.isArray(vuln?.affected) && vuln.affected[0]?.ranges?.[0]?.events?.find?.((event: any) => event?.fixed)?.fixed,
        });
      }
    }
  }
  return summarize(manager, advisories, exitCode);
}

/**
 * Parses the raw tool output. An unknown or malformed format degrades to a bounded raw excerpt with
 * `parsed: false` — it never throws and never claims the tree is clean.
 */
export function parseAuditReport(manager: DependencyManager, raw: string, exitCode?: number): AuditReport {
  if (typeof raw !== "string" || !raw.trim()) return emptyReport(manager, exitCode);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ...emptyReport(manager, exitCode), raw: raw.slice(0, MAX_RAW_CHARS) };
  }
  const asRecord = (value: unknown): Record<string, any> => (value && typeof value === "object" ? (value as Record<string, any>) : {});
  try {
    switch (manager) {
      case "npm":
      case "pnpm":
      case "yarn":
        return parseNpmLike(manager, asRecord(payload), exitCode);
      case "pip":
      case "poetry":
        return parsePipAudit(manager, payload, exitCode);
      case "composer":
        return parseComposer(manager, asRecord(payload), exitCode);
      case "cargo":
        return parseCargo(manager, asRecord(payload), exitCode);
      case "go":
        return parseOsv(manager, asRecord(payload), exitCode);
      default:
        return { ...emptyReport(manager, exitCode), raw: raw.slice(0, MAX_RAW_CHARS) };
    }
  } catch {
    return { ...emptyReport(manager, exitCode), raw: raw.slice(0, MAX_RAW_CHARS) };
  }
}

export interface RunDependencyAuditInput {
  manager: DependencyManager;
  lockfilePath: string;
  auditRunner?: AuditRunner;
  command?: string;
}

/** Runs the audit through the injected runner (which executes inside the sandbox). */
export async function runDependencyAudit(input: RunDependencyAuditInput): Promise<AuditReport> {
  if (!input.auditRunner) throw new AuditUnavailableError();
  const command = input.command ?? auditCommandFor(input.manager);
  const result = await input.auditRunner({ manager: input.manager, command, lockfilePath: input.lockfilePath });
  return parseAuditReport(input.manager, result.stdout, result.exitCode);
}

export interface CommitGateOptions {
  blockOn?: AuditSeverity[];
}

/**
 * Critical and high findings block an automatic commit or pull request; they may still proceed after an
 * explicit approval, which the caller obtains through the existing approval system.
 */
export function shouldBlockCommit(report: AuditReport, options: CommitGateOptions = {}): { blocked: boolean; reason?: string } {
  const blockOn = options.blockOn ?? ["critical", "high"];
  if (!report.parsed) {
    return { blocked: true, reason: `audit_output_unparsed:${report.manager}` };
  }
  const hit = SEVERITY_ORDER.filter((severity) => blockOn.includes(severity) && report[severity] > 0);
  if (!hit.length) return { blocked: false };
  const detail = hit.map((severity) => `${severity}=${report[severity]}`).join(",");
  const packages = report.advisories
    .filter((advisory) => hit.includes(advisory.severity))
    .slice(0, 5)
    .map((advisory) => `${advisory.package}(${advisory.id})`)
    .join(",");
  return { blocked: true, reason: `vulnerabilities:${detail}${packages ? `:${packages}` : ""}` };
}
