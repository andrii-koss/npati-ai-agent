/**
 * ProviderDataGuard — the single point that decides what may leave NPATI towards an AI provider.
 *
 * Design notes (C5b):
 * - Implemented as a Proxy decorator over `AIEngine`: it satisfies the interface structurally and only
 *   intercepts the calls that carry content (`chat`, `stream`, and — when present — `transcribeAudio`,
 *   `embed`, `moderate`, `rerank`). Every other method is forwarded untouched, so no engine capability is
 *   silently dropped when new methods are added to the adapter.
 * - The policy is resolved through an injected port, so this module does not depend on the storage or the
 *   resolver implemented elsewhere. A missing/throwing resolver is fail-closed, never "allow".
 * - Content is walked generically over every string leaf instead of over known `ChatRequest` fields: a new
 *   field in the adapter cannot bypass the guard by being unknown to it.
 * - Redactions use stable per-request placeholders (`REDACTED:secret_1`) so the model can refer to them.
 *   Placeholders are data only: `assertNoPlaceholderInWrite` refuses to let them reach disk.
 * - Only metadata is recorded; `assertNoContentInDecision` throws if a decision ever carries content.
 */

import type { AIEngine, ChatRequest, ChatResult } from "@npati/omniroute-adapter";
import {
  PROVIDER_CONTENT_TYPES,
  PROVIDER_DATA_CLASSIFICATIONS,
  type ProviderContentType,
  type ProviderDataClassification,
  type ProviderRedactionKind,
} from "./provider-data-policy";

/**
 * One vocabulary (C5b): the guard consumes the **authoritative** policy types, aliased so existing call
 * sites keep their names. There is no second union here — if the policy vocabulary grows, this file cannot
 * silently disagree with the UI or with eligibility.
 */
export type DataClassification = ProviderDataClassification;
export type ContentType = ProviderContentType;

export type RedactionKind = "secret" | "token" | "key" | "pii" | "email" | "internal_hostname";

/**
 * The one place where the policy vocabulary is translated into the guard's internal names (and back).
 * `files`/`web`/`prompt` are the authoritative names; the guard's walker produces canonical values, so the
 * aliases exist only to accept legacy spellings from callers without weakening the check.
 */
export const CONTENT_TYPE_ALIASES: Readonly<Record<string, ContentType>> = {
  file_list: "files",
  files: "files",
  web_content: "web",
  web: "web",
  text: "prompt",
  prompt: "prompt",
};

export function toCanonicalContentType(value: string): ContentType | undefined {
  const normalized = value.toLowerCase();
  // Canonical values map to themselves, so the mapping is total in both directions; only legacy spellings
  // need an alias. Without the identity half, a policy naming `diff` would look like "no such type".
  if ((PROVIDER_CONTENT_TYPES as readonly string[]).includes(normalized)) return normalized as ContentType;
  return CONTENT_TYPE_ALIASES[normalized];
}

/**
 * The policy layer names redaction kinds in the plural (`secrets`, `tokens`, `keys`); the guard's scanner
 * emits singular kinds. This mapping is the only bridge — without it a policy could require redaction and the
 * scanner would never match, i.e. a silent no-op.
 */
export const REDACTION_KIND_FROM_POLICY: Readonly<Record<ProviderRedactionKind, RedactionKind>> = {
  secrets: "secret",
  tokens: "token",
  keys: "key",
  pii: "pii",
  email: "email",
  internal_hostnames: "internal_hostname",
};

export function requiredRedactionKindsFromPolicy(kinds: readonly ProviderRedactionKind[]): RedactionKind[] {
  return Array.from(new Set(kinds.map((kind) => REDACTION_KIND_FROM_POLICY[kind])));
}

export const DATA_CLASSIFICATION_ORDER: DataClassification[] = [...PROVIDER_DATA_CLASSIFICATIONS];

export interface EffectiveDataPolicy {
  providerId: string;
  kind: "hosted_third_party" | "self_hosted" | "local";
  allowPrivateRepoCode: boolean;
  maxDataClassification: DataClassification;
  allowPromptCaching: boolean;
  trainingPolicy: "no_training" | "may_train" | "unknown";
  externalRetention: string;
  requiredRedactions: RedactionKind[];
  allowedContentTypes: ContentType[];
  policyVersion: number;
  stale: boolean;
  region?: string;
  jurisdiction?: string;
}

