
import { randomUUID } from "node:crypto";
import type { AuthContext, Business, BusinessInput, BusinessOnboardingSession, BusinessToCompanyInput, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentInput, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, CompanyInput, Project, ProjectCheckpoint, CreateCheckpointInput, ProjectDeployment, CreateDeploymentInput, ProjectQaReport, CreateProjectQaReportInput, ProjectInput, ProjectStatus, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview, WorkspaceStore, CodeSession, CodeSessionInput, CodeSessionStatus, ProjectCodeSettings, DataClassification, RetentionClass, AuditEntry, AuditEntryInput, AuditAnchor, AuditChainState, AuditChainVerification, FeatureFlag, FeatureFlagInput, FeatureFlagHistoryEntry, CodeToolManifest, SandboxImage, SandboxImageInput, SandboxImageVariant, CodeSessionMode, ProjectCodeTrust, ProjectCodeTrustInput, ProjectMountedFolder, ProjectMountedFolderInput, CodeApprovalRule, CodeApprovalRuleInput, CodeApprovalRuleScope,
  CompanyMember, CompanyInvite, CompanyInviteInput, AcceptCompanyInviteInput, UpdateCompanyMemberRoleInput, RemoveCompanyMemberInput,
  ProviderDataPolicyRecord, UpsertProviderDataPolicyStoreInput, ProviderDataPolicyVersionRecord, ProjectDataPolicyRecord,
  UpsertProjectDataPolicyStoreInput, ProjectDataPolicyPathRule, ProviderHostedConsentRecord, ProviderContentType,
  CodeRunStateRecord, CodeRunStateStatus, CodeRunTurnRecord, CodeRunToolCallRecord, CreateCodeRunStateInput,
  ApplyCodeRunStateEventInput, UpsertCodeRunTurnInput, CodeRunStateScanInput, CodeRunTurnScanInput,
  ListCodeRunStatesInput,
  CodeRunScanPage, CreateExecutionSnapshotInput, ExecutionSnapshotRecord, ExecutionSnapshotDiff,
  ListExecutionSnapshotsInput, SnapshotConfigKind, SnapshotConfigVersionRecord,
  CreateSnapshotConfigVersionInput, CodeActivityEventRecord, CreateCodeActivityEventInput,
  ListCodeActivityEventsInput, ReplayBundleRecord, ReplayBundleStepRecord, CreateReplayBundleInput,
  CodeContextSummaryRecord, CreateCodeContextSummaryInput, ListCodeContextSummariesInput,
  ListReplayBundlesInput, CodeProjectRef, CodeProjectRefScanInput, CodeProjectRefScanPage, CodeRunRequestRecord } from "./types";
import { WorkspaceAccessError, WorkspaceNotFoundError, CompanyMembershipError, ProviderDataPolicyStoreError, CodeRunStateStoreError, ExecutionSnapshotImmutableError, isCompanyRole, isProviderDataPolicyKind, isProviderTrainingPolicy, isProviderContentType, isProviderRedactionKind, isExternalRetention, isClassificationAtLeast, DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS, MANDATORY_PROVIDER_REDACTIONS, mergeCodeRunToolCalls, mergeCodeRunTurnOutcome, clampScanLimit, decodeCodeRunScanCursor, encodeCodeRunScanCursor, decodeCodeActivityCursor, codeRunRequestStatus } from "./types";
import { providerPolicyKey, assertValidProviderPolicy, assertValidPathRule } from "./in-memory-data-policy-rules";

export class InMemoryDataPolicyStore {
  constructor(
    private readonly providerDataPolicies = new Map<string, ProviderDataPolicyRecord>(),
    private readonly providerDataPolicyVersions: ProviderDataPolicyVersionRecord[] = [],
    private readonly projectDataPolicies = new Map<string, ProjectDataPolicyRecord>(),
    private readonly hostedProviderConsent = new Map<string, ProviderHostedConsentRecord>(),
  ) {}

