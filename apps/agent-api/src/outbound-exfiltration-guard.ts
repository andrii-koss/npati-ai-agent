/**
 * C5b: exfiltration guard for every NPATI-side outbound path.
 *
 * The provider data policy answers "may this model see this data?". This module answers the mirror
 * question: "may this data leave NPATI at all, through a non-model channel?" — web search/fetch/crawl,
 * MCP calls, email, messaging integrations and webhooks.
 *
 * Design decisions worth knowing before changing anything here:
 *
 *   1. A secret is never sent anywhere. For `email`, `webhook` and `messaging` a secret is a **deny**, not
 *      a redaction: those channels deliver to a human inbox or a third-party endpoint where a
 *      half-redacted value is still an incident, and the placeholder would leave NPATI as content.
 *      For the retrieval channels (`web_search`, `web_fetch`, `web_crawl`, `mcp`) the policy may allow
 *      redaction instead, because the call still needs to happen (an agent searching for a fix should not
 *      be blocked by a token that happens to sit in the same buffer).
 *   2. Private code leaving NPATI is an **approval**-class event, never a silent allow. A project
 *      classified `restricted` turns the same event into a deny.
 *   3. The guard is *not* a classifier of intent: it inspects bytes. Anything it cannot classify with a
 *      registered policy is refused when it is sensitive (`outbound_guard_unavailable`), so a missing
 *      wiring cannot silently exfiltrate — but a payload with nothing sensitive stays allowed, because
 *      NPATI features that never touch code must not start failing when the Coding Agent is off.
 *   4. Decision events are metadata-only by construction: `assertNoContentInOutboundDecision` throws if a
 *      caller ever puts the payload (or a secret) into the event.
 */
import { CredentialMasker } from "./security-guardrails";
import { redactSecretValue, scanTextForSecrets, type SecretFinding } from "./code-secret-scanner";
import {
  classifyContent,
  policyAllowsClassification,
  type ProviderDataClassification,
  type ProjectDataPolicyPathRule,
  type ResolvedProviderDataPolicy,
} from "./provider-data-policy";
import type { DataClassification, EffectiveDataPolicy } from "./provider-data-guard";

/** The per-call project context, forwarded to the policy resolver when the call site knows it. */
export interface OutboundPolicyContext {
  companyId?: string;
  projectId?: string;
  sessionId?: string;
  dataClassification?: DataClassification;
  /** Repository-relative paths this payload came from, for the project's path rules. */
  paths?: readonly string[];
}

/** An explicit refusal from the policy resolver — never a silent `null`. */
export interface OutboundPolicyRefusal {
  code: string;
  reason: string;
}

/** Either policy shape is accepted: the record-level resolved policy or the guard's flat effective policy. */
export type OutboundPolicyLike = ResolvedProviderDataPolicy | EffectiveDataPolicy;

export interface NormalizedOutboundPolicy {
  maxDataClassification: ProviderDataClassification;
  requiredRedactions: readonly string[];
  allowedContentTypes: readonly string[];
  providerId: string | null;
  policyVersion: number | null;
  stale: boolean;
  source: ResolvedProviderDataPolicy["source"] | null;
}

/**
 * Normalizes the two policy shapes into the few fields an outbound decision needs. The engine guard's
 * `EffectiveDataPolicy` is flat; `ResolvedProviderDataPolicy` nests the limits under `policy`. Both come
 * from the same `resolveEffectivePolicy`, so this is a shape adapter, not a second policy implementation.
 */
export function normalizeOutboundPolicy(policy: OutboundPolicyLike | null | undefined): NormalizedOutboundPolicy | null {
  if (!policy) return null;
  if ("policy" in policy && policy.policy) {
    return {
      maxDataClassification: policy.policy.maxDataClassification,
      requiredRedactions: policy.policy.requiredRedactions,
      allowedContentTypes: policy.policy.allowedContentTypes,
      providerId: policy.matchedPolicyId,
      policyVersion: policy.policyVersion,
      stale: policy.stale,
      source: policy.source,
    };
  }
  const flat = policy as EffectiveDataPolicy;
  return {
    maxDataClassification: flat.maxDataClassification as ProviderDataClassification,
    requiredRedactions: flat.requiredRedactions,
    allowedContentTypes: flat.allowedContentTypes,
    providerId: flat.providerId ?? null,
    policyVersion: typeof flat.policyVersion === "number" ? flat.policyVersion : null,
    stale: flat.stale === true,
    source: null,
  };
}