export interface ProviderPolicyContext {
  companyId: string;
  projectId?: string;
  sessionId?: string;
  agentId?: string;
  /** Classification of the project; conservative default is `confidential`. */
  dataClassification: DataClassification;
}

export interface PolicyResolveInput {
  model?: string;
  providerId?: string;
  policyContext?: ProviderPolicyContext;
}

/** Injected port: adapts the stored policy (migration 074 / provider-data-policy.ts) to this module. */
export type ProviderDataPolicyResolver = (
  input: PolicyResolveInput,
) => Promise<EffectiveDataPolicy> | EffectiveDataPolicy;

export interface ProviderDataDecision {
  kind: "provider_data_decision";
  phase: "chat" | "stream" | "transcribe" | "embed" | "moderate" | "rerank";
  providerId: string;
  model?: string;
  companyId?: string;
  projectId?: string;
  sessionId?: string;
  dataClassification: DataClassification;
  maxDataClassification: DataClassification;
  bytes: number;
  redactionCounts: Record<string, number>;
  policyVersion: number;
  cachingSuppressed: boolean;
  decision: "allow" | "deny";
  code?: string;
  at: string;
}

export interface ProviderDataDecisionRecorder {
  record(decision: ProviderDataDecision): void | Promise<void>;
}

export type ProviderDataErrorCode =
  | "provider_policy_context_required"
  | "provider_policy_unavailable"
  | "provider_data_classification_exceeded"
  | "provider_content_type_not_allowed"
  | "provider_private_code_not_allowed"
  | "redaction_placeholder_write_denied"
  | "provider_data_decision_invalid"
  | "no_eligible_provider";

export class ProviderDataError extends Error {
  constructor(
    readonly code: ProviderDataErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    readonly retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "ProviderDataError";
  }
}

const CONTENT_BEARING_KEYS: Array<{ pattern: RegExp; type: ContentType }> = [
  { pattern: /^(diff|patch)$/i, type: "diff" },
  { pattern: /^(command|cmd|shell|argv)$/i, type: "terminal" },
  { pattern: /^(output|stdout|stderr|logs?|console)$/i, type: "logs" },
  { pattern: /^(files?|file_?list|paths?)$/i, type: "files" },
  { pattern: /^(markdown|html|web|page|url_?content)$/i, type: "web" },
  { pattern: /^(code|source|snippet|contents?|text|body|value|message)$/i, type: "code" },
];

const CONTROL_KEYS = new Set([
  "role",
  "model",
  "fallbackmodel",
  "type",
  "id",
  "name",
  "tool_call_id",
  "toolcallid",
  "formatted",
  "encoding",
  "format",
  "finish_reason",
  "finishreason",
  "compression",
  "toolchoice",
  "systemfingerprint",
]);

const SECRET_PATTERNS: Array<{ kind: RedactionKind; pattern: RegExp }> = [
  { kind: "token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: "key", pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/g },
  { kind: "key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "secret", pattern: /\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\b\s*[:=]\s*["']?([^\s"']{8,})/gi },
  { kind: "secret", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "pii", pattern: /\b(?:\d[ -]?){13,19}\b/g },
  { kind: "internal_hostname", pattern: /\b(?:[a-z0-9-]+\.)*(?:internal|local|lan|corp|intranet)\b/gi },
];

const PLACEHOLDER_PATTERN = /\bREDACTED:[a-z_]+_\d+\b/;

/**
 * Fail-closed platform default for a hosted provider whose policy has never been reviewed: public content
 * only, no private repository code, no prompt caching, every redaction class required. Used when no stored
 * policy is available, so an unknown provider can never receive more than public data.
 */
export function conservativeHostedPolicy(input: { model?: string; providerId?: string } = {}): EffectiveDataPolicy {
  return {
    providerId: input.providerId ?? (input.model ? `unknown:${input.model.split("/")[0] ?? input.model}` : "unknown"),
    kind: "hosted_third_party",
    allowPrivateRepoCode: false,
    maxDataClassification: "public",
    allowPromptCaching: false,
    trainingPolicy: "unknown",
    externalRetention: "unknown",
    requiredRedactions: ["secret", "token", "key", "pii", "email", "internal_hostname"],
    allowedContentTypes: ["prompt"],
    policyVersion: 0,
    stale: true,
  };
}

