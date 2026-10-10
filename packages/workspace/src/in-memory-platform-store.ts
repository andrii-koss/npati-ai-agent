/* The company membership domain of the in-memory workspace store - members and invites - split out of
 * in-memory-store.ts in step 3h of docs/refactoring/PLAN.md. Methods are moved verbatim.
 *
 * The methods are moved verbatim and keep the field names they use, so their bodies are unchanged. The
 * closure that selected this domain is closed: no method outside it is called from inside it.
 */
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
import { now } from "./in-memory-clock";

export class InMemoryPlatformStore {
  constructor(
    private readonly featureFlags = new Map<string, FeatureFlag>(),
    private readonly featureFlagHistory: FeatureFlagHistoryEntry[] = [],
    private readonly codeToolManifests = new Map<number, CodeToolManifest>(),
    private readonly sandboxImages = new Map<string, SandboxImage>(),
  ) {}

  async setFeatureFlag(context: AuthContext, input: FeatureFlagInput): Promise<FeatureFlag> {
    const scopeId = input.scope === "global" ? "" : (input.scopeId ?? "");
    if (input.scope !== "global" && !scopeId) throw new WorkspaceAccessError("scopeId is required for company and user scoped flags");
    const mapKey = `${context.workspaceId}|${input.scope}:${scopeId}:${input.flagKey}`;
    const previous = this.featureFlags.get(mapKey) ?? null;
    if (input.expectedRevision !== undefined && previous && previous.revision !== input.expectedRevision) {
      throw new WorkspaceAccessError("Feature flag changed by another request. Reload and try again.");
    }
    const next: FeatureFlag = {
      id: previous?.id ?? randomUUID(),
      workspaceId: context.workspaceId,
      scope: input.scope,
      scopeId,
      flagKey: input.flagKey,
      stage: input.stage ?? previous?.stage ?? "off",
      enabled: input.enabled ?? previous?.enabled ?? false,
      rolloutPercent: input.rolloutPercent ?? previous?.rolloutPercent ?? 0,
      allowlist: input.allowlist ?? previous?.allowlist ?? [],
      revision: previous ? previous.revision + 1 : 1,
      updatedBy: context.userId,
      updatedAt: now(),
    };
    this.featureFlags.set(mapKey, next);
    this.featureFlagHistory.push({
      id: randomUUID(), workspaceId: context.workspaceId, flagKey: input.flagKey, scope: input.scope, scopeId,
      previousValue: previous ? { ...previous } : null, nextValue: { ...next }, actor: context.userId, createdAt: now(),
    });
    return structuredClone(next);
  }

  async listFeatureFlags(context: AuthContext): Promise<FeatureFlag[]> {
    return structuredClone([...this.featureFlags.entries()]
      .filter(([mapKey]) => mapKey.startsWith(`${context.workspaceId}|`))
      .map(([, flag]) => flag)
      .sort((a, b) => a.flagKey.localeCompare(b.flagKey) || a.scope.localeCompare(b.scope) || a.scopeId.localeCompare(b.scopeId)));
  }

  async listFeatureFlagHistory(context: AuthContext, flagKey?: string, limit = 100): Promise<FeatureFlagHistoryEntry[]> {
    return structuredClone(this.featureFlagHistory
      .filter((entry) => entry.workspaceId === context.workspaceId && (!flagKey || entry.flagKey === flagKey))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 500))));
  }

  async publishCodeToolManifest(context: AuthContext, manifest: { version: number; tools: CodeToolManifest["tools"]; checksum: string }): Promise<CodeToolManifest> {
    const record: CodeToolManifest = { version: manifest.version, tools: manifest.tools, checksum: manifest.checksum, createdAt: now() };
    this.codeToolManifests.set(manifest.version, record);
    return structuredClone(record);
  }

  async latestCodeToolManifest(): Promise<CodeToolManifest | null> {
    const versions = [...this.codeToolManifests.keys()].sort((a, b) => b - a);
    const latest = versions.length ? this.codeToolManifests.get(versions[0]!) : undefined;
    return latest ? structuredClone(latest) : null;
  }

  async listSandboxImages(context: AuthContext): Promise<SandboxImage[]> {
    return structuredClone([...this.sandboxImages.values()]
      .filter((image) => image.workspaceId === context.workspaceId)
      .sort((a, b) => (a.variant === b.variant ? b.createdAt.localeCompare(a.createdAt) : a.variant.localeCompare(b.variant))));
  }

  async getSandboxImage(context: AuthContext, reference: string): Promise<SandboxImage | null> {
    const image = this.sandboxImages.get(`${context.workspaceId}|${reference}`);
    return image ? structuredClone(image) : null;
  }

  async upsertSandboxImage(context: AuthContext, input: SandboxImageInput): Promise<SandboxImage> {
    const key = `${context.workspaceId}|${input.reference}`;
    const existing = this.sandboxImages.get(key);
    const record: SandboxImage = {
      id: existing?.id ?? randomUUID(), workspaceId: context.workspaceId, variant: input.variant,
      reference: input.reference, digest: input.digest, status: input.status ?? existing?.status ?? "unverified",
      signature: input.signature ?? null, signatureIssuer: input.signatureIssuer ?? null, sbomPath: input.sbomPath ?? null,
      scanTool: input.scanTool ?? null, scanAt: input.scanAt ?? null,
      scanCritical: input.scanCritical ?? 0, scanHigh: input.scanHigh ?? 0,
      waiverOwner: input.waiverOwner ?? null, waiverExpiresAt: input.waiverExpiresAt ?? null, waiverReason: input.waiverReason ?? null,
      previousReference: input.previousReference ?? existing?.previousReference ?? null,
      revokedAt: existing?.revokedAt ?? null, revokedBy: existing?.revokedBy ?? null, revokeReason: existing?.revokeReason ?? null,
      createdBy: existing?.createdBy ?? context.userId, createdAt: existing?.createdAt ?? now(), updatedAt: now(),
    };
    this.sandboxImages.set(key, record);
    return structuredClone(record);
  }

  async revokeSandboxImage(context: AuthContext, reference: string, input: { actor: string; reason: string }): Promise<SandboxImage> {
    const key = `${context.workspaceId}|${reference}`;
    const existing = this.sandboxImages.get(key);
    if (!existing) throw new WorkspaceNotFoundError("Sandbox image not found");
    const record: SandboxImage = { ...existing, status: "revoked", revokedAt: now(), revokedBy: input.actor, revokeReason: input.reason, updatedAt: now() };
    this.sandboxImages.set(key, record);
    return structuredClone(record);
  }

  async latestVerifiedSandboxImage(context: AuthContext, variant: SandboxImageVariant): Promise<SandboxImage | null> {
    const candidates = [...this.sandboxImages.values()]
      .filter((image) => image.workspaceId === context.workspaceId && image.variant === variant && image.status === "verified")
      .sort((a, b) => (b.scanAt ?? b.createdAt).localeCompare(a.scanAt ?? a.createdAt));
    return candidates.length ? structuredClone(candidates[0]!) : null;
  }

}
