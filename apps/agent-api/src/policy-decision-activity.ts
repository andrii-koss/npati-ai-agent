import { CredentialMasker } from "./security-guardrails";

/**
 * C5: structured Activity events for every policy decision.
 *
 * A decision that allows, denies or demands an approval has to be provable afterwards, so each one
 * produces an event that answers the four questions the owner asked for: **who** acted, **what** was
 * attempted, **in which mode and under which rule**, and **with which outcome**. The event carries
 * identifiers and reasons only — never file content, never a command line, never headers or bodies —
 * and everything that could look like a secret is masked defensively before the event leaves this
 * module.
 *
 * The real run-level Activity stream and its ExecutionSnapshot arrive with C6/C6b; until then the
 * recorder fans out to an injected sink (the app logs the event with `kind: "policy_decision"`),
 * exactly like the C4 tool activity and the C4b network decision events.
 *
 * Recording is a *log*, never a gate: the PolicyEngine calls the recorder after the verdict is
 * computed and ignores recorder failures, so an observability outage can never change a security
 * decision.
 */

export type PolicyDecisionOutcome = "allow" | "deny" | "require_approval";

/** Who is acting: a user, an agent principal or a service identity. */
export type PolicyActorKind = "user" | "agent" | "service";

export interface PolicyRuleRef {
  /** Rule scope, e.g. `project`, `company`, `approval_scope`. */
  scope: string;
  /** Stable rule identifier inside that scope. */
  id: string;
}

export interface PolicyDecisionEvent {
  kind: "policy_decision";
  /** Correlates the decision with the company (and run) that caused it. */
  companyId: string;
  projectId?: string;
  sessionId?: string;
  runId?: string;
  /** The attempted capability/tool, e.g. `code.shell.exec`. */
  tool?: string;
  /** Short action label (never a full command line). */
  action: string;
  /** Session mode the decision was taken under (`plan`/`ask`/`auto_edit`/`full_auto_sandbox`). */
  mode?: string;
  /** Policy phase that produced the verdict. */
  phase: string;
  decision: PolicyDecisionOutcome;
  /** Structured denial/approval reason code. */
  code?: string;
  /** Rule that drove the decision, when one applied. */
  ruleRef?: PolicyRuleRef | null;
  actor: string;
  actorKind?: PolicyActorKind;
  agentId?: string;
  /** Set when an approval was consumed for this decision. */
  approvedBy?: string;
  approvalId?: string;
  at: string;
}

export interface PolicyDecisionSink {
  record(event: PolicyDecisionEvent): Promise<void> | void;
}

export interface PolicyDecisionSummary {
  allowed: number;
  denied: number;
  requireApproval: number;
  byPhase: Record<string, { allowed: number; denied: number; requireApproval: number }>;
  topDeniedCodes: Array<{ code: string; count: number }>;
  topRules: Array<{ rule: string; count: number }>;
}

const MAX_LABEL_LENGTH = 200;
const DENIED_CODES = new Set([
  "command_hard_denied",
  "network_enforcement_unavailable",
  "session_mode_denied",
  "project_rule_denied",
  "agent_cannot_approve",
  "approval_invalid",
  "permission_denied",
]);

/** Keys that must never appear on a decision event (content-bearing or credential-bearing). */
const FORBIDDEN_KEYS = new Set([
  "headers", "header", "body", "query", "payload", "authorization", "cookie", "token", "secret",
  "password", "url", "content", "command", "stdout", "stderr", "diff", "patch",
]);

function clip(value: string, max = MAX_LABEL_LENGTH): string {
  return value.length > max ? value.slice(0, max) : value;
}

function mask(value: string): string {
  return clip(CredentialMasker.mask(value));
}

/**
 * Normalises an event for storage. This is the only path that produces a decision event, so a secret
 * cannot reach the log even if a caller passes one by mistake.
 */
export function redactPolicyDecision(
  event: Omit<PolicyDecisionEvent, "kind" | "at"> & { kind?: "policy_decision"; at?: string },
): PolicyDecisionEvent {
  const decision: PolicyDecisionOutcome = event.decision === "allow"
    ? "allow"
    : event.decision === "require_approval" ? "require_approval" : "deny";
  const redacted: PolicyDecisionEvent = {
    kind: "policy_decision",
    companyId: String(event.companyId ?? ""),
    action: mask(String(event.action ?? "")),
    phase: mask(String(event.phase ?? "unknown")),
    decision,
    actor: mask(String(event.actor ?? "unknown")),
    at: event.at || new Date().toISOString(),
  };
  if (event.projectId) redacted.projectId = mask(String(event.projectId));
  if (event.sessionId) redacted.sessionId = mask(String(event.sessionId));
  if (event.runId) redacted.runId = mask(String(event.runId));
  if (event.tool) redacted.tool = mask(String(event.tool));
  if (event.mode) redacted.mode = mask(String(event.mode));
  if (event.code) redacted.code = mask(String(event.code));
  if (event.actorKind) redacted.actorKind = event.actorKind;
  if (event.agentId) redacted.agentId = mask(String(event.agentId));
  if (event.approvedBy) redacted.approvedBy = mask(String(event.approvedBy));
  if (event.approvalId) redacted.approvalId = mask(String(event.approvalId));
  if (event.ruleRef) {
    redacted.ruleRef = { scope: mask(String(event.ruleRef.scope)), id: mask(String(event.ruleRef.id)) };
  } else if (event.ruleRef === null) {
    redacted.ruleRef = null;
  }
  return redacted;
}