export function isRedactionPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}

/**
 * The write path must call this before persisting anything that came back from a model: a placeholder is a
 * reference to a redacted value, never a value, so it must never reach disk.
 */
export function assertNoPlaceholderInWrite(content: string, context: Record<string, unknown> = {}): void {
  if (typeof content === "string" && isRedactionPlaceholder(content)) {
    throw new ProviderDataError(
      "redaction_placeholder_write_denied",
      "Refusing to write a redaction placeholder to disk.",
      403,
      { ...context, placeholderKind: content.match(PLACEHOLDER_PATTERN)?.[0] },
    );
  }
}

export function classificationRank(value: DataClassification): number {
  const index = DATA_CLASSIFICATION_ORDER.indexOf(value);
  return index === -1 ? DATA_CLASSIFICATION_ORDER.length : index;
}

export function assertNoContentInDecision(decision: ProviderDataDecision): void {
  const forbidden = [
    "prompt",
    "content",
    "message",
    "messages",
    "text",
    "body",
    "diff",
    "patch",
    "command",
    "output",
    "stdout",
    "stderr",
    "secret",
    "token",
    "password",
  ];
  for (const key of Object.keys(decision)) {
    if (forbidden.includes(key.toLowerCase())) {
      throw new ProviderDataError(
        "provider_data_decision_invalid",
        `Provider data decision must not carry content ("${key}").`,
        500,
        { key },
      );
    }
  }
  const serialized = JSON.stringify(decision);
  if (/https?:\/\//i.test(serialized) || /\?[a-z_]+=/i.test(serialized)) {
    throw new ProviderDataError(
      "provider_data_decision_invalid",
      "Provider data decision must not carry URLs or query strings.",
      500,
      {},
    );
  }
}

interface RedactionOutcome {
  value: string;
  counts: Record<string, number>;
}

function redactString(value: string, kinds: RedactionKind[], counters: Map<RedactionKind, number>): RedactionOutcome {
  let result = value;
  const counts: Record<string, number> = {};
  for (const { kind, pattern } of SECRET_PATTERNS) {
    if (!kinds.includes(kind)) continue;
    result = result.replace(pattern, () => {
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      counts[kind] = (counts[kind] ?? 0) + 1;
      return `REDACTED:${kind}_${next}`;
    });
  }
  return { value: result, counts };
}

function contentTypesForKey(key: string): ContentType[] {
  const matched = CONTENT_BEARING_KEYS.find((entry) => entry.pattern.test(key));
  return matched ? [matched.type] : [];
}

function looksLikeCode(value: string): boolean {
  if (value.length < 80) return false;
  const markers = [/\bfunction\b/, /\bclass\s+\w+/, /\bimport\s+/m, /\bconst\s+\w+\s*=/, /=>\s*\{/, /;\s*$/m, /\breturn\b/];
  let hits = 0;
  for (const marker of markers) if (marker.test(value)) hits += 1;
  return hits >= 2;
}

interface WalkResult {
  bytes: number;
  redactions: Record<string, number>;
  contentTypes: Set<ContentType>;
  privateCodeDetected: boolean;
}

function walkStrings(value: unknown, key: string, policy: EffectiveDataPolicy, counters: Map<RedactionKind, number>, result: WalkResult): unknown {
  if (typeof value === "string") {
    result.bytes += Buffer.byteLength(value, "utf8");
    const normalizedKey = key.toLowerCase();
    if (CONTROL_KEYS.has(normalizedKey)) return value;
    const types = contentTypesForKey(normalizedKey);
    for (const type of types) {
      result.contentTypes.add(type);
      if (!policy.allowedContentTypes.includes(type) && type !== "code") {
        throw new ProviderDataError(
          "provider_content_type_not_allowed",
          `Provider policy does not allow "${type}" content.`,
          403,
          { providerId: policy.providerId, contentType: type, allowed: policy.allowedContentTypes },
        );
      }
    }
    if (!policy.allowPrivateRepoCode && types.includes("code") && looksLikeCode(value)) {
      result.privateCodeDetected = true;
    }
    const redacted = redactString(value, policy.requiredRedactions, counters);
    for (const [kind, count] of Object.entries(redacted.counts)) {
      result.redactions[kind] = (result.redactions[kind] ?? 0) + count;
    }
    return redacted.value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => walkStrings(entry, key, policy, counters, result));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = walkStrings(childValue, childKey, policy, counters, result);
    }
    return output;
  }
  return value;
}