export type OutboundChannel =
  | "web_search"
  | "web_fetch"
  | "web_crawl"
  | "mcp"
  | "email"
  | "webhook"
  | "messaging";

export const OUTBOUND_CHANNELS: readonly OutboundChannel[] = [
  "web_search", "web_fetch", "web_crawl", "mcp", "email", "webhook", "messaging",
] as const;

/**
 * Channels that deliver content to a human inbox or a third-party endpoint: a secret there is an incident,
 * so the guard denies instead of redacting.
 */
export const NO_REDACTION_CHANNELS: readonly OutboundChannel[] = ["email", "webhook", "messaging"] as const;

export type OutboundContentKind = "text" | "url" | "code" | "query" | "metadata";

export interface OutboundPayloadPart {
  /** What this part is, which sets the classification floor (`code` is confidential by nature). */
  kind: OutboundContentKind;
  value: string;
  /** Optional label used in reasons/redaction counters (never the value itself). */
  label?: string;
}

export type OutboundDecision = "allow" | "require_approval" | "deny";

export interface OutboundDecisionEvent {
  kind: "outbound_decision";
  channel: OutboundChannel;
  decision: OutboundDecision;
  code: string | null;
  classification: ProviderDataClassification;
  /** Total bytes inspected. */
  bytes: number;
  parts: number;
  redactionCounts: Partial<Record<string, number>>;
  providerId?: string | null;
  policyVersion?: number | null;
  policySource?: ResolvedProviderDataPolicy["source"] | null;
  stalePolicy?: boolean;
  /** Why no policy could be evaluated, when the resolver refused. Metadata only. */
  policyRefusalCode?: string | null;
  at: string;
}

export interface InspectOutboundPayloadInput {
  channel: OutboundChannel;
  parts: readonly OutboundPayloadPart[];
  /** The resolved provider/channel policy. Absent means "nothing is registered" — see rule 3 above. */
  policy?: OutboundPolicyLike | null;
  /**
   * An explicit refusal from the policy resolver (missing context, unregistered channel, unreadable store).
   * A sensitive payload is then refused with that code instead of a generic one, so the decision trail says
   * *why* nothing could be evaluated.
   */
  policyRefusal?: OutboundPolicyRefusal | null;
  /** Per-call project context, forwarded to the resolver and used for classification/path rules. */
  context?: OutboundPolicyContext | null;
  projectClassification?: ProviderDataClassification;
  pathRules?: readonly ProjectDataPolicyPathRule[];
  /** Repository-relative paths this payload came from, used for the project's path rules. */
  paths?: readonly string[];
  /** Bytes of private content a single outbound call may carry before it needs approval. */
  privateContentApprovalBytes?: number;
  now?: Date;
}

export interface InspectOutboundPayloadResult {
  decision: OutboundDecision;
  code: string | null;
  reasons: string[];
  classification: ProviderDataClassification;
  /** Present only when the decision is `allow` and something was redacted. */
  redactedParts: OutboundPayloadPart[] | null;
  redactionCounts: Partial<Record<string, number>>;
  secretFindings: SecretFinding[];
  bytes: number;
  event: OutboundDecisionEvent;
}

/** Placeholders are stable within one call and are never valid content to write back to disk. */
export const OUTBOUND_PLACEHOLDER_PATTERN = /REDACTED:[a-z_]+_\d+/;

export function outboundPlaceholder(kind: string, index: number): string {
  return `REDACTED:${kind}_${index}`;
}

/** Used by edit/write tooling: a placeholder produced by this guard must never be persisted. */
export function containsOutboundPlaceholder(text: string): boolean {
  return typeof text === "string" && OUTBOUND_PLACEHOLDER_PATTERN.test(text);
}

export class OutboundExfiltrationError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "OutboundExfiltrationError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 403;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

const DEFAULT_PRIVATE_CONTENT_APPROVAL_BYTES = 4_096;

