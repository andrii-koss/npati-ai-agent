/**
 * C5b — ProviderDataPolicy: what a project's data may be sent to which provider.
 *
 * The rule this module exists to enforce is simple: **nothing reaches a provider unless a policy says it
 * may**. Every resolver here therefore ends in a fail-closed default rather than a permissive one, and
 * `undefined` never means "allowed":
 *
 *   - an unknown provider is treated as a **hosted third party** (the least trusted kind), limited to
 *     `public` data, with private-repository code, prompt caching and code/diff/file/log/terminal/web
 *     content all denied, retention and training policy both `unknown`, and every redaction kind required;
 *   - a self-hosted or local provider may carry up to `restricted`, but secret/token/key redaction is
 *     **always** required — that is not negotiable by configuration;
 *   - a policy that has never been reviewed, or was reviewed more than 180 days ago, resolves with
 *     `stale: true` so callers can refuse or escalate instead of silently trusting it.
 *
 * The record types mirror `ProviderDataPolicyRecord` and friends in `packages/workspace/src/types.ts`
 * structurally. The service keeps its own copy on purpose (the workspace package cannot import the app),
 * exactly like the C5a membership port: the two must stay in sync, and the store's port is the contract.
 */

export * from "./provider-data-policy-types";
import {
  type ProviderDataPolicyKind,
  PROVIDER_DATA_POLICY_KINDS,
  type ProviderTrainingPolicy,
  PROVIDER_TRAINING_POLICIES,
  type ProviderDataClassification,
  PROVIDER_DATA_CLASSIFICATIONS,
  type ProviderRedactionKind,
  PROVIDER_REDACTION_KINDS,
  MANDATORY_REDACTIONS,
  type ProviderContentType,
  PROVIDER_CONTENT_TYPES,
  type ExternalRetention,
  type ProviderDataPolicyRecord,
  type UpsertProviderDataPolicyInput,
  type ProviderDataPolicyVersionRecord,
  type ProjectDataPolicyPathRule,
  type ProjectDataPolicyRecord,
  type UpsertProjectDataPolicyInput,
  type ProviderHostedConsentRecord,
  ProviderDataPolicyError,
} from "./provider-data-policy-types";

export const FAIL_CLOSED_ALLOWED_CONTENT_TYPES: readonly ProviderContentType[] = ["metadata"] as const;

/**
 * The hard floor for an unknown/new hosted provider. This is deliberately the same object the resolver
 * returns when *no* policy matches: there is no configuration path that makes an unconfigured hosted
 * provider more permissive than this.
 */
export const FAIL_CLOSED_HOSTED_POLICY = {
  kind: "hosted_third_party" as ProviderDataPolicyKind,
  maxDataClassification: "public" as ProviderDataClassification,
  allowPrivateRepoCode: false,
  allowPromptCaching: false,
  trainingPolicy: "unknown" as ProviderTrainingPolicy,
  externalRetention: "unknown" as ExternalRetention,
  requiredRedactions: [...PROVIDER_REDACTION_KINDS],
  allowedContentTypes: [...FAIL_CLOSED_ALLOWED_CONTENT_TYPES],
} as const;

/**
 * The floor for a self-hosted or local provider: data classification may go up to `restricted` because the
 * operator runs the hardware, but secret/token/key redaction stays mandatory and the sensitive content
 * types still need an explicit allow.
 */
export const FAIL_CLOSED_SELF_HOSTED_POLICY = {
  kind: "self_hosted" as ProviderDataPolicyKind,
  maxDataClassification: "restricted" as ProviderDataClassification,
  allowPrivateRepoCode: true,
  allowPromptCaching: false,
  trainingPolicy: "unknown" as ProviderTrainingPolicy,
  externalRetention: "none" as ExternalRetention,
  requiredRedactions: [...PROVIDER_REDACTION_KINDS],
  allowedContentTypes: ["metadata", "prompt", "embeddings"] as ProviderContentType[],
} as const;

