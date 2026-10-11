
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

export function providerPolicyKey(companyId: string | null, providerId: string, modelPattern: string | null): string {
    return `${companyId ?? "\u0000platform"}\u0000${providerId}\u0000${modelPattern ?? "\u0000provider"}`;
  }

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

export function assertValidPathRule(rule: ProjectDataPolicyPathRule): ProjectDataPolicyPathRule {
    const pattern = typeof rule?.pattern === "string" ? rule.pattern.trim() : "";
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