/**
 * Heuristics for "this looks like repository content rather than a sentence".
 *
 * Deliberately conservative: a JSON envelope such as `{"event":"build.finished"}` must **not** count as
 * private code, or every legitimate automation payload would be pushed into approval. Single stray braces,
 * semicolons or angle brackets are therefore not a signal on their own; the patterns below match
 * declarations, diffs, command lines, or a body that is dense with code punctuation **across lines**.
 */
const CODE_LIKE_PATTERNS: RegExp[] = [
  /^\s*(?:diff --git|index [0-9a-f]{7,}\.\.[0-9a-f]{7,}|@@ -\d+,\d+ \+\d+,\d+ @@)/m,
  /^\s*(?:import|export|const|let|var|function|class|def|package|public|private|SELECT|INSERT|UPDATE)\b/m,
  /\b(?:function|class|interface|struct|enum)\s+[A-Za-z_$][\w$]*\s*[({<]/,
  /(?:^|\n)\s*[+-]\s*\S.*\n\s*[+-]\s*\S/,
  /\b(?:npm|yarn|pnpm)\s+(?:run|install|test|add)\b/,
  /\b(?:git|docker|kubectl|terraform)\s+[a-z-]+/,
  /^\s*(?:public|private|protected)\s+[A-Za-z_$][\w$<>[\]]*\s+[A-Za-z_$][\w$]*\s*\(/m,
];

/** A body is code-shaped when several *lines* end like statements, not when one brace appears. */
function looksLikeCodeByDensity(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 3) return false;
  const codeish = lines.filter((line) => /[;{}(]\s*$/.test(line.trim())).length;
  return codeish >= 2 && codeish / lines.length >= 0.4;
}

export function looksLikePrivateCode(text: string): boolean {
  if (typeof text !== "string" || text.trim().length < 8) return false;
  if (CODE_LIKE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return looksLikeCodeByDensity(text);
}

function partContentType(part: OutboundPayloadPart): "code" | "web" | "prompt" {
  if (part.kind === "code") return "code";
  if (part.kind === "url") return "web";
  return "prompt";
}

function countSecretKinds(findings: readonly SecretFinding[]): Partial<Record<string, number>> {
  const counts: Partial<Record<string, number>> = {};
  for (const finding of findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  return counts;
}

function buildEvent(
  input: InspectOutboundPayloadInput,
  normalized: NormalizedOutboundPolicy | null,
  result: Omit<OutboundDecisionEvent, "kind" | "channel" | "at" | "providerId" | "policyVersion" | "policySource" | "stalePolicy" | "policyRefusalCode">,
): OutboundDecisionEvent {
  return {
    kind: "outbound_decision",
    channel: input.channel,
    at: (input.now ?? new Date()).toISOString(),
    providerId: normalized?.providerId ?? null,
    policyVersion: normalized?.policyVersion ?? null,
    policySource: normalized?.source ?? null,
    stalePolicy: normalized?.stale,
    policyRefusalCode: input.policyRefusal?.code ?? null,
    ...result,
  };
}

/**
 * Inspects one outbound payload. Pure: it decides, it never performs the call, and it never returns a
 * secret value.
 */
export function inspectOutboundPayload(input: InspectOutboundPayloadInput): InspectOutboundPayloadResult {
  const parts = input.parts ?? [];
  const reasons: string[] = [];
  const joined = parts.map((part) => part.value).join("\n");
  const bytes = Buffer.byteLength(joined, "utf8");
  const redactionCounts: Partial<Record<string, number>> = {};

  // The policy may arrive in either shape, and the per-call context (when the call site knows it) fills in
  // the project classification and paths the caller did not state explicitly.
  const normalized = normalizeOutboundPolicy(input.policy);
  const context = input.context ?? null;
  const policyRefusal = input.policyRefusal ?? null;

  const classified = classifyContent({
    contentTypes: parts.map(partContentType),
    paths: input.paths ?? context?.paths ?? [],
    pathRules: input.pathRules ?? [],
    projectClassification: input.projectClassification ?? context?.dataClassification,
  });
  const classification = classified.classification;

  const secretScan = scanTextForSecrets(joined);
  const secretCounts = countSecretKinds(secretScan.findings);
  Object.assign(redactionCounts, secretCounts);

  const codeParts = parts.filter((part) => part.kind === "code" || looksLikePrivateCode(part.value));
  const privateBytes = codeParts.reduce((total, part) => total + Buffer.byteLength(part.value, "utf8"), 0);
  const approvalBytes = input.privateContentApprovalBytes ?? DEFAULT_PRIVATE_CONTENT_APPROVAL_BYTES;

  const deny = (code: string, reason: string): InspectOutboundPayloadResult => {
    reasons.push(reason);
    return {
      decision: "deny",
      code,
      reasons,
      classification,
      redactedParts: null,
      redactionCounts,
      secretFindings: secretScan.findings,
      bytes,
      event: buildEvent(input, normalized, {
        decision: "deny", code, classification, bytes, parts: parts.length, redactionCounts,
      }),
    };
  };

  const requireApproval = (code: string, reason: string): InspectOutboundPayloadResult => {
    reasons.push(reason);
    return {
      decision: "require_approval",
      code,
      reasons,
      classification,
      redactedParts: null,
      redactionCounts,
      secretFindings: secretScan.findings,
      bytes,
      event: buildEvent(input, normalized, {
        decision: "require_approval", code, classification, bytes, parts: parts.length, redactionCounts,
      }),
    };
  };

  /**
   * A payload that could be private with no policy to judge it is refused with the resolver's **own** code,
   * so the decision trail says why nothing could be evaluated instead of reporting a generic failure.
   *
   * "Could be private" is judged by **signals**, not by the default classification: every project defaults to
   * `confidential`, so treating the default as a signal would refuse all outbound traffic whenever no run
   * context is active and break NPATI features unrelated to the Coding Agent. Secrets, code-shaped content,
   * and an explicitly stated non-public classification from the call site are the signals.
   */
  const explicitClassification = context?.dataClassification ?? input.projectClassification;
  const sensitiveWithoutPolicy = policyRefusal !== null && (
    !secretScan.clean
    || codeParts.length > 0
    || (explicitClassification !== undefined && explicitClassification !== "public")
  );
  if (sensitiveWithoutPolicy && policyRefusal) {
    return deny(policyRefusal.code, `policy_refusal:${policyRefusal.reason}`);
  }

  // 1. Secrets are absolute for the delivery channels, and for every other channel they are either
  //    redacted (when the policy allows it) or refused. A secret inside a **url** part is always refused:
  //    the URL is the request itself, so a redacted URL would either break the call or ship the rest of a
  //    live endpoint, and a token in a query string is an incident either way.
  if (!secretScan.clean) {
    const secretInUrl = parts.some((part) => part.kind === "url" && scanTextForSecrets(part.value).findings.length > 0);
    if (secretInUrl) {
      return deny("outbound_secret_denied", "secret_in_url_part");
    }
    if (NO_REDACTION_CHANNELS.includes(input.channel)) {
      return deny("outbound_secret_denied", `channel:${input.channel}:secrets_never_leave`);
    }
    if (!normalized) {
      return deny(policyRefusal?.code ?? "outbound_guard_unavailable", "no_policy_registered_for_channel");
    }
    if (!normalized.requiredRedactions.includes("secrets")) {
      return deny("outbound_secret_denied", "policy_does_not_require_secret_redaction");
    }
  }

  // 2. A project above what the channel may carry never leaves.
  if (normalized && !policyAllowsClassification(
    { maxDataClassification: normalized.maxDataClassification } as { maxDataClassification: ProviderDataClassification },
    classification,
  )) {
    return deny(
      "outbound_classification_denied",
      `classification:${classification}>max:${normalized.maxDataClassification}`,
    );
  }

  // 3. `restricted` content is deny-class on every channel; `confidential` code needs approval.
  if (classification === "restricted") {
    return deny("outbound_classification_denied", "classification:restricted_never_leaves");
  }
  if (classification === "confidential" && codeParts.length > 0) {
    return requireApproval("outbound_private_code_requires_approval", "confidential_code_outbound");
  }

  // 4. A large private payload is approval-class even when the project is only `internal`.
  if (privateBytes >= approvalBytes) {
    return requireApproval("outbound_private_content_requires_approval", `private_bytes:${privateBytes}`);
  }

  // 5. Redaction for the retrieval channels, when the scan found something and the channel allows it.
  let redactedParts: OutboundPayloadPart[] | null = null;
  if (!secretScan.clean) {
    const counters = new Map<string, number>();
    redactedParts = parts.map((part) => (scanTextForSecrets(part.value).clean
      ? part
      : { ...part, value: redactPayloadText(part.value, counters) }));
  }

  reasons.push(`classification:${classification}`);
  return {
    decision: "allow",
    code: null,
    reasons,
    classification,
    redactedParts,
    redactionCounts,
    secretFindings: secretScan.findings,
    bytes,
    event: buildEvent(input, normalized, {
      decision: "allow", code: null, classification, bytes, parts: parts.length, redactionCounts,
    }),
  };
}

/**
 * Raw value patterns used to *replace* an already-detected secret with a placeholder. They mirror the
 * scanner in `code-secret-scanner.ts`; the scanner decides whether a payload is dirty, this list only
 * decides what the placeholder replaces.
 */
const SECRET_VALUE_PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  { kind: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github_token", regex: /\b(?:ghp_|gho_)[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]{60,100}/g },
  { kind: "private_key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
  { kind: "jwt", regex: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "database_url", regex: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/gi },
  { kind: "api_key", regex: /\b(?:sk-[A-Za-z0-9_-]{20,80}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,})\b/g },
  { kind: "slack_webhook", regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{20,}/g },
  { kind: "discord_webhook", regex: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g },
];

const ENV_SECRET_LINE = /^(\s*[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(\S{8,})(\s*)$/gim;

/**
 * Replaces every detected secret with a stable placeholder. The placeholder is deliberately inert text:
 * `containsOutboundPlaceholder` lets edit/write tooling refuse to persist it, so a redacted value can never
 * be written back into a file as if it were the original content.
 */
function redactPayloadText(text: string, counters: Map<string, number>): string {
  let result = text;
  for (const { kind, regex } of SECRET_VALUE_PATTERNS) {
    result = result.replace(regex, () => {
      const index = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, index);
      return outboundPlaceholder(kind, index);
    });
  }
  result = result.replace(ENV_SECRET_LINE, (_match, prefix: string, _value: string, suffix: string) => {
    const index = (counters.get("env_secret") ?? 0) + 1;
    counters.set("env_secret", index);
    return `${prefix}${outboundPlaceholder("env_secret", index)}${suffix}`;
  });
  // Anything the scanner sees but the patterns above did not cover is masked outright rather than sent.
  return scanTextForSecrets(result).clean ? result : CredentialMasker.mask(result);
}

/** Redacts a single value for logging (never returns the raw input). */
export function redactOutboundValue(value: string): string {
  return redactSecretValue(value);
}

const FORBIDDEN_EVENT_KEYS = new Set([
  "payload", "body", "content", "text", "value", "command", "arguments", "diff", "patch",
  "headers", "authorization", "cookie", "token", "secret", "password", "url", "query", "prompt",
]);

/**
 * Throws when a caller tries to put the payload (or a secret) into an outbound decision event. Called by
 * the recorder so an event with content physically cannot leave this module.
 */
export function assertNoContentInOutboundDecision(event: Record<string, unknown>): void {
  const offenders: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      if (scanTextForSecrets(value).findings.length > 0) offenders.push(`${path}:secret`);
      if (/https?:\/\//i.test(value) && !/^https?:\/\/www\.npati\.com/i.test(value)) offenders.push(`${path}:url`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_EVENT_KEYS.has(key.toLowerCase())) offenders.push(`${path}.${key}`);
        walk(nested, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(event, "event");
  if (offenders.length > 0) {
    throw new OutboundExfiltrationError("outbound_decision_contains_content", "Outbound decision event carries content or a secret", {
      httpStatus: 500,
      details: { offenders },
    });
  }
}

/** The seam every call site uses: a single registered guard, resolved once at startup. */
export interface OutboundGuard {
  inspect(input: Omit<InspectOutboundPayloadInput, "policy"> & { policy?: OutboundPolicyLike | null }): InspectOutboundPayloadResult;
  /** Records the decision (metadata only) and returns the verdict. */
  evaluate(input: InspectOutboundPayloadInput): InspectOutboundPayloadResult;
}

export interface CreateOutboundGuardInput {
  /**
   * Resolves the effective policy for a channel, optionally using the per-call context. Returning a
   * `{ code, reason }` refusal (missing context, unregistered channel, unreadable store) is what turns a
   * silent `null` into an explicit, auditable refusal.
   */
  resolvePolicy?: (
    channel: OutboundChannel,
    context?: OutboundPolicyContext | null,
  ) => OutboundPolicyLike | OutboundPolicyRefusal | null;
  resolveProjectClassification?: (channel: OutboundChannel, context?: OutboundPolicyContext | null) => ProviderDataClassification | undefined;
  resolvePathRules?: (channel: OutboundChannel) => readonly ProjectDataPolicyPathRule[] | undefined;
  record?: (event: OutboundDecisionEvent) => void;
  privateContentApprovalBytes?: number;
}

function isPolicyRefusal(value: unknown): value is OutboundPolicyRefusal {
  return Boolean(value && typeof value === "object" && "code" in (value as Record<string, unknown>)
    && "reason" in (value as Record<string, unknown>));
}

export function createOutboundGuard(deps: CreateOutboundGuardInput = {}): OutboundGuard {
  const evaluate = (input: InspectOutboundPayloadInput): InspectOutboundPayloadResult => {
    const context = input.context ?? null;
    const resolvedPolicy = input.policy ?? deps.resolvePolicy?.(input.channel, context) ?? null;
    const refusal = input.policyRefusal
      ?? (isPolicyRefusal(resolvedPolicy) ? resolvedPolicy : null);
    const resolved: InspectOutboundPayloadInput = {
      ...input,
      context,
      policy: isPolicyRefusal(resolvedPolicy) ? null : resolvedPolicy,
      policyRefusal: refusal,
      projectClassification: input.projectClassification
        ?? deps.resolveProjectClassification?.(input.channel, context)
        ?? context?.dataClassification,
      pathRules: input.pathRules ?? deps.resolvePathRules?.(input.channel),
      privateContentApprovalBytes: input.privateContentApprovalBytes ?? deps.privateContentApprovalBytes,
    };
    const result = inspectOutboundPayload(resolved);
    deps.record?.(result.event);
    return result;
  };
  return {
    inspect: (input) => evaluate(input as InspectOutboundPayloadInput),
    evaluate,
  };
}

let registeredGuard: OutboundGuard | null = null;

/** Wired once from `app.ts`; tests register their own guard and reset it afterwards. */
export function setOutboundGuard(guard: OutboundGuard | null): void {
  registeredGuard = guard;
}

export function getOutboundGuard(): OutboundGuard | null {
  return registeredGuard;
}

/**
 * The call-site helper. A sensitive payload with no registered guard is refused (`outbound_guard_unavailable`)
 * so an unwired deployment cannot exfiltrate; a payload with nothing sensitive stays allowed, so NPATI
 * features unrelated to the Coding Agent keep working while the guard is not wired.
 */
export function guardOutbound(input: InspectOutboundPayloadInput): InspectOutboundPayloadResult {
  const guard = registeredGuard;
  if (guard) return guard.evaluate(input);
  const result = inspectOutboundPayload({ ...input, policy: input.policy ?? null });
  if (result.decision === "allow" && result.secretFindings.length === 0) return result;
  if (result.decision === "allow") {
    return {
      ...result,
      decision: "deny",
      code: "outbound_guard_unavailable",
      reasons: [...result.reasons, "no_guard_registered"],
      event: { ...result.event, decision: "deny", code: "outbound_guard_unavailable" },
    };
  }
  return result;
}

/** Throwing variant for call sites that must not proceed on a refusal. */
export function assertOutboundAllowed(input: InspectOutboundPayloadInput): InspectOutboundPayloadResult {
  const result = guardOutbound(input);
  if (result.decision === "deny") {
    throw new OutboundExfiltrationError(result.code ?? "outbound_denied", `Outbound ${input.channel} refused`, {
      httpStatus: 403,
      details: { reasons: result.reasons, classification: result.classification },
    });
  }
  if (result.decision === "require_approval") {
    throw new OutboundExfiltrationError("approval_required", `Outbound ${input.channel} needs approval`, {
      httpStatus: 403,
      details: { reasons: result.reasons, classification: result.classification, approvalRequired: true },
    });
  }
  return result;
}