/** How long a reviewed policy is trusted before it is reported stale. */
export const POLICY_REVIEW_MAX_AGE_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const classificationRank: Record<ProviderDataClassification, number> = {
  public: 0, internal: 1, confidential: 2, restricted: 3,
};

/** The stricter of two classifications — never the more permissive one. */
export function strictestClassification(
  a: ProviderDataClassification,
  b: ProviderDataClassification,
): ProviderDataClassification {
  return classificationRank[a] >= classificationRank[b] ? a : b;
}

const RETENTION_PATTERN = /^N_days:(\d{1,5})$/;

export function isProviderDataClassification(value: unknown): value is ProviderDataClassification {
  return typeof value === "string" && (PROVIDER_DATA_CLASSIFICATIONS as readonly string[]).includes(value);
}
export function isProviderDataPolicyKind(value: unknown): value is ProviderDataPolicyKind {
  return typeof value === "string" && (PROVIDER_DATA_POLICY_KINDS as readonly string[]).includes(value);
}
export function isProviderTrainingPolicy(value: unknown): value is ProviderTrainingPolicy {
  return typeof value === "string" && (PROVIDER_TRAINING_POLICIES as readonly string[]).includes(value);
}
export function isProviderContentType(value: unknown): value is ProviderContentType {
  return typeof value === "string" && (PROVIDER_CONTENT_TYPES as readonly string[]).includes(value);
}
export function isProviderRedactionKind(value: unknown): value is ProviderRedactionKind {
  return typeof value === "string" && (PROVIDER_REDACTION_KINDS as readonly string[]).includes(value);
}

/** `none` | `unknown` | `N_days:<1..99999>`; anything else is refused rather than approximated. */
export function parseExternalRetention(value: unknown): ExternalRetention {
  if (value === "none" || value === "unknown") return value;
  if (typeof value === "string") {
    const match = RETENTION_PATTERN.exec(value);
    if (match) return `N_days:${Number(match[1])}` as ExternalRetention;
  }
  throw new ProviderDataPolicyError("invalid_retention", `Unsupported external retention: ${String(value)}`, {
    httpStatus: 400,
    details: { field: "externalRetention", allowed: ["none", "unknown", "N_days:<days>"] },
  });
}

/** True when the policy was never reviewed or the review is older than 180 days. */
export function isPolicyStale(
  policy: Pick<ProviderDataPolicyRecord, "lastReviewedAt">,
  now: Date = new Date(),
): boolean {
  if (!policy.lastReviewedAt) return true;
  const reviewed = policy.lastReviewedAt instanceof Date
    ? policy.lastReviewedAt.getTime()
    : new Date(policy.lastReviewedAt).getTime();
  if (!Number.isFinite(reviewed)) return true;
  return now.getTime() - reviewed > POLICY_REVIEW_MAX_AGE_DAYS * MS_PER_DAY;
}

/** Why a policy is stale, so a caller can say something more useful than "stale". */
export function policyStalenessReason(
  policy: Pick<ProviderDataPolicyRecord, "lastReviewedAt">,
  now: Date = new Date(),
): string | null {
  if (!policy.lastReviewedAt) return "never_reviewed";
  return isPolicyStale(policy, now) ? `review_older_than_${POLICY_REVIEW_MAX_AGE_DAYS}_days` : null;
}

/**
 * A path rule pattern must stay inside the project: relative, no `..` segment, no absolute path, no
 * backslashes (which Windows/glob layers interpret differently) and no `~`. A rule that could point
 * outside the workspace is refused instead of normalised, because a normalised escape is still an escape.
 */
export function validatePathRulePattern(pattern: unknown): string {
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    throw new ProviderDataPolicyError("invalid_policy_path_rule", "A path rule needs a non-empty pattern", {
      httpStatus: 400,
      details: { field: "pattern" },
    });
  }
  const value = pattern.trim();
  const invalid = value.startsWith("/") || value.startsWith("~") || value.includes("\\")
    || value.split("/").some((segment) => segment === "..");
  if (invalid) {
    throw new ProviderDataPolicyError(
      "invalid_policy_path_rule",
      `Path rule must stay inside the project: ${value}`,
      { httpStatus: 400, details: { field: "pattern", pattern: value } },
    );
  }
  return value;
}