export interface ProviderDataGuardOptions {
  resolvePolicy: ProviderDataPolicyResolver;
  record?: ProviderDataDecisionRecorder;
  now?: () => Date;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

export interface ProviderDataGuard {
  guardRequest<T extends { model?: string }>(request: T, policyContext?: ProviderPolicyContext): Promise<T>;
  resolvePolicy(input: PolicyResolveInput): Promise<EffectiveDataPolicy>;
  isModelEligible(model: string, policyContext?: ProviderPolicyContext): Promise<{ eligible: boolean; reason?: string }>;
  /**
   * C8: guard one **text field** that is about to become provider-bound content (the compaction summary of a
   * long code run). It runs through the very same `prepare` path as `chat` — policy resolution, classification
   * gate, content-type rules, private-code detection, redaction and decision recording — so there is no second
   * scanner, no second policy lookup and no second vocabulary anywhere in the codebase.
   */
  guardProviderBoundText(text: string, input: GuardProviderBoundTextInput): Promise<GuardedTextResult>;
}

export interface GuardProviderBoundTextInput {
  model?: string;
  policyContext: ProviderPolicyContext;
  /**
   * The field name under which the text is presented. It decides content-type classification exactly as it
   * would in a real request (`content`/`text` → code), which is why the default is `content` and not a neutral
   * label that would classify as nothing.
   */
  field?: "content" | "text" | "output";
}

export interface GuardedTextResult {
  text: string;
  /** Always false on a successful result: a redacted text is refused, never returned (see below). */
  changed: boolean;
  bytes: number;
}

/**
 * Raised when the guard would have to redact the text to let it through.
 *
 * Why refuse instead of returning the redacted text: the summary is persisted as a session artifact and
 * recorded as model-visible state, and a redacted summary would carry a `REDACTED:<kind>_N` placeholder into
 * both. `assertNoPlaceholderInWrite` exists precisely because placeholders are references that must not reach
 * disk, and the same reasoning that makes the C4a scanner refuse a summary applies here — the underlying value
 * is still one message away, so silently sanitising the summary would hide the leak from the caller who has to
 * fix it.
 */
export class ProviderBoundTextRejectedError extends Error {
  readonly code = "provider_bound_text_requires_redaction";
  readonly httpStatus = 403;
  readonly retryable = false;
  readonly details: Record<string, unknown>;