  async listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]> {
    return structuredClone([...this.providerDataPolicies.values()]
      .filter((policy) => policy.companyId === companyId)
      .sort((a, b) => a.providerId.localeCompare(b.providerId) || (a.modelPattern ?? "").localeCompare(b.modelPattern ?? "")));
  }

  async upsertProviderDataPolicy(input: UpsertProviderDataPolicyStoreInput): Promise<ProviderDataPolicyRecord> {
    assertValidProviderPolicy(input);
    const key = providerPolicyKey(input.companyId, input.providerId, input.modelPattern);
    const existing = this.providerDataPolicies.get(key) ?? null;
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
          { httpStatus: 409, details: { expectedPolicyVersion: input.expectedPolicyVersion, actualPolicyVersion: existing.policyVersion } },
        );
      }
    }

    const now = new Date();
    const record: ProviderDataPolicyRecord = {
      id: existing?.id ?? `pdp_${randomUUID()}`,
      companyId: input.companyId,
      providerId: input.providerId,
      modelPattern: input.modelPattern,
      policyVersion: (existing?.policyVersion ?? 0) + 1,
      kind: input.kind,
      allowPrivateRepoCode: input.allowPrivateRepoCode,
      maxDataClassification: input.maxDataClassification,
      allowPromptCaching: input.allowPromptCaching,
      externalRetention: input.externalRetention,
      trainingPolicy: input.trainingPolicy,
      region: input.region ?? null,
      jurisdiction: input.jurisdiction ?? null,

      requiredRedactions: [...new Set([...MANDATORY_PROVIDER_REDACTIONS, ...(input.requiredRedactions ?? [])])],
      allowedContentTypes: [...new Set<ProviderContentType>(input.allowedContentTypes ?? ["metadata"])],
      termsUrl: input.termsUrl ?? null,
      lastReviewedAt: input.lastReviewedAt ?? null,
      reviewedBy: input.reviewedBy ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.providerDataPolicies.set(key, record);
    this.providerDataPolicyVersions.push({
      id: `pdpv_${randomUUID()}`,
      companyId: record.companyId,
      providerId: record.providerId,
      modelPattern: record.modelPattern,
      policyVersion: record.policyVersion,
      payload: structuredClone(record),
      actor: input.actor,
      createdAt: now,
    });
    return structuredClone(record);
  }

  async listProviderDataPolicyVersions(
    companyId: string | null,
    providerId?: string,
  ): Promise<ProviderDataPolicyVersionRecord[]> {
    return structuredClone(this.providerDataPolicyVersions
      .filter((version) => version.companyId === companyId && (providerId === undefined || version.providerId === providerId))
      .sort((a, b) => a.policyVersion - b.policyVersion || a.createdAt.getTime() - b.createdAt.getTime()));
  }

  async getProjectDataPolicy(companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null> {
    return structuredClone(this.projectDataPolicies.get(`${companyId}\u0000${projectId}`) ?? null);
  }

  async upsertProjectDataPolicy(input: UpsertProjectDataPolicyStoreInput): Promise<ProjectDataPolicyRecord> {
    const key = `${input.companyId}\u0000${input.projectId}`;
    const existing = this.projectDataPolicies.get(key) ?? null;
    if (input.expectedPolicyVersion === null && existing) {
      throw new ProviderDataPolicyStoreError("data_policy_revision_conflict", "A project data policy already exists", {
        httpStatus: 409, details: { expectedPolicyVersion: null, actualPolicyVersion: existing.policyVersion },
      });
    }
    if (typeof input.expectedPolicyVersion === "number" && existing
      && existing.policyVersion !== input.expectedPolicyVersion) {
      throw new ProviderDataPolicyStoreError(
        "data_policy_revision_conflict",
        "Project data policy changed by another request. Reload and try again.",
        { httpStatus: 409, details: { expectedPolicyVersion: input.expectedPolicyVersion, actualPolicyVersion: existing.policyVersion } },
      );
    }
    const classification = input.dataClassification ?? existing?.dataClassification ?? DEFAULT_DATA_CLASSIFICATION;
    if (!isClassificationAtLeast(classification, "public")) {
      throw new ProviderDataPolicyStoreError("invalid_classification", `Unsupported classification: ${String(classification)}`, {
        httpStatus: 400, details: { field: "dataClassification" },
      });
    }
    const pathRules: ProjectDataPolicyPathRule[] = (input.pathRules ?? existing?.pathRules ?? [])
      .map((rule) => assertValidPathRule(rule));
    const now = new Date();
    const record: ProjectDataPolicyRecord = {
      companyId: input.companyId,
      projectId: input.projectId,
      dataClassification: classification,
      pathRules,
      policyVersion: (existing?.policyVersion ?? 0) + 1,
      updatedBy: input.actor,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.projectDataPolicies.set(key, record);
    return structuredClone(record);
  }

}