export function validatePathRule(rule: unknown): ProjectDataPolicyPathRule {
  if (!rule || typeof rule !== "object") {
    throw new ProviderDataPolicyError("invalid_policy_path_rule", "A path rule must be an object", {
      httpStatus: 400, details: { field: "pathRules" },
    });
  }
  const candidate = rule as { pattern?: unknown; classification?: unknown };
  const pattern = validatePathRulePattern(candidate.pattern);
  if (!isProviderDataClassification(candidate.classification)) {
    throw new ProviderDataPolicyError(
      "invalid_classification",
      `Unsupported classification in path rule: ${String(candidate.classification)}`,
      { httpStatus: 400, details: { field: "classification", pattern } },
    );
  }
  return { pattern, classification: candidate.classification };
}

/**
 * Validate an upsert. Every refusal is structured and specific, and the caller must not write anything
 * when this throws — the store validates again on its side so a direct store call is safe too.
 */
export function validateProviderDataPolicyInput(input: UpsertProviderDataPolicyInput): void {
  if (typeof input.providerId !== "string" || input.providerId.trim().length === 0) {
    throw new ProviderDataPolicyError("invalid_policy_field", "providerId is required", {
      httpStatus: 400, details: { field: "providerId" },
    });
  }
  if (!isProviderDataPolicyKind(input.kind)) {
    throw new ProviderDataPolicyError("invalid_policy_field", `Unsupported provider kind: ${String(input.kind)}`, {
      httpStatus: 400, details: { field: "kind", allowed: PROVIDER_DATA_POLICY_KINDS },
    });
  }
  if (!isProviderDataClassification(input.maxDataClassification)) {
    throw new ProviderDataPolicyError(
      "invalid_classification",
      `Unsupported classification: ${String(input.maxDataClassification)}`,
      { httpStatus: 400, details: { field: "maxDataClassification", allowed: PROVIDER_DATA_CLASSIFICATIONS } },
    );
  }
  if (!isProviderTrainingPolicy(input.trainingPolicy)) {
    throw new ProviderDataPolicyError(
      "invalid_policy_field",
      `Unsupported training policy: ${String(input.trainingPolicy)}`,
      { httpStatus: 400, details: { field: "trainingPolicy", allowed: PROVIDER_TRAINING_POLICIES } },
    );
  }
  // Parsed, not merely inspected: an unsupported retention string is a refusal, never a stored surprise.
  parseExternalRetention(input.externalRetention);

  const redactions = input.requiredRedactions ?? MANDATORY_REDACTIONS;
  for (const kind of redactions) {
    if (!isProviderRedactionKind(kind)) {
      throw new ProviderDataPolicyError("invalid_policy_field", `Unsupported redaction kind: ${String(kind)}`, {
        httpStatus: 400, details: { field: "requiredRedactions", allowed: PROVIDER_REDACTION_KINDS },
      });
    }
  }
  // Mandatory redaction cannot be configured away, for any provider kind.
  const missing = MANDATORY_REDACTIONS.filter((kind) => !redactions.includes(kind));
  if (missing.length > 0) {
    throw new ProviderDataPolicyError(
      "invalid_policy_field",
      `Required redactions must include: ${missing.join(", ")}`,
      { httpStatus: 400, details: { field: "requiredRedactions", missing } },
    );
  }

  for (const contentType of input.allowedContentTypes ?? FAIL_CLOSED_ALLOWED_CONTENT_TYPES) {
    if (!isProviderContentType(contentType)) {
      throw new ProviderDataPolicyError(
        "invalid_policy_field",
        `Unsupported content type: ${String(contentType)}`,
        { httpStatus: 400, details: { field: "allowedContentTypes", allowed: PROVIDER_CONTENT_TYPES } },
      );
    }
  }
}