  constructor(details: Record<string, unknown>) {
    super("Refusing text that would have to be redacted before it may reach a provider.");
    this.name = "ProviderBoundTextRejectedError";
    this.details = details;
  }
}

export function createProviderDataGuard(base: AIEngine, options: ProviderDataGuardOptions): AIEngine & { providerDataGuard: ProviderDataGuard } {
  const now = options.now ?? (() => new Date());

  async function policyFor(input: PolicyResolveInput): Promise<EffectiveDataPolicy> {
    try {
      const policy = await options.resolvePolicy(input);
      if (!policy || typeof policy !== "object") {
        throw new Error("resolver returned no policy");
      }
      return policy;
    } catch (error) {
      throw new ProviderDataError(
        "provider_policy_unavailable",
        "Provider data policy could not be resolved; refusing to send data.",
        503,
        { model: input.model, reason: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  }

  async function record(decision: Omit<ProviderDataDecision, "kind" | "at">): Promise<void> {
    const full: ProviderDataDecision = { kind: "provider_data_decision", at: now().toISOString(), ...decision };
    assertNoContentInDecision(full);
    try {
      await options.record?.record(full);
    } catch (error) {
      // The decision itself never changes because of telemetry; the failure is surfaced to the log only.
      options.logger?.warn("provider_data_decision_record_failed", {
        code: decision.code ?? "none",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function prepare(method: "chat" | "stream", request: ChatRequest, policyContext?: ProviderPolicyContext): Promise<ChatRequest> {
    const model = request?.model;
    const policy = await policyFor({ model, policyContext });

    if (!policyContext?.companyId) {
      throw new ProviderDataError(
        "provider_policy_context_required",
        "A request that carries content must declare its policy context.",
        403,
        { providerId: policy.providerId, model: model ?? null },
      );
    }

    const classification = policyContext.dataClassification ?? "confidential";
    if (classificationRank(classification) > classificationRank(policy.maxDataClassification)) {
      await record({
        phase: method,
        providerId: policy.providerId,
        model,
        companyId: policyContext.companyId,
        projectId: policyContext.projectId,
        sessionId: policyContext.sessionId,
        dataClassification: classification,
        maxDataClassification: policy.maxDataClassification,
        bytes: 0,
        redactionCounts: {},
        policyVersion: policy.policyVersion,
        cachingSuppressed: !policy.allowPromptCaching,
        decision: "deny",
        code: "provider_data_classification_exceeded",
      });
      throw new ProviderDataError(
        "provider_data_classification_exceeded",
        `Project data classification "${classification}" exceeds the provider limit "${policy.maxDataClassification}".`,
        403,
        {
          providerId: policy.providerId,
          model: model ?? null,
          dataClassification: classification,
          maxDataClassification: policy.maxDataClassification,
          policyVersion: policy.policyVersion,
        },
      );
    }

    const counters = new Map<RedactionKind, number>();
    const walk: WalkResult = { bytes: 0, redactions: {}, contentTypes: new Set(), privateCodeDetected: false };
    let sanitized: ChatRequest;
    try {
      sanitized = walkStrings(request, "request", policy, counters, walk) as ChatRequest;
    } catch (error) {
      if (error instanceof ProviderDataError) {
        await record({
          phase: method,
          providerId: policy.providerId,
          model,
          companyId: policyContext.companyId,
          projectId: policyContext.projectId,
          sessionId: policyContext.sessionId,
          dataClassification: classification,
          maxDataClassification: policy.maxDataClassification,
          bytes: walk.bytes,
          redactionCounts: walk.redactions,
          policyVersion: policy.policyVersion,
          cachingSuppressed: !policy.allowPromptCaching,
          decision: "deny",
          code: error.code,
        });
      }
      throw error;
    }

    if (walk.privateCodeDetected) {
      await record({
        phase: method,
        providerId: policy.providerId,
        model,
        companyId: policyContext.companyId,
        projectId: policyContext.projectId,
        sessionId: policyContext.sessionId,
        dataClassification: classification,
        maxDataClassification: policy.maxDataClassification,
        bytes: walk.bytes,
        redactionCounts: walk.redactions,
        policyVersion: policy.policyVersion,
        cachingSuppressed: !policy.allowPromptCaching,
        decision: "deny",
        code: "provider_private_code_not_allowed",
      });
      throw new ProviderDataError(
        "provider_private_code_not_allowed",
        "Provider policy does not allow private repository code.",
        403,
        { providerId: policy.providerId, model: model ?? null, policyVersion: policy.policyVersion },
      );
    }

    await record({
      phase: method,
      providerId: policy.providerId,
      model,
      companyId: policyContext.companyId,
      projectId: policyContext.projectId,
      sessionId: policyContext.sessionId,
      dataClassification: classification,
      maxDataClassification: policy.maxDataClassification,
      bytes: walk.bytes,
      redactionCounts: walk.redactions,
      policyVersion: policy.policyVersion,
      cachingSuppressed: !policy.allowPromptCaching,
      decision: "allow",
    });

    return sanitized;
  }

  const guard: ProviderDataGuard = {
    async guardRequest<T extends { model?: string }>(request: T, policyContext?: ProviderPolicyContext): Promise<T> {
      return (await prepare("chat", request as unknown as ChatRequest, policyContext)) as unknown as T;
    },
    resolvePolicy: policyFor,
    async guardProviderBoundText(
      text: string,
      input: GuardProviderBoundTextInput,
    ): Promise<GuardedTextResult> {
      const field = input.field ?? "content";
      // A minimal request, not a bypass: `prepare` walks every string leaf, so wrapping the text in the field
      // name it would really travel under makes the classification, the private-code rule and the redaction
      // behave exactly as they would on the real call.
      const probe = {
        ...(input.model ? { model: input.model } : {}),
        messages: [{ role: "system", [field]: text }],
      } as unknown as ChatRequest;
      const sanitized = await prepare("chat", probe, input.policyContext);
      const messages = (sanitized as unknown as { messages?: Array<Record<string, unknown>> }).messages ?? [];
      const value = messages[0]?.[field];
      const guarded = typeof value === "string" ? value : "";
      if (guarded !== text) {
        throw new ProviderBoundTextRejectedError({
          reason: "provider_bound_text_requires_redaction",
          field,
          model: input.model ?? null,
          bytes: Buffer.byteLength(text, "utf8"),
        });
      }
      return { text: guarded, changed: false, bytes: Buffer.byteLength(guarded, "utf8") };
    },
    async isModelEligible(model: string, policyContext?: ProviderPolicyContext) {
      try {
        const policy = await policyFor({ model, policyContext });
        const classification = policyContext?.dataClassification ?? "confidential";
        if (classificationRank(classification) > classificationRank(policy.maxDataClassification)) {
          return { eligible: false, reason: `classification_exceeds:${policy.maxDataClassification}` };
        }
        if (policy.stale) {
          return { eligible: false, reason: "policy_stale" };
        }
        return { eligible: true };
      } catch (error) {
        const reason = error instanceof ProviderDataError ? error.code : "policy_unresolved";
        return { eligible: false, reason };
      }
    },
  };

  const proxied = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "providerDataGuard") return guard;
      const original = Reflect.get(target, property, receiver);
      if (typeof original !== "function") return original;
      if (property === "chat") {
        return async (request: ChatRequest, policyContextArgument?: ProviderPolicyContext) => {
          // Documented contract for C6: `request.policyContext` (the engine interface takes only the request).
          // An explicit second argument is accepted as a compatibility form.
          const context =
            (request as ChatRequest & { policyContext?: ProviderPolicyContext }).policyContext ?? policyContextArgument;
          const sanitized = await prepare("chat", request, context);
          return (original as AIEngine["chat"]).call(target, sanitized) as Promise<ChatResult>;
        };
      }
      if (property === "stream") {
        return (request: ChatRequest, policyContextArgument?: ProviderPolicyContext) => {
          const context =
            (request as ChatRequest & { policyContext?: ProviderPolicyContext }).policyContext ?? policyContextArgument;
          const inner = async function* () {
            const sanitized = await prepare("stream", request, context);
            yield* (original as AIEngine["stream"]).call(target, sanitized);
          };
          return inner();
        };
      }
      if (property === "transcribeAudio" || property === "embed" || property === "moderate" || property === "rerank") {
        return async (input: unknown) => {
          const context = (input as { policyContext?: ProviderPolicyContext } | undefined)?.policyContext;
          const policy = await policyFor({ policyContext: context });
          const classification = context?.dataClassification ?? "confidential";
          if (!context?.companyId) {
            throw new ProviderDataError(
              "provider_policy_context_required",
              "A request that carries content must declare its policy context.",
              403,
              { providerId: policy.providerId, phase: property },
            );
          }
          if (classificationRank(classification) > classificationRank(policy.maxDataClassification)) {
            await record({
              phase: property === "transcribeAudio" ? "transcribe" : property === "embed" ? "embed" : property === "moderate" ? "moderate" : "rerank",
              providerId: policy.providerId,
              companyId: context.companyId,
              projectId: context.projectId,
              sessionId: context.sessionId,
              dataClassification: classification,
              maxDataClassification: policy.maxDataClassification,
              bytes: 0,
              redactionCounts: {},
              policyVersion: policy.policyVersion,
              cachingSuppressed: !policy.allowPromptCaching,
              decision: "deny",
              code: "provider_data_classification_exceeded",
            });
            throw new ProviderDataError(
              "provider_data_classification_exceeded",
              `Project data classification "${classification}" exceeds the provider limit "${policy.maxDataClassification}".`,
              403,
              { providerId: policy.providerId, dataClassification: classification, maxDataClassification: policy.maxDataClassification },
            );
          }
          return (original as (value: unknown) => unknown).call(target, input);
        };
      }
      return (original as (...args: unknown[]) => unknown).bind(target);
    },
  }) as AIEngine & { providerDataGuard: ProviderDataGuard };

  return proxied;
}
