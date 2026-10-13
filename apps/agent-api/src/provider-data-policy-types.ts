export type ProviderDataPolicyKind = "hosted_third_party" | "self_hosted" | "local";
export const PROVIDER_DATA_POLICY_KINDS: readonly ProviderDataPolicyKind[] =
  ["hosted_third_party", "self_hosted", "local"] as const;

export type ProviderTrainingPolicy = "no_training" | "may_train" | "unknown";
export const PROVIDER_TRAINING_POLICIES: readonly ProviderTrainingPolicy[] =
  ["no_training", "may_train", "unknown"] as const;

export type ProviderDataClassification = "public" | "internal" | "confidential" | "restricted";
export const PROVIDER_DATA_CLASSIFICATIONS: readonly ProviderDataClassification[] =
  ["public", "internal", "confidential", "restricted"] as const;

/** Redaction kinds. `secrets`/`tokens`/`keys` are mandatory for every kind of provider. */
export type ProviderRedactionKind = "secrets" | "tokens" | "keys" | "pii" | "email" | "internal_hostnames";
export const PROVIDER_REDACTION_KINDS: readonly ProviderRedactionKind[] =
  ["secrets", "tokens", "keys", "pii", "email", "internal_hostnames"] as const;
/** Redaction that no policy, company or owner may switch off. */
export const MANDATORY_REDACTIONS: readonly ProviderRedactionKind[] = ["secrets", "tokens", "keys"] as const;

/**
 * Content types are an **allow** list: naming a type is what permits it. `code`, `diff`, `files`, `logs`,
 * `terminal` and `web` are the sensitive ones and are absent from the fail-closed default.
 */
export type ProviderContentType =
  | "metadata" | "prompt" | "code" | "diff" | "files" | "logs" | "terminal" | "web" | "embeddings";
export const PROVIDER_CONTENT_TYPES: readonly ProviderContentType[] =
  ["metadata", "prompt", "code", "diff", "files", "logs", "terminal", "web", "embeddings"] as const;
/** The sensitive half of the vocabulary: never allowed by the fail-closed default. */
export const SENSITIVE_CONTENT_TYPES: readonly ProviderContentType[] =
  ["code", "diff", "files", "logs", "terminal", "web"] as const;

export type ExternalRetention = "none" | "unknown" | `N_days:${number}`;

export interface ProviderDataPolicyRecord {
  id: string;
  companyId: string | null;
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
  lastReviewedAt: Date | null;
  reviewedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertProviderDataPolicyInput {
  companyId: string | null;
  providerId: string;
  modelPattern: string | null;
  actor: string;
  kind: ProviderDataPolicyKind;
  allowPrivateRepoCode: boolean;
  maxDataClassification: ProviderDataClassification;
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
  classification: ProviderDataClassification;
}

export interface ProjectDataPolicyRecord {
  companyId: string;
  projectId: string;
  dataClassification: ProviderDataClassification;
  pathRules: ProjectDataPolicyPathRule[];
  policyVersion: number;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertProjectDataPolicyInput {
  companyId: string;
  projectId: string;
  actor: string;
  dataClassification?: ProviderDataClassification;
  pathRules?: readonly ProjectDataPolicyPathRule[];
  expectedPolicyVersion?: number | null;
}

export interface ProviderHostedConsentRecord {
  companyId: string;
  projectId: string;
  providerId: string;
  grantedBy: string;
  grantedAt: Date;
  revokedAt: Date | null;
}

export class ProviderDataPolicyError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ProviderDataPolicyError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 403;
    this.status = this.httpStatus;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