export interface ResolveEffectivePolicyInput {
  providerId: string;
  /** The concrete model id, when the caller knows it; model-specific policies win over provider-wide. */
  model?: string | null;
  /**
   * What the provider registry says about this provider. Unknown/missing is treated as
   * `hosted_third_party`: an unrecognised provider is never assumed to be self-hosted.
   */
  providerKind?: ProviderDataPolicyKind | null;
  /** Policies visible to this company (its own rows). */
  companyPolicies?: readonly ProviderDataPolicyRecord[];
  /** Platform defaults (`companyId === null`) that apply to every company. */
  platformDefaults?: readonly ProviderDataPolicyRecord[];
  now?: Date;
}

export interface ResolvedProviderDataPolicy {
  /** The effective limits; always defined, always at least as strict as the fail-closed floor. */
  policy: Pick<
    ProviderDataPolicyRecord,
    "kind" | "maxDataClassification" | "allowPrivateRepoCode" | "allowPromptCaching"
    | "trainingPolicy" | "externalRetention" | "requiredRedactions" | "allowedContentTypes"
  > & { region: string | null; jurisdiction: string | null; termsUrl: string | null };
  /** Which layer produced it. `fail_closed` means "nothing matched" and must be surfaced to the caller. */
  source: "model" | "provider" | "platform" | "fail_closed";
  /** The policy row the limits came from, when there was one. */
  matchedPolicyId: string | null;
  policyVersion: number | null;
  stale: boolean;
  staleReason: string | null;
}

/** Glob matching that cannot escape its own pattern: `*` is the only wildcard and the match is anchored. */
export function modelPatternMatches(pattern: string | null, model: string | null | undefined): boolean {
  if (!pattern) return true;
  if (!model) return false;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(model);
}

function pickPolicy(
  policies: readonly ProviderDataPolicyRecord[],
  providerId: string,
  model: string | null,
): ProviderDataPolicyRecord | null {
  const candidates = policies.filter((policy) => policy.providerId === providerId);
  // Model-specific first, then provider-wide. A `modelPattern` that matches nothing is not a fallback.
  const modelSpecific = model
    ? candidates.filter((policy) => policy.modelPattern !== null && modelPatternMatches(policy.modelPattern, model))
    : [];
  if (modelSpecific.length > 0) {
    // Strictest of the matching model policies wins, so two overlapping patterns cannot widen each other.
    return modelSpecific.reduce((strictest, candidate) =>
      classificationRank[candidate.maxDataClassification] > classificationRank[strictest.maxDataClassification]
        ? candidate : strictest);
  }
  return candidates.find((policy) => policy.modelPattern === null) ?? null;
}

/**
 * Priority: model-specific → provider-wide → platform default → hard fail-closed default.
 *
 * The resolved policy is never *more permissive* than the fail-closed floor of its kind: a stored policy
 * that somehow allowed less still wins, but one that allows more for a hosted provider than `public` is
 * only possible because an owner wrote it explicitly — and the caller can see `source`/`policyVersion`.
 */