/**
 * Throws when an event carries anything that must never be logged. Used by the recorder and by the
 * tests, so a regression fails loudly instead of leaking.
 */
export function assertNoSensitivePolicyDecision(event: PolicyDecisionEvent): void {
  for (const key of Object.keys(event as unknown as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error(`policy_decision_must_not_carry:${key}`);
  }
  const serialised = JSON.stringify(event);
  if (/https?:\/\//i.test(serialised)) throw new Error("policy_decision_must_not_carry_full_url");
  if (/\?[^\s"]*=/.test(serialised)) throw new Error("policy_decision_must_not_carry_query");
}

export interface PolicyDecisionRecorderOptions {
  sink?: PolicyDecisionSink;
  /** Injected clock so tests are deterministic. */
  now?: () => Date;
  /** Hard cap on retained summaries per company to bound memory. */
  maxCompanies?: number;
  /** Hard cap on retained recent events. */
  maxEvents?: number;
}

/**
 * Records policy decisions and keeps per-company counters that the API/UI can read. The recorder
 * never mutates the caller's object and never stores content.
 */
export class PolicyDecisionRecorder {
  private readonly sink?: PolicyDecisionSink;
  private readonly now: () => Date;
  private readonly maxCompanies: number;
  private readonly maxEvents: number;
  private readonly counters = new Map<string, PolicyDecisionSummary>();
  private readonly recent: PolicyDecisionEvent[] = [];

  constructor(options: PolicyDecisionRecorderOptions = {}) {
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    this.maxCompanies = options.maxCompanies ?? 500;
    this.maxEvents = options.maxEvents ?? 1000;
  }

  async record(
    event: Omit<PolicyDecisionEvent, "kind" | "at"> & { at?: string },
  ): Promise<PolicyDecisionEvent> {
    const redacted = redactPolicyDecision({ ...event, kind: "policy_decision", at: event.at ?? this.now().toISOString() });
    assertNoSensitivePolicyDecision(redacted);
    this.bump(redacted);
    this.recent.push(redacted);
    if (this.recent.length > this.maxEvents) this.recent.splice(0, this.recent.length - this.maxEvents);
    if (this.sink) await this.sink.record(redacted);
    return redacted;
  }

  summary(companyId: string): PolicyDecisionSummary {
    return this.counters.get(companyId) ?? emptyPolicyDecisionSummary();
  }

  recentEvents(companyId?: string, limit = 100): PolicyDecisionEvent[] {
    const filtered = companyId ? this.recent.filter((event) => event.companyId === companyId) : this.recent;
    return filtered.slice(Math.max(0, filtered.length - Math.max(1, Math.min(limit, 1000))));
  }

  private bump(event: PolicyDecisionEvent): void {
    const summary = this.counters.get(event.companyId) ?? emptyPolicyDecisionSummary();
    if (event.decision === "allow") summary.allowed += 1;
    else if (event.decision === "require_approval") summary.requireApproval += 1;
    else summary.denied += 1;
    const bucket = summary.byPhase[event.phase] ?? { allowed: 0, denied: 0, requireApproval: 0 };
    if (event.decision === "allow") bucket.allowed += 1;
    else if (event.decision === "require_approval") bucket.requireApproval += 1;
    else bucket.denied += 1;
    summary.byPhase[event.phase] = bucket;
    if (event.decision === "deny" && event.code && DENIED_CODES.has(event.code)) {
      const existing = summary.topDeniedCodes.find((item) => item.code === event.code);
      if (existing) existing.count += 1; else summary.topDeniedCodes.push({ code: event.code, count: 1 });
      summary.topDeniedCodes.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
      if (summary.topDeniedCodes.length > 10) summary.topDeniedCodes.length = 10;
    }
    if (event.ruleRef) {
      const key = `${event.ruleRef.scope}:${event.ruleRef.id}`;
      const existing = summary.topRules.find((item) => item.rule === key);
      if (existing) existing.count += 1; else summary.topRules.push({ rule: key, count: 1 });
      summary.topRules.sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
      if (summary.topRules.length > 10) summary.topRules.length = 10;
    }
    this.counters.set(event.companyId, summary);
    if (this.counters.size > this.maxCompanies) {
      const oldest = this.counters.keys().next().value;
      if (oldest !== undefined) this.counters.delete(oldest);
    }
  }
}

export function emptyPolicyDecisionSummary(): PolicyDecisionSummary {
  return { allowed: 0, denied: 0, requireApproval: 0, byPhase: {}, topDeniedCodes: [], topRules: [] };
}
