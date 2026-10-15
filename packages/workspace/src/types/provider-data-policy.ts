import { WorkspaceAccessError } from "./errors";
import type { DataClassification } from "./retention";

export type ProviderDataPolicyKind = "hosted_third_party" | "self_hosted" | "local";
export const PROVIDER_DATA_POLICY_KINDS: readonly ProviderDataPolicyKind[] =
  ["hosted_third_party", "self_hosted", "local"] as const;
export type ProviderTrainingPolicy = "no_training" | "may_train" | "unknown";
export const PROVIDER_TRAINING_POLICIES: readonly ProviderTrainingPolicy[] =
  ["no_training", "may_train", "unknown"] as const;
export type ProviderRedactionKind = "secrets" | "tokens" | "keys" | "pii" | "email" | "internal_hostnames";
export const PROVIDER_REDACTION_KINDS: readonly ProviderRedactionKind[] =
  ["secrets", "tokens", "keys", "pii", "email", "internal_hostnames"] as const;
/** Redaction no policy may switch off (mirrored in the app-side validator). */
export const MANDATORY_PROVIDER_REDACTIONS: readonly ProviderRedactionKind[] =
  ["secrets", "tokens", "keys"] as const;
export type ProviderContentType =
  | "metadata" | "prompt" | "code" | "diff" | "files" | "logs" | "terminal" | "web" | "embeddings";
export const PROVIDER_CONTENT_TYPES: readonly ProviderContentType[] =
  ["metadata", "prompt", "code", "diff", "files", "logs", "terminal", "web", "embeddings"] as const;
export type ExternalRetention = "none" | "unknown" | `N_days:${number}`;

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
/** `none` | `unknown` | `N_days:<days>`; anything else is refused rather than stored as-is. */
export function isExternalRetention(value: unknown): value is ExternalRetention {
  return value === "none" || value === "unknown"
    || (typeof value === "string" && /^N_days:\d{1,5}$/.test(value));
}

export interface ProviderDataPolicyRecord {
  id: string;
  /** `null` = platform default for every company. */
  companyId: string | null;
  providerId: string;
  /** `null` = the whole provider. */
  modelPattern: string | null;
  policyVersion: number;
  kind: ProviderDataPolicyKind;
  allowPrivateRepoCode: boolean;
  maxDataClassification: DataClassification;
  allowPromptCaching: boolean;
  externalRetention: ExternalRetention;
  trainingPolicy: ProviderTrainingPolicy;
  /**
   * Always present in a stored row (the column is nullable, so the value is `null` rather than absent).
   * They are required-but-nullable on purpose: that is what makes `WorkspaceStore` structurally assignable
   * to the app-side `ProviderDataPolicyStorePort`, whose record mirrors this one.
   */
  region: string | null;
  jurisdiction: string | null;
  requiredRedactions: ProviderRedactionKind[];
  allowedContentTypes: ProviderContentType[];
  termsUrl: string | null;
  lastReviewedAt: Date | null;
  reviewedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `expectedPolicyVersion: null` means "this must not exist yet"; a number means "replace exactly this". */
export interface UpsertProviderDataPolicyStoreInput {
  companyId: string | null;
  providerId: string;
  modelPattern: string | null;
  actor: string;
  kind: ProviderDataPolicyKind;
  allowPrivateRepoCode: boolean;
  maxDataClassification: DataClassification;
  allowPromptCaching: boolean;
  externalRetention: ExternalRetention;
  trainingPolicy: ProviderTrainingPolicy;
  region?: string | null;
  jurisdiction?: string | null;
  requiredRedactions?: readonly ProviderRedactionKind[];
  allowedContentTypes?: readonly ProviderContentType[];
  termsUrl?: string | null;
  lastReviewedAt?: Date | null;
  reviewedBy?: string | null;
  expectedPolicyVersion: number | null;
}

export interface ProviderDataPolicyVersionRecord {
  id: string;
  companyId: string | null;
  providerId: string;
  modelPattern: string | null;
  policyVersion: number;
  payload: unknown;
  actor: string;
  createdAt: Date;
}

export interface ProjectDataPolicyPathRule {
  pattern: string;
  classification: DataClassification;
}

export interface ProjectDataPolicyRecord {
  companyId: string;
  projectId: string;
  /** Never absent: an unconfigured project is `confidential`, not "unspecified". */
  dataClassification: DataClassification;
  pathRules: ProjectDataPolicyPathRule[];
  policyVersion: number;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertProjectDataPolicyStoreInput {
  companyId: string;
  projectId: string;
  actor: string;
  dataClassification?: DataClassification;
  pathRules?: readonly ProjectDataPolicyPathRule[];
  /** `null` = must not exist yet; a number = replace exactly that version; `undefined` = no check. */
  expectedPolicyVersion?: number | null;
  /** Path rules are validated app-side as well; the store refuses an escape rather than normalising it. */
}

export interface ProviderHostedConsentRecord {
  companyId: string;
  projectId: string;
  providerId: string;
  grantedBy: string;
  grantedAt: Date;
  /** Non-null means withdrawn, and therefore "no consent". */
  revokedAt: Date | null;
}

// --- C6a: durable Coding Agent run state ---------------------------------------------------------

/** Coarse state of one code run. `interrupted` means "the process that owned it stopped answering". */
/**
 * C6a statuses, extended by C9 with `waiting_for_user`.
 *
 * `waiting_for_user` is a valid **non-terminal** state: the run is paused on a question the user has to answer.
 * It exists as its own value precisely because C6a treats "running without a live lease" as a crash — a paused
 * run that stayed `running` would be "recovered" by every restart, replayed, and would lose the answer that was
 * on its way. Migration 081 widens the database CHECK to match.
 */

/**
 * Storage refusal for the policy tables. It extends `WorkspaceAccessError` for the same reason the C5a
 * membership errors do: the tree-wide route mappers already recognise that class, so a precise refusal is
 * never reported as an unexpected 500. Codes mirror the app-side `ProviderDataPolicyError`
 * (`data_policy_not_found` 404, `data_policy_revision_conflict` 409, and the validation codes 400).
 */
export class ProviderDataPolicyStoreError extends WorkspaceAccessError {
  override readonly code: string;
  override readonly status: number;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ProviderDataPolicyStoreError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 403;
    this.status = this.httpStatus;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