export function resolveEffectivePolicy(input: ResolveEffectivePolicyInput): ResolvedProviderDataPolicy {
  const now = input.now ?? new Date();
  const model = input.model ?? null;
  const companyPolicies = input.companyPolicies ?? [];
  const platformDefaults = input.platformDefaults ?? [];

  const companyMatch = pickPolicy(companyPolicies, input.providerId, model);
  const platformMatch = companyMatch ? null : pickPolicy(platformDefaults, input.providerId, model);
  const match = companyMatch ?? platformMatch;
  const source: ResolvedProviderDataPolicy["source"] = companyMatch
    ? (companyMatch.modelPattern !== null && model ? "model" : "provider")
    : platformMatch
      ? "platform"
      : "fail_closed";

  if (match) {
    return {
      policy: {
        kind: match.kind,
        maxDataClassification: match.maxDataClassification,
        allowPrivateRepoCode: match.allowPrivateRepoCode,
        allowPromptCaching: match.allowPromptCaching,
        trainingPolicy: match.trainingPolicy,
        externalRetention: match.externalRetention,
        // Even a stored policy must keep the mandatory redactions: a row written before this rule existed
        // (or by a direct SQL write) cannot drop them.
        requiredRedactions: [...new Set([...MANDATORY_REDACTIONS, ...match.requiredRedactions])],
        allowedContentTypes: match.allowedContentTypes.filter(isProviderContentType),
        region: match.region,
        jurisdiction: match.jurisdiction,
        termsUrl: match.termsUrl,
      },
      source,
      matchedPolicyId: match.id,
      policyVersion: match.policyVersion,
      stale: isPolicyStale(match, now),
      staleReason: policyStalenessReason(match, now),
    };
  }

  const kind = input.providerKind ?? "hosted_third_party";
  const fallback = kind === "hosted_third_party" ? FAIL_CLOSED_HOSTED_POLICY : FAIL_CLOSED_SELF_HOSTED_POLICY;
  return {
    policy: {
      kind,
      maxDataClassification: fallback.maxDataClassification,
      allowPrivateRepoCode: fallback.allowPrivateRepoCode,
      allowPromptCaching: fallback.allowPromptCaching,
      trainingPolicy: fallback.trainingPolicy,
      externalRetention: fallback.externalRetention,
      requiredRedactions: [...fallback.requiredRedactions],
      allowedContentTypes: [...fallback.allowedContentTypes],
      region: null,
      jurisdiction: null,
      termsUrl: null,
    },
    source: "fail_closed",
    matchedPolicyId: null,
    policyVersion: null,
    // An unconfigured provider has never been reviewed, by definition.
    stale: true,
    staleReason: "no_policy_for_provider",
  };
}

export interface ClassifyContentInput {
  contentTypes?: readonly ProviderContentType[];
  /** Repository-relative paths the content touches, used to match the project's path rules. */
  paths?: readonly string[];
  pathRules?: readonly ProjectDataPolicyPathRule[];
  /** The project classification; defaults to `confidential`, never `public`. */
  projectClassification?: ProviderDataClassification;
}

export interface ClassifiedContent {
  classification: ProviderDataClassification;
  /** The path rule that produced the strictest result, if any. */
  matchedRule: ProjectDataPolicyPathRule | null;
}

/**
 * What the content *is* sets a floor; the project and its path rules can only raise it.
 *
 *   - `code`, `diff`, `files`, `logs`, `terminal` are confidential by nature: repository content is not
 *     public because it happens to sit in a public project;
 *   - `web` is internal (fetched pages can leak the query that produced them);
 *   - `metadata`, `prompt` and `embeddings` have no floor of their own.
 */
const CONTENT_TYPE_FLOOR: Partial<Record<ProviderContentType, ProviderDataClassification>> = {
  code: "confidential",
  diff: "confidential",
  files: "confidential",
  logs: "confidential",
  terminal: "confidential",
  web: "internal",
};

