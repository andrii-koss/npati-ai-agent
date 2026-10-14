import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type {
  ProviderDataPolicyRecord,
  UpsertProviderDataPolicyStoreInput,
  ProviderDataPolicyVersionRecord,
  ProjectDataPolicyRecord,
  UpsertProjectDataPolicyStoreInput,
  ProjectDataPolicyPathRule,
  ProviderHostedConsentRecord,
} from "./types";
import {
  DEFAULT_DATA_CLASSIFICATION,
  isProviderDataPolicyKind,
  isClassificationAtLeast,
  isProviderTrainingPolicy,
  isExternalRetention,
  isProviderRedactionKind,
  isProviderContentType,
  MANDATORY_PROVIDER_REDACTIONS,
  ProviderDataPolicyStoreError,
} from "./types";
import {
  providerDataPolicyColumns,
  providerDataPolicyVersionColumns,
  projectDataPolicyColumns,
  hostedProviderConsentColumns,
} from "./postgres-store-schema";

export function assertValidProviderPolicy(input: UpsertProviderDataPolicyStoreInput): void {
    if (!isProviderDataPolicyKind(input.kind)) {
      throw new ProviderDataPolicyStoreError("invalid_policy_field", `Unsupported provider kind: ${String(input.kind)}`, {
        httpStatus: 400, details: { field: "kind" },
      });
    }
    if (!isClassificationAtLeast(input.maxDataClassification, "public")) {
      throw new ProviderDataPolicyStoreError(
        "invalid_classification",
        `Unsupported classification: ${String(input.maxDataClassification)}`,
        { httpStatus: 400, details: { field: "maxDataClassification" } },
      );
    }
    if (!isProviderTrainingPolicy(input.trainingPolicy)) {
      throw new ProviderDataPolicyStoreError(
        "invalid_policy_field",
        `Unsupported training policy: ${String(input.trainingPolicy)}`,
        { httpStatus: 400, details: { field: "trainingPolicy" } },
      );
    }
    if (!isExternalRetention(input.externalRetention)) {
      throw new ProviderDataPolicyStoreError(
        "invalid_retention",
        `Unsupported external retention: ${String(input.externalRetention)}`,
        { httpStatus: 400, details: { field: "externalRetention" } },
      );
    }
    const redactions = input.requiredRedactions ?? MANDATORY_PROVIDER_REDACTIONS;
    for (const kind of redactions) {
      if (!isProviderRedactionKind(kind)) {
        throw new ProviderDataPolicyStoreError("invalid_policy_field", `Unsupported redaction kind: ${String(kind)}`, {
          httpStatus: 400, details: { field: "requiredRedactions" },
        });
      }
    }
    const missing = MANDATORY_PROVIDER_REDACTIONS.filter((kind) => !redactions.includes(kind));
    if (missing.length > 0) {
      throw new ProviderDataPolicyStoreError(
        "invalid_policy_field",
        `Required redactions must include: ${missing.join(", ")}`,
        { httpStatus: 400, details: { field: "requiredRedactions", missing } },
      );
    }
    for (const contentType of input.allowedContentTypes ?? ["metadata"]) {
      if (!isProviderContentType(contentType)) {
        throw new ProviderDataPolicyStoreError(
          "invalid_policy_field",
          `Unsupported content type: ${String(contentType)}`,
          { httpStatus: 400, details: { field: "allowedContentTypes" } },
        );
      }
    }
  }

export async function getProviderDataPolicy(pool: Pool, input: {
    companyId: string | null;
    providerId: string;
    modelPattern: string | null;
  }): Promise<ProviderDataPolicyRecord | null> {
    const result = await pool.query<ProviderDataPolicyRecord>(
      `SELECT ${providerDataPolicyColumns} FROM provider_data_policies
       WHERE COALESCE(company_id,'')=COALESCE($1,'') AND provider_id=$2 AND COALESCE(model_pattern,'')=COALESCE($3,'')`,
      [input.companyId, input.providerId, input.modelPattern],
    );
    return result.rows[0] ?? null;
  }

export async function listProviderDataPolicies(pool: Pool, companyId: string | null): Promise<ProviderDataPolicyRecord[]> {
    const result = await pool.query<ProviderDataPolicyRecord>(
      `SELECT ${providerDataPolicyColumns} FROM provider_data_policies
       WHERE COALESCE(company_id,'')=COALESCE($1,'')
       ORDER BY provider_id, model_pattern`,
      [companyId],
    );
    return result.rows;
  }

