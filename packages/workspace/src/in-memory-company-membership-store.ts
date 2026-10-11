
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

export class InMemoryCompanyMembershipStore {
  constructor(
    private readonly companyMembers = new Map<string, CompanyMember>(),
    private readonly companyInvites = new Map<string, CompanyInvite>(),
  ) {}

  async getCompanyMembership(companyId: string, userId: string): Promise<CompanyMember | null> {
    return structuredClone(this.companyMembers.get(`${companyId}:${userId}`) ?? null);
  }

  async listCompanyMembers(companyId: string): Promise<CompanyMember[]> {
    return structuredClone([...this.companyMembers.values()]
      .filter((member) => member.companyId === companyId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)));
  }

  async countCompanyOwners(companyId: string): Promise<number> {
    return this.activeOwnerCount(companyId);
  }

  async createCompanyInvite(input: CompanyInviteInput): Promise<CompanyInvite> {
    if (!isCompanyRole(input.role)) {
      throw new CompanyMembershipError("invalid_company_role", `Unknown company role: ${String(input.role)}`, { httpStatus: 400 });
    }

    if (this.companyInvites.has(input.id) || this.findInviteByTokenHash(input.tokenHash)) {
      throw new CompanyMembershipError(
        "invite_token_conflict",
        "An invite with this id or token hash already exists",
        { httpStatus: 409 },
      );
    }
    const invite: CompanyInvite = {
      id: input.id,
      companyId: input.companyId,
      email: input.email,
      role: input.role,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
      acceptedAt: input.acceptedAt ?? null,
      createdAt: input.createdAt ?? new Date(),
    };
    this.companyInvites.set(invite.id, invite);
    return structuredClone(invite);
  }

  async findCompanyInviteByTokenHash(tokenHash: string): Promise<CompanyInvite | null> {
    const invite = this.findInviteByTokenHash(tokenHash);
    return invite ? structuredClone(invite) : null;
  }

  async acceptCompanyInvite(input: AcceptCompanyInviteInput): Promise<CompanyMember> {
    const invite = this.companyInvites.get(input.invite.id);
    if (!invite) throw new CompanyMembershipError("invite_not_found", "Invite does not exist", { httpStatus: 404 });
    if (invite.acceptedAt) {
      throw new CompanyMembershipError("invite_already_accepted", "Invite token was already used", { httpStatus: 409 });
    }
    if (invite.expiresAt.getTime() <= input.acceptedAt.getTime()) {
      throw new CompanyMembershipError("invite_expired", "Invite token has expired", { httpStatus: 410 });
    }
    const key = `${invite.companyId}:${input.userId}`;
    const existing = this.companyMembers.get(key) ?? null;

    if (existing && this.isLastActiveOwnerDemotion(existing, invite.role)) {
      throw new CompanyMembershipError(
        "last_owner_protected",
        "Cannot demote the only owner of the company by accepting an invite",
        { httpStatus: 409, details: { operation: "demote", owners: this.activeOwnerCount(invite.companyId) } },
      );
    }
    this.companyInvites.set(invite.id, { ...invite, acceptedAt: input.acceptedAt });
    const member: CompanyMember = {
      id: existing?.id ?? `cm_${randomUUID()}`,
      companyId: invite.companyId,
      userId: input.userId,

      role: invite.role,
      status: "active",
      invitedBy: existing?.invitedBy ?? invite.createdBy,
      invitedAt: existing?.invitedAt ?? invite.createdAt,
      acceptedAt: input.acceptedAt,
      createdAt: existing?.createdAt ?? input.acceptedAt,
      updatedAt: input.acceptedAt,
      revision: (existing?.revision ?? 0) + 1,
    };
    this.companyMembers.set(key, member);
    return structuredClone(member);
  }

  async updateCompanyMemberRole(input: UpdateCompanyMemberRoleInput): Promise<CompanyMember> {
    if (!isCompanyRole(input.role)) {
      throw new CompanyMembershipError("invalid_company_role", `Unknown company role: ${String(input.role)}`, { httpStatus: 400 });
    }
    const key = `${input.companyId}:${input.userId}`;
    const existing = this.companyMembers.get(key);
    if (!existing) {
      throw new CompanyMembershipError("membership_not_found", "User is not a member of this company", { httpStatus: 404 });
    }
    if (existing.revision !== input.expectedRevision) {

      throw new CompanyMembershipError(
        "membership_revision_conflict",
        "Company member changed by another request. Reload and try again.",
        {
          httpStatus: 409,
          details: { expectedRevision: input.expectedRevision, actualRevision: existing.revision },
        },
      );
    }
    if (this.isLastActiveOwnerDemotion(existing, input.role)) {
      throw new CompanyMembershipError(
        "last_owner_protected",
        "Cannot demote the only owner of the company",
        { httpStatus: 409, details: { operation: "demote", owners: this.activeOwnerCount(input.companyId) } },
      );
    }
    const member: CompanyMember = { ...existing, role: input.role, updatedAt: input.updatedAt, revision: existing.revision + 1 };
    this.companyMembers.set(key, member);
    return structuredClone(member);
  }

  async removeCompanyMember(input: RemoveCompanyMemberInput): Promise<void> {
    const key = `${input.companyId}:${input.userId}`;
    const existing = this.companyMembers.get(key);
    if (!existing) return;
    if (this.isLastActiveOwner(existing)) {
      throw new CompanyMembershipError(
        "last_owner_protected",
        "Cannot remove the only owner of the company",
        { httpStatus: 409, details: { operation: "remove", owners: this.activeOwnerCount(input.companyId) } },
      );
    }
    this.companyMembers.delete(key);
  }

  findInviteByTokenHash(tokenHash: string): CompanyInvite | undefined {
    for (const invite of this.companyInvites.values()) {
      if (invite.tokenHash === tokenHash) return invite;
    }
    return undefined;
  }

  activeOwnerCount(companyId: string): number {
    let owners = 0;
    for (const member of this.companyMembers.values()) {
      if (member.companyId === companyId && member.role === "owner" && member.status === "active") owners += 1;
    }
    return owners;
  }

  isLastActiveOwnerDemotion(member: CompanyMember, nextRole: string): boolean {
    return member.status === "active" && member.role === "owner" && nextRole !== "owner"
      && this.activeOwnerCount(member.companyId) <= 1;
  }

  isLastActiveOwner(member: CompanyMember): boolean {
    return member.status === "active" && member.role === "owner" && this.activeOwnerCount(member.companyId) <= 1;
  }

}