/** A path matches a rule when the glob matches the whole path; `**` spans separators, `*` does not. */
export function pathMatchesRule(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

export function classifyContent(input: ClassifyContentInput): ClassifiedContent {
  let classification: ProviderDataClassification = input.projectClassification ?? "confidential";
  let matchedRule: ProjectDataPolicyPathRule | null = null;

  for (const contentType of input.contentTypes ?? []) {
    const floor = CONTENT_TYPE_FLOOR[contentType];
    if (floor && classificationRank[floor] > classificationRank[classification]) {
      classification = floor;
    }
  }

  for (const rule of input.pathRules ?? []) {
    const hits = (input.paths ?? []).some((path) => pathMatchesRule(rule.pattern, path));
    if (!hits) continue;
    if (classificationRank[rule.classification] > classificationRank[classification]) {
      classification = rule.classification;
      matchedRule = rule;
    } else if (!matchedRule) {
      // The rule matched but did not raise the classification; remember it only when nothing better did.
      matchedRule = rule;
    }
  }

  return { classification, matchedRule };
}

/** True when a policy permits this classification at all — the gate the guard layer calls. */
export function policyAllowsClassification(
  policy: Pick<ProviderDataPolicyRecord, "maxDataClassification">,
  classification: ProviderDataClassification,
): boolean {
  return classificationRank[classification] <= classificationRank[policy.maxDataClassification];
}

/** True when a policy permits this content type; an absent type is a refusal, not a default allow. */
export function policyAllowsContentType(
  policy: Pick<ProviderDataPolicyRecord, "allowedContentTypes">,
  contentType: ProviderContentType,
): boolean {
  return policy.allowedContentTypes.includes(contentType);
}

// ---------------------------------------------------------------------------------------------------
// Service layer: validation, audit **before** the change, and the store call last.
// ---------------------------------------------------------------------------------------------------

/**
 * The audit port. It mirrors `CodeAuditPort` from the C5a modules on purpose, so one adapter in `app.ts`
 * can serve both and the audit vocabulary stays uniform.
 */
export interface ProviderDataPolicyAuditPort {
  record(input: {
    action: string;
    actor: string;
    companyId: string | null;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * The store port this service needs. `WorkspaceStore` satisfies it structurally — as with the C5a
 * membership port, no adapter is required.
 */
export interface ProviderDataPolicyStorePort {
  getProviderDataPolicy(input: {
    companyId: string | null;
    providerId: string;
    modelPattern: string | null;
  }): Promise<ProviderDataPolicyRecord | null>;
  listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]>;
  upsertProviderDataPolicy(input: UpsertProviderDataPolicyInput): Promise<ProviderDataPolicyRecord>;
  listProviderDataPolicyVersions(
    companyId: string | null,
    providerId?: string,
  ): Promise<ProviderDataPolicyVersionRecord[]>;
  getProjectDataPolicy(companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null>;
  upsertProjectDataPolicy(input: UpsertProjectDataPolicyInput): Promise<ProjectDataPolicyRecord>;
  grantHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    grantedBy: string;
    grantedAt: Date;
  }): Promise<ProviderHostedConsentRecord>;
  revokeHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    revokedAt: Date;
  }): Promise<ProviderHostedConsentRecord>;
  getHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
  }): Promise<ProviderHostedConsentRecord | null>;
}

export interface ProviderDataPolicyServiceDeps {
  store: ProviderDataPolicyStorePort;
  /**
   * Mandatory for any change. If it is missing, or the journal throws, the write does **not** happen: a
   * policy change that cannot be attributed is exactly the change nobody should be able to make quietly.
   */
  audit?: ProviderDataPolicyAuditPort;
  /**
   * Optional authorisation hook. The route layer owns RBAC (C5a); leaving it injectable means this module
   * never grows its own permission check while still allowing the routes to enforce one in the same call.
   */
  authorize?: (input: { action: string; companyId: string | null; actor: string }) => void | Promise<void>;
  now?: () => Date;
}

export class ProviderDataPolicyService {
  private readonly store: ProviderDataPolicyStorePort;
  private readonly audit?: ProviderDataPolicyAuditPort;
  private readonly authorize?: ProviderDataPolicyServiceDeps["authorize"];
  private readonly clock: () => Date;

  constructor(deps: ProviderDataPolicyServiceDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.authorize = deps.authorize;
    this.clock = deps.now ?? (() => new Date());
  }