export async function upsertProviderDataPolicy(pool: Pool, input: UpsertProviderDataPolicyStoreInput): Promise<ProviderDataPolicyRecord> {
    assertValidProviderPolicy(input);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<ProviderDataPolicyRecord>(
        `SELECT ${providerDataPolicyColumns} FROM provider_data_policies
         WHERE COALESCE(company_id,'')=COALESCE($1,'') AND provider_id=$2 AND COALESCE(model_pattern,'')=COALESCE($3,'')
         FOR UPDATE`,
        [input.companyId, input.providerId, input.modelPattern],
      );
      const existing = current.rows[0] ?? null;
      if (input.expectedPolicyVersion === null && existing) {
        throw new ProviderDataPolicyStoreError("data_policy_revision_conflict", "A policy for this provider already exists", {
          httpStatus: 409, details: { expectedPolicyVersion: null, actualPolicyVersion: existing.policyVersion },
        });
      }
      if (typeof input.expectedPolicyVersion === "number") {
        if (!existing) {
          throw new ProviderDataPolicyStoreError("data_policy_not_found", "No policy to update for this provider", {
            httpStatus: 404, details: { expectedPolicyVersion: input.expectedPolicyVersion },
          });
        }
        if (existing.policyVersion !== input.expectedPolicyVersion) {
          throw new ProviderDataPolicyStoreError(
            "data_policy_revision_conflict",
            "Provider data policy changed by another request. Reload and try again.",
            {
              httpStatus: 409,
              details: { expectedPolicyVersion: input.expectedPolicyVersion, actualPolicyVersion: existing.policyVersion },
            },
          );
        }
      }

      const redactions = [...new Set([...MANDATORY_PROVIDER_REDACTIONS, ...(input.requiredRedactions ?? [])])];
      const contentTypes = [...new Set(input.allowedContentTypes ?? ["metadata"])];
      const result = await client.query<ProviderDataPolicyRecord>(
        `INSERT INTO provider_data_policies
           (id, company_id, provider_id, model_pattern, policy_version, kind, allow_private_repo_code,
            max_data_classification, allow_prompt_caching, external_retention, training_policy, region,
            jurisdiction, required_redactions, allowed_content_types, terms_url, last_reviewed_at, reviewed_by,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now())
         ON CONFLICT (COALESCE(company_id,''), provider_id, COALESCE(model_pattern,'')) DO UPDATE SET
           kind=EXCLUDED.kind,
           allow_private_repo_code=EXCLUDED.allow_private_repo_code,
           max_data_classification=EXCLUDED.max_data_classification,
           allow_prompt_caching=EXCLUDED.allow_prompt_caching,
           external_retention=EXCLUDED.external_retention,
           training_policy=EXCLUDED.training_policy,
           region=EXCLUDED.region,
           jurisdiction=EXCLUDED.jurisdiction,
           required_redactions=EXCLUDED.required_redactions,
           allowed_content_types=EXCLUDED.allowed_content_types,
           terms_url=EXCLUDED.terms_url,
           last_reviewed_at=EXCLUDED.last_reviewed_at,
           reviewed_by=EXCLUDED.reviewed_by,
           policy_version=provider_data_policies.policy_version+1,
           updated_at=now()
         RETURNING ${providerDataPolicyColumns}`,
        [existing?.id ?? `pdp_${randomUUID()}`, input.companyId, input.providerId, input.modelPattern, input.kind,
          input.allowPrivateRepoCode, input.maxDataClassification, input.allowPromptCaching, input.externalRetention,
          input.trainingPolicy, input.region ?? null, input.jurisdiction ?? null, redactions, contentTypes,
          input.termsUrl ?? null, input.lastReviewedAt ?? null, input.reviewedBy ?? null],
      );
      const record = result.rows[0]!;

      await client.query(
        `INSERT INTO provider_data_policy_versions
           (id, company_id, provider_id, model_pattern, policy_version, payload, actor, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (COALESCE(company_id,''), provider_id, COALESCE(model_pattern,''), policy_version) DO NOTHING`,
        [randomUUID(), record.companyId, record.providerId, record.modelPattern, record.policyVersion,
          JSON.stringify(record), input.actor],
      );

      await client.query("COMMIT");
      return record;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

export async function listProviderDataPolicyVersions(pool: Pool, 
    companyId: string | null,
    providerId?: string,
    modelPattern?: string | null,
  ): Promise<ProviderDataPolicyVersionRecord[]> {
    const result = await pool.query<ProviderDataPolicyVersionRecord>(
      `SELECT ${providerDataPolicyVersionColumns} FROM provider_data_policy_versions
       WHERE COALESCE(company_id,'')=COALESCE($1,'') AND ($2::text IS NULL OR provider_id=$2)
       ORDER BY policy_version, created_at`,
      [companyId, providerId ?? null],
    );
    return result.rows;
  }

export async function getProjectDataPolicy(pool: Pool, companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null> {
    const result = await pool.query<ProjectDataPolicyRecord>(
      `SELECT ${projectDataPolicyColumns} FROM code_project_data_policies
       WHERE company_id=$1 AND project_id=$2`,
      [companyId, projectId],
    );
    return result.rows[0] ?? null;
  }

export async function upsertProjectDataPolicy(pool: Pool, input: UpsertProjectDataPolicyStoreInput): Promise<ProjectDataPolicyRecord> {
    const current = await getProjectDataPolicy(pool, input.companyId, input.projectId);
    if (input.expectedPolicyVersion === null && current) {
      throw new ProviderDataPolicyStoreError("data_policy_revision_conflict", "A project data policy already exists", {
        httpStatus: 409, details: { expectedPolicyVersion: null, actualPolicyVersion: current.policyVersion },
      });
    }
    if (typeof input.expectedPolicyVersion === "number" && current
      && current.policyVersion !== input.expectedPolicyVersion) {
      throw new ProviderDataPolicyStoreError(
        "data_policy_revision_conflict",
        "Project data policy changed by another request. Reload and try again.",
        {
          httpStatus: 409,
          details: { expectedPolicyVersion: input.expectedPolicyVersion, actualPolicyVersion: current.policyVersion },
        },
      );
    }
    const classification = input.dataClassification ?? current?.dataClassification ?? DEFAULT_DATA_CLASSIFICATION;
    if (!isClassificationAtLeast(classification, "public")) {
      throw new ProviderDataPolicyStoreError("invalid_classification", `Unsupported classification: ${String(classification)}`, {
        httpStatus: 400, details: { field: "dataClassification" },
      });
    }
    const pathRules = (input.pathRules ?? current?.pathRules ?? []).map((rule) => assertValidPathRule(rule));
    const result = await pool.query<ProjectDataPolicyRecord>(
      `INSERT INTO code_project_data_policies
         (company_id, project_id, data_classification, path_rules, policy_version, updated_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,1,$5,now(),now())
       ON CONFLICT (company_id, project_id) DO UPDATE SET
         data_classification=EXCLUDED.data_classification,
         path_rules=EXCLUDED.path_rules,
         updated_by=EXCLUDED.updated_by,
         policy_version=code_project_data_policies.policy_version+1,
         updated_at=now()
       RETURNING ${projectDataPolicyColumns}`,
      [input.companyId, input.projectId, classification, JSON.stringify(pathRules), input.actor],
    );
    return result.rows[0]!;
  }

export function assertValidPathRule(rule: ProjectDataPolicyPathRule): ProjectDataPolicyPathRule {
    const pattern = rule && typeof rule.pattern === "string" ? rule.pattern.trim() : "";
    const escapes = pattern.length === 0 || pattern.startsWith("/") || pattern.startsWith("~")
      || pattern.includes("\\") || pattern.split("/").some((segment) => segment === "..");
    if (escapes) {
      throw new ProviderDataPolicyStoreError(
        "invalid_policy_path_rule",
        `Path rule must stay inside the project: ${String(rule?.pattern)}`,
        { httpStatus: 400, details: { field: "pathRules", pattern: rule?.pattern } },
      );
    }
    if (!isClassificationAtLeast(rule.classification, "public")) {
      throw new ProviderDataPolicyStoreError(
        "invalid_classification",
        `Unsupported classification in path rule: ${String(rule.classification)}`,
        { httpStatus: 400, details: { field: "classification", pattern } },
      );
    }
    return { pattern, classification: rule.classification };
  }

export async function grantHostedProviderConsent(pool: Pool, input: {
    companyId: string;
    projectId: string;
    providerId: string;
    grantedBy: string;
    grantedAt?: Date;
  }): Promise<ProviderHostedConsentRecord> {

    const result = await pool.query<ProviderHostedConsentRecord>(
      `INSERT INTO provider_hosted_consent
         (company_id, project_id, provider_id, granted_by, granted_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,NULL)
       ON CONFLICT (company_id, project_id, provider_id) DO UPDATE SET
         granted_by=EXCLUDED.granted_by, granted_at=EXCLUDED.granted_at, revoked_at=NULL
       RETURNING ${hostedProviderConsentColumns}`,
      [input.companyId, input.projectId, input.providerId, input.grantedBy, input.grantedAt ?? new Date()],
    );
    return result.rows[0]!;
  }

export async function revokeHostedProviderConsent(pool: Pool, input: {
    companyId: string;
    projectId: string;
    providerId: string;
    revokedAt?: Date;
  }): Promise<ProviderHostedConsentRecord> {
    const result = await pool.query<ProviderHostedConsentRecord>(
      `UPDATE provider_hosted_consent SET revoked_at=$4
       WHERE company_id=$1 AND project_id=$2 AND provider_id=$3
       RETURNING ${hostedProviderConsentColumns}`,
      [input.companyId, input.projectId, input.providerId, input.revokedAt ?? new Date()],
    );
    if (!result.rows[0]) {
      throw new ProviderDataPolicyStoreError("data_policy_not_found", "No hosted provider consent to revoke", {
        httpStatus: 404, details: { providerId: input.providerId },
      });
    }
    return result.rows[0];
  }

export async function getHostedProviderConsent(pool: Pool, input: {
    companyId: string;
    projectId: string;
    providerId: string;
  }): Promise<ProviderHostedConsentRecord | null> {
    const result = await pool.query<ProviderHostedConsentRecord>(
      `SELECT ${hostedProviderConsentColumns} FROM provider_hosted_consent
       WHERE company_id=$1 AND project_id=$2 AND provider_id=$3`,
      [input.companyId, input.projectId, input.providerId],
    );
    return result.rows[0] ?? null;
  }

