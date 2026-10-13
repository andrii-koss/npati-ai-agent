import type { AuthContext } from "@npati/workspace";
import type { CodeRbacDeps } from "./code-rbac";
import {
  ProviderDataPolicyError,
  type ProviderDataPolicyService as ProviderDataPolicyStoreService,
  type ExternalRetention,
  type ProviderContentType,
  type ProviderDataClassification,
  type ProviderDataPolicyKind,
  type ProviderDataPolicyRecord,
  type ProviderDataPolicyVersionRecord,
  type ProviderHostedConsentRecord,
  type ProviderRedactionKind,
  type ProviderTrainingPolicy,
  type ProjectDataPolicyPathRule,
  type ProjectDataPolicyRecord,
} from "./provider-data-policy";

/**
 * Action names of this surface. Each is mapped in `code-rbac.ts`, so an unmapped name is refused by
 * default (`action_not_mapped`) instead of silently authorizing.
 */
export const CODE_DATA_POLICY_ACTIONS = {
  providerList: "provider.data_policy.read",
  providerUpsert: "provider.data_policy.upsert",
  providerVersions: "provider.data_policy.versions",
  projectRead: "project.data_policy.read",
  projectUpsert: "project.data_policy.upsert",
  projectLowerClassification: "project.data_policy.lower_classification",
  eligibility: "provider.data_policy.eligibility",
  hostedConsentGrant: "provider.hosted_consent.grant",
  hostedConsentRevoke: "provider.hosted_consent.revoke",
} as const;

/**
 * The actions that require the owner-level permission. Raising a classification narrows what may be sent,
 * so it is an ordinary workspace write; lowering it widens the surface, so it takes its own action name
 * and therefore the privileged permission.
 */
export const OWNER_LEVEL_DATA_POLICY_ACTIONS: readonly string[] = [
  CODE_DATA_POLICY_ACTIONS.providerUpsert,
  CODE_DATA_POLICY_ACTIONS.projectLowerClassification,
  CODE_DATA_POLICY_ACTIONS.hostedConsentGrant,
  CODE_DATA_POLICY_ACTIONS.hostedConsentRevoke,
];

// ---------------------------------------------------------------------------------------------------
// Activity events
// ---------------------------------------------------------------------------------------------------

/**
 * One `provider_policy_decision` per accepted change.
 *
 * `changes` carries **field names only** — never values — because a policy row is exactly the kind of
 * object that must not be copied into a log stream: it names terms, reviewers and jurisdictions, and a
 * future field could be a secret. `assertNoSensitiveProviderPolicyEvent` enforces that before the sink
 * sees anything.
 */
export interface ProviderPolicyActivityEvent {
  kind: "provider_policy_decision";
  companyId: string;
  providerId: string | null;
  projectId: string | null;
  action: string;
  actor: string;
  decision: "allow" | "deny";
  policyVersion: number | null;
  changes: string[];
  at: string;
}

export interface ProviderPolicyActivitySink {
  record(event: ProviderPolicyActivityEvent): void | Promise<void>;
}

/** Event keys that would carry policy or content values instead of field names. */
export const FORBIDDEN_EVENT_KEYS = [
  "payload",
  "policy",
  "policies",
  "values",
  "content",
  "contents",
  "command",
  "diff",
  "file",
  "files",
  "secret",
  "secrets",
  "token",
  "tokens",
  "termsUrl",
] as const;

/**
 * Refuse an event that carries policy values, content or a secret anywhere in it. Called for every
 * event, so a future field added to the event type cannot quietly start leaking the policy it describes.
 */
export function assertNoSensitiveProviderPolicyEvent(event: ProviderPolicyActivityEvent): void {
  for (const key of Object.keys(event)) {
    if ((FORBIDDEN_EVENT_KEYS as readonly string[]).includes(key)) {
      throw new ProviderDataPolicyError(
        "policy_event_contains_values",
        `A provider policy activity event must not carry "${key}"`,
        { httpStatus: 500, details: { field: key } },
      );
    }
  }
  for (const change of event.changes) {
    // A change entry is a field *name*; `key=value` or `key: value` would be a value.
    if (/[:=]/.test(change)) {
      throw new ProviderDataPolicyError(
        "policy_event_contains_values",
        `Activity change entries must be field names, got "${change}"`,
        { httpStatus: 500, details: { change } },
      );
    }
  }
  if (/(secret|password|passwd|api[_-]?key|bearer)\s*[:=]\s*\S/i.test(JSON.stringify(event))) {
    throw new ProviderDataPolicyError(
      "policy_event_contains_values",
      "A provider policy activity event must not contain a secret value",
      { httpStatus: 500 },
    );
  }
}

// ---------------------------------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------------------------------

export interface ProviderPolicyView {
  id: string;
  providerId: string;
  modelPattern: string | null;
  policyVersion: number;
  kind: ProviderDataPolicyKind;
  allowPrivateRepoCode: boolean;
  maxDataClassification: ProviderDataClassification;
  allowPromptCaching: boolean;
  externalRetention: ExternalRetention;
  trainingPolicy: ProviderTrainingPolicy;
  region: string | null;
  jurisdiction: string | null;
  requiredRedactions: ProviderRedactionKind[];
  allowedContentTypes: ProviderContentType[];
  termsUrl: string | null;
  lastReviewedAt: string | null;
  reviewedBy: string | null;
  updatedAt: string;
  /** True when the review is missing or older than the 180-day trust window. */
  stale: boolean;
  staleReason: string | null;
  /** Human-facing warnings the UI shows next to the row. */
  warnings: string[];
}

