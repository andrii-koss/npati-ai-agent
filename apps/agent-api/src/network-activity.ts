import { CredentialMasker } from "./security-guardrails";

/**
 * C4b: structured Activity events for every network decision.
 *
 * The sandbox is only allowed to reach the network through the enforced egress path, so every
 * decision (allow or deny) must be provable afterwards. The event therefore carries routing facts
 * (host, port, protocol, resolved address, byte counts, duration) and **never** request content:
 * no headers, no query strings, no bodies, no credentials. Anything that looks like a secret is
 * masked defensively before the event leaves this module.
 *
 * The real run-level Activity stream and its ExecutionSnapshot arrive with C6/C6b; until then the
 * recorder fans out to an injected sink (the app logs the event with `kind: "network_decision"`),
 * exactly like the C4 tool activity events.
 */

export type NetworkPhase = "install" | "run" | "tool";
export type NetworkProtocol = "http" | "https" | "tcp" | "udp" | "icmp";
export type NetworkAction = "allow" | "deny";

export interface NetworkDecisionEvent {
  kind: "network_decision";
  /** Correlates the decision with the run/company that caused it. */
  companyId: string;
  projectId?: string;
  sessionId?: string;
  sandboxId?: string;
  /** C6b: the run and ExecutionSnapshot this connection belongs to, when the caller knows them. */
  runId?: string;
  snapshotId?: string;
  /** Tool name when the traffic was produced by a tool call. */
  tool?: string;
  phase: NetworkPhase;
  host: string;
  port?: number;
  protocol: NetworkProtocol;
  /** Address the host was pinned to; present for allow decisions and for pinning failures. */
  resolvedIp?: string;
  action: NetworkAction;
  /** Structured reason code for a denial (or a note for an allow). */
  code?: string;
  bytesIn?: number;
  bytesOut?: number;
  durationMs?: number;
  at: string;
}

export interface NetworkActivitySink {
  record(event: NetworkDecisionEvent): Promise<void> | void;
}

export interface NetworkActivitySummary {
  allowed: number;
  denied: number;
  bytesIn: number;
  bytesOut: number;
  byPhase: Record<NetworkPhase, { allowed: number; denied: number }>;
  topDeniedHosts: Array<{ host: string; count: number }>;
}

const MAX_HOST_LENGTH = 253;
const DENIED_CODES = new Set(["egress_host_not_allowed", "egress_phase_has_no_network", "egress_allowlist_empty"]);

/** Strips a query string and fragment, keeping only the path shape (never the parameters). */
export function stripQuery(value: string): string {
  const withoutFragment = value.split("#")[0] ?? "";
  return withoutFragment.split("?")[0] ?? "";
}

/**
 * Normalises an event for storage: hosts are lowercased and must be plain hostnames (no scheme, no
 * path, no port), and any free-text field is masked. This is the only path that produces an event,
 * so a secret cannot reach the log even if a caller passes one by mistake.
 */
export function redactNetworkDecision(event: Omit<NetworkDecisionEvent, "kind" | "at"> & { kind?: "network_decision"; at?: string }): NetworkDecisionEvent {
  const host = String(event.host ?? "").trim().toLowerCase().replace(/\.$/, "");
  const safeHost = host.length > MAX_HOST_LENGTH ? host.slice(0, MAX_HOST_LENGTH) : host;
  const redacted: NetworkDecisionEvent = {
    ...event,
    kind: "network_decision",
    host: safeHost,
    protocol: event.protocol,
    action: event.action === "allow" ? "allow" : "deny",
    at: event.at || new Date().toISOString(),
  };
  if (redacted.code) redacted.code = CredentialMasker.mask(String(redacted.code));
  if (redacted.tool) redacted.tool = CredentialMasker.mask(String(redacted.tool));
  if (redacted.sandboxId) redacted.sandboxId = CredentialMasker.mask(String(redacted.sandboxId));
  if (redacted.runId) redacted.runId = CredentialMasker.mask(String(redacted.runId));
  if (redacted.snapshotId) redacted.snapshotId = CredentialMasker.mask(String(redacted.snapshotId));
  if (redacted.resolvedIp) redacted.resolvedIp = CredentialMasker.mask(String(redacted.resolvedIp));
  return redacted;
}