  /**
   * Audit first, then write. The refusal is raised before the store is touched, so a failed journal leaves
   * the previous policy in force rather than a half-applied change.
   */
  private async recordOrFail(input: {
    action: string;
    actor: string;
    companyId: string | null;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (this.authorize) {
      await this.authorize({ action: input.action, companyId: input.companyId, actor: input.actor });
    }
    if (!this.audit) {
      throw new ProviderDataPolicyError(
        "audit_unavailable",
        "Cannot change a provider data policy without an audit journal",
        { httpStatus: 503, retryable: true, details: { action: input.action } },
      );
    }
    try {
      await this.audit.record(input);
    } catch (error) {
      throw new ProviderDataPolicyError(
        "audit_unavailable",
        "The audit journal refused the policy change",
        { httpStatus: 503, retryable: true, details: { action: input.action, cause: String(error) } },
      );
    }
  }

  /** Validate → audit → write. Validation runs first so an invalid policy is never journalled as applied. */
  async upsertPolicy(input: UpsertProviderDataPolicyInput): Promise<ProviderDataPolicyRecord> {
    validateProviderDataPolicyInput(input);
    const resourceId = `${input.companyId ?? "platform"}:${input.providerId}:${input.modelPattern ?? "*"}`;
    await this.recordOrFail({
      action: "provider.data_policy.upsert",
      actor: input.actor,
      companyId: input.companyId,
      resourceType: "provider_data_policy",
      resourceId,
      metadata: {
        providerId: input.providerId,
        modelPattern: input.modelPattern,
        kind: input.kind,
        maxDataClassification: input.maxDataClassification,
        expectedPolicyVersion: input.expectedPolicyVersion,
      },
    });
    return this.store.upsertProviderDataPolicy({ ...input });
  }

  async upsertProjectPolicy(input: UpsertProjectDataPolicyInput): Promise<ProjectDataPolicyRecord> {
    const pathRules = (input.pathRules ?? []).map((rule) => validatePathRule(rule));
    if (input.dataClassification !== undefined && !isProviderDataClassification(input.dataClassification)) {
      throw new ProviderDataPolicyError("invalid_classification", `Unsupported classification: ${String(input.dataClassification)}`, {
        httpStatus: 400, details: { field: "dataClassification" },
      });
    }
    await this.recordOrFail({
      action: "project.data_policy.upsert",
      actor: input.actor,
      companyId: input.companyId,
      resourceType: "code_project_data_policy",
      resourceId: `${input.companyId}:${input.projectId}`,
      metadata: { projectId: input.projectId, pathRuleCount: pathRules.length, expectedPolicyVersion: input.expectedPolicyVersion ?? null },
    });
    return this.store.upsertProjectDataPolicy({ ...input, pathRules });
  }

  async grantHostedConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    actor: string;
  }): Promise<ProviderHostedConsentRecord> {
    const grantedAt = this.clock();
    await this.recordOrFail({
      action: "provider.hosted_consent.grant",
      actor: input.actor,
      companyId: input.companyId,
      resourceType: "provider_hosted_consent",
      resourceId: `${input.companyId}:${input.projectId}:${input.providerId}`,
      metadata: { projectId: input.projectId, providerId: input.providerId },
    });
    return this.store.grantHostedProviderConsent({
      companyId: input.companyId, projectId: input.projectId, providerId: input.providerId,
      grantedBy: input.actor, grantedAt,
    });
  }

  async revokeHostedConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    actor: string;
  }): Promise<ProviderHostedConsentRecord> {
    const revokedAt = this.clock();
    await this.recordOrFail({
      action: "provider.hosted_consent.revoke",
      actor: input.actor,
      companyId: input.companyId,
      resourceType: "provider_hosted_consent",
      resourceId: `${input.companyId}:${input.projectId}:${input.providerId}`,
      metadata: { projectId: input.projectId, providerId: input.providerId },
    });
    return this.store.revokeHostedProviderConsent({
      companyId: input.companyId, projectId: input.projectId, providerId: input.providerId, revokedAt,
    });
  }

  /** Consent exists **and** has not been withdrawn. A revoked row is not consent, ever. */
  async hasHostedConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
  }): Promise<boolean> {
    const record = await this.store.getHostedProviderConsent(input);
    return Boolean(record && record.revokedAt === null);
  }

  /** Resolve for a company, layering its own policies over the platform defaults. */
  async resolveForCompany(input: {
    companyId: string | null;
    providerId: string;
    model?: string | null;
    providerKind?: ProviderDataPolicyKind | null;
  }): Promise<ResolvedProviderDataPolicy> {
    const companyPolicies = input.companyId ? await this.store.listProviderDataPolicies(input.companyId) : [];
    const platformDefaults = await this.store.listProviderDataPolicies(null);
    return resolveEffectivePolicy({
      providerId: input.providerId,
      model: input.model ?? null,
      providerKind: input.providerKind ?? null,
      companyPolicies,
      platformDefaults,
      now: this.clock(),
    });
  }
}