export interface ProjectDataPolicyView {
  projectId: string;
  /** What the C5b policy table holds (the authoritative source for provider decisions). */
  dataClassification: ProviderDataClassification;
  /** The project record's own C1 classification, when one could be read. */
  projectRecordClassification: ProviderDataClassification;
  /** The strictest of the two — what the guard and the eligibility answer must use. */
  effectiveClassification: ProviderDataClassification;
  /** True when the project record is what raises the effective value above the C5b row. */
  effectiveFromProjectRecord: boolean;
  pathRules: ProjectDataPolicyPathRule[];
  policyVersion: number;
  /** False when nothing is stored yet and the view is the `confidential` default. */
  configured: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * Reads the project record's own classification (C1). Injected rather than imported so this module keeps
 * no dependency on the project service, and so a deployment without that reader still gets the
 * conservative `confidential` floor instead of "no constraint".
 */
export interface ProjectClassificationPort {
  readProjectClassification(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<ProviderDataClassification | null>;
}

export interface ProviderEligibilityCandidate {
  providerId: string;
  model?: string | null;
  /**
   * What the provider registry says about this provider. Absent means "unknown", which the resolver
   * treats as a hosted third party — the least trusted kind.
   */
  kind?: ProviderDataPolicyKind | null;
}

export interface ProviderEligibilityEntry {
  providerId: string;
  model: string | null;
  eligible: boolean;
  reasons: string[];
  hosted: boolean;
  requiresHostedConsent: boolean;
  hostedConsentGranted: boolean;
  dataClassification: ProviderDataClassification;
  maxDataClassification: ProviderDataClassification;
  allowedContentTypes: ProviderContentType[];
  policySource: string;
  policyVersion: number | null;
  stale: boolean;
  staleReason: string | null;
}

export interface ProviderEligibilityReport {
  projectId: string;
  dataClassification: ProviderDataClassification;
  contentTypes: ProviderContentType[];
  entries: ProviderEligibilityEntry[];
  /** The model/provider a code session should use first, when one is eligible. */
  preferred: { providerId: string; model: string | null } | null;
}

// ---------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------

export interface UpsertProviderPolicyCommand {
  modelPattern?: string | null;
  kind?: ProviderDataPolicyKind;
  allowPrivateRepoCode?: boolean;
  maxDataClassification?: ProviderDataClassification;
  allowPromptCaching?: boolean;
  externalRetention?: ExternalRetention | string;
  trainingPolicy?: ProviderTrainingPolicy;
  region?: string | null;
  jurisdiction?: string | null;
  requiredRedactions?: readonly ProviderRedactionKind[];
  allowedContentTypes?: readonly ProviderContentType[];
  termsUrl?: string | null;
  lastReviewedAt?: Date | string | null;
  reviewedBy?: string | null;
  /** `undefined` uses the version that was just read, which still refuses a concurrent writer. */
  expectedPolicyVersion?: number | null;
}

export interface UpsertProjectPolicyCommand {
  dataClassification?: ProviderDataClassification;
  pathRules?: readonly ProjectDataPolicyPathRule[];
  expectedPolicyVersion?: number | null;
}

export interface ProviderDataPolicyAdminServiceDeps {
  /** Read port. `WorkspaceStore` satisfies it structurally. */
  store: {
    listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]>;
    getProviderDataPolicy(input: {
      companyId: string | null;
      providerId: string;
      modelPattern: string | null;
    }): Promise<ProviderDataPolicyRecord | null>;
    listProviderDataPolicyVersions(
      companyId: string | null,
      providerId?: string,
    ): Promise<ProviderDataPolicyVersionRecord[]>;
    getProjectDataPolicy(companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null>;
    getHostedProviderConsent(input: {
      companyId: string;
      projectId: string;
      providerId: string;
    }): Promise<ProviderHostedConsentRecord | null>;
  };
  /** The audited writer from `provider-data-policy.ts` (validation → audit → store). */
  policies: ProviderDataPolicyStoreService;
  /** Company role of the caller; `null` means "not a member", which denies everything. */
  resolveRole: (ctx: AuthContext, companyId: string) => Promise<string | null>;
  /** Optional reader for the project record's own (C1) classification; see the effective-classification rule. */
  projectClassification?: ProjectClassificationPort;
  /** Journal and logger for the shared gate. Without the journal every decision refuses (fail closed). */
  rbac?: CodeRbacDeps;
  activity?: ProviderPolicyActivitySink;
  now?: () => Date;
  logger?: { warn(payload: unknown, message?: string): void };
}

export const FIELD_ORDER: readonly string[] = [
  "kind",
  "allowPrivateRepoCode",
  "maxDataClassification",
  "allowPromptCaching",
  "externalRetention",
  "trainingPolicy",
  "region",
  "jurisdiction",
  "requiredRedactions",
  "allowedContentTypes",
  "termsUrl",
  "lastReviewedAt",
  "reviewedBy",
];

export function actorOf(ctx: AuthContext): string {
  return String(ctx.userId ?? "unknown");
}

export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ProviderDataPolicyError("invalid_policy_field", `Unsupported date: ${String(value)}`, {
      httpStatus: 400,
      details: { field: "lastReviewedAt" },
    });
  }
  return date;
}