/** Throws when an event carries anything that must never be logged. Used by the tests and by the recorder. */
export function assertNoSensitiveNetworkPayload(event: NetworkDecisionEvent): void {
  const forbidden = ["headers", "header", "body", "query", "payload", "authorization", "cookie", "token", "secret", "password", "url"];
  for (const key of Object.keys(event as unknown as Record<string, unknown>)) {
    if (forbidden.includes(key.toLowerCase())) throw new Error(`network_decision_must_not_carry:${key}`);
  }
  const serialised = JSON.stringify(event);
  if (/https?:\/\//i.test(serialised)) throw new Error("network_decision_must_not_carry_full_url");
  if (/\?[^\s"]*=/.test(serialised)) throw new Error("network_decision_must_not_carry_query");
}

export interface NetworkActivityRecorderOptions {
  sink?: NetworkActivitySink;
  /** Injected clock so tests are deterministic. */
  now?: () => Date;
  /** Hard cap on retained summaries per company to bound memory. */
  maxCompanies?: number;
}

/**
 * Records network decisions and keeps per-company counters that the network API/UI can read.
 * The recorder never mutates the caller's object and never stores request content.
 */
export class NetworkActivityRecorder {
  private readonly sink?: NetworkActivitySink;
  private readonly now: () => Date;
  private readonly maxCompanies: number;
  private readonly counters = new Map<string, NetworkActivitySummary>();
  private readonly recent: NetworkDecisionEvent[] = [];

  constructor(options: NetworkActivityRecorderOptions = {}) {
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    this.maxCompanies = options.maxCompanies ?? 500;
  }

  async record(event: Omit<NetworkDecisionEvent, "kind" | "at"> & { at?: string }): Promise<NetworkDecisionEvent> {
    const redacted = redactNetworkDecision({ ...event, kind: "network_decision", at: event.at ?? this.now().toISOString() });
    assertNoSensitiveNetworkPayload(redacted);
    this.bump(redacted);
    this.recent.push(redacted);
    if (this.recent.length > 1000) this.recent.splice(0, this.recent.length - 1000);
    if (this.sink) await this.sink.record(redacted);
    return redacted;
  }

  /** Convenience helper: turns a denial code into an event and returns a structured error payload. */
  async recordDenied(input: Omit<NetworkDecisionEvent, "kind" | "at" | "action">, code: string): Promise<NetworkDecisionEvent> {
    return this.record({ ...input, action: "deny", code });
  }

  summary(companyId: string): NetworkActivitySummary {
    return this.counters.get(companyId) ?? emptySummary();
  }

  recentEvents(companyId?: string, limit = 100): NetworkDecisionEvent[] {
    const filtered = companyId ? this.recent.filter((event) => event.companyId === companyId) : this.recent;
    return filtered.slice(Math.max(0, filtered.length - Math.max(1, Math.min(limit, 1000))));
  }

  private bump(event: NetworkDecisionEvent): void {
    const summary = this.counters.get(event.companyId) ?? emptySummary();
    if (event.action === "allow") summary.allowed += 1; else summary.denied += 1;
    summary.byPhase[event.phase].allowed += event.action === "allow" ? 1 : 0;
    summary.byPhase[event.phase].denied += event.action === "deny" ? 1 : 0;
    summary.bytesIn += Math.max(0, event.bytesIn ?? 0);
    summary.bytesOut += Math.max(0, event.bytesOut ?? 0);
    if (event.action === "deny" && event.code && DENIED_CODES.has(event.code)) {
      const existing = summary.topDeniedHosts.find((item) => item.host === event.host);
      if (existing) existing.count += 1; else summary.topDeniedHosts.push({ host: event.host, count: 1 });
      summary.topDeniedHosts.sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
      if (summary.topDeniedHosts.length > 10) summary.topDeniedHosts.length = 10;
    }
    this.counters.set(event.companyId, summary);
    if (this.counters.size > this.maxCompanies) {
      const oldest = this.counters.keys().next().value;
      if (oldest !== undefined) this.counters.delete(oldest);
    }
  }
}

export function emptySummary(): NetworkActivitySummary {
  return {
    allowed: 0, denied: 0, bytesIn: 0, bytesOut: 0,
    byPhase: { install: { allowed: 0, denied: 0 }, run: { allowed: 0, denied: 0 }, tool: { allowed: 0, denied: 0 } },
    topDeniedHosts: [],
  };
}
