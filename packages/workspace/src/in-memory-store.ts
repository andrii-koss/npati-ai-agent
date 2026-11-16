import { randomUUID } from "node:crypto";
import { InMemoryConversationResearch } from "./conversation-research-evidence";
import { codeChildSessionId } from "./code-child-session-id";
import { MemoryCodeInboxStore } from "./code-session-inbox-memory";
import { MemoryCodeProcessStore } from "./code-process-store-memory";
import { assertNoSecrets } from "@npati/memory";
import type { AuthContext, ConversationResearchInput, Business, BusinessInput, BusinessOnboardingSession, BusinessToCompanyInput, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentInput, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, CompanyInput, Project, ProjectCheckpoint, CreateCheckpointInput, ProjectDeployment, CreateDeploymentInput, ProjectQaReport, CreateProjectQaReportInput, ProjectInput, ProjectStatus, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview, WorkspaceStore, CodeSession, CodeSessionInput, CodeSessionStatus, ProjectCodeSettings, DataClassification, RetentionClass, AuditEntry, AuditEntryInput, AuditAnchor, AuditChainState, AuditChainVerification, FeatureFlag, FeatureFlagInput, FeatureFlagHistoryEntry, CodeToolManifest, SandboxImage, SandboxImageInput, SandboxImageVariant, CodeSessionMode, ProjectCodeTrust, ProjectCodeTrustInput, ProjectMountedFolder, ProjectMountedFolderInput, CodeApprovalRule, CodeApprovalRuleInput, CodeApprovalRuleScope,
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
import { diffSnapshotPayloads, snapshotPayloadHash } from "./execution-snapshot-hash";
import { InMemoryDataPolicyStore } from "./in-memory-data-policy-store";
import { providerPolicyKey as ruleProviderPolicyKey, assertValidProviderPolicy as ruleAssertValidProviderPolicy, assertValidPathRule as ruleAssertValidPathRule } from "./in-memory-data-policy-rules";
import { InMemoryCodeRunStore } from "./in-memory-code-run-store";
import { InMemoryCompanyMembershipStore } from "./in-memory-company-membership-store";
import { InMemoryPlatformStore } from "./in-memory-platform-store";

import { InMemoryCodeGoalStore } from "./code-goal-store";
import {
  InMemoryCodeUserQuestionStore,
  type AnswerCodeUserQuestionInput,
  type CodeUserQuestionRecord,
  type CreateCodeUserQuestionInput,
} from "./code-question-store";

import {
  InMemoryCodeSessionDurabilityStore,
  type CodeRunRecoveryNoticeRecord,
  type CodeSessionForkRecord,
  type CodeSessionHeadRecord,
  type CodeSessionRewindRecord,
  type CompleteCodeSessionForkInput,
  type CompleteCodeSessionRewindInput,
  type CreateCodeRunRecoveryNoticeInput,
  type CreateCodeSessionForkInput,
  type CreateCodeSessionRewindInput,
  type SetCodeSessionHeadInput,
} from "./code-session-durability-store";
import type {
  CodeGoalRecord, CodeGoalWithCriteria, CodeSessionPlanRecord, CodeSessionTodoRecord,
  CreateCodeGoalInput, CreateCodeSessionPlanInput, DecideCodeSessionPlanInput,
  ReplaceCodeSessionTodosInput, SetCodeGoalCriterionStatusInput, UpdateCodeGoalInput,
} from "./types";
import { now } from "./in-memory-clock";
import { createProject, listProjects, getProject, updateProject, getProjectCodeTrust, getProjectMountedFolder, getProjectMountedFolderForSystem, updateProjectRepository, updateProjectPreview, archiveProject, deleteProject, softDeleteProject, restoreProject, transitionProjectToPurging, recordProjectLifecycleRecord, listExpiredSoftDeletedProjects, createProjectCheckpoint, getProjectCheckpoint, deleteProjectCheckpoint, createProjectDeployment, getProjectDeployment, updateProjectDeployment, createProjectQaReport, getProjectQaReport, getProjectDataPolicy, getProjectForSystem, setProjectCodeTrust, setProjectMountedFolder, setProjectSandbox, listProjectCheckpoints, listProjectDeployments, listProjectQaReports, getLatestProjectQaReport, type InMemoryProjectState } from "./in-memory-project-store";
import { setCompanyAgentParent, listGoals, createGoal, updateGoal, deleteGoal, listMemory, createMemory, updateMemory, type InMemoryGoalState } from "./in-memory-goal-store";
import { createCodeSession, getCodeSession, listCodeSessions, createCodeApprovalRule, listCodeApprovalRules, deleteCodeApprovalRule, updateCodeSession, createCodeRunState, getCodeRunRequest, applyCodeRunStateEvent, getCodeRunState, getCodeRunTurn, listCodeRunTurns, listCodeRunStates, listCodeRunStatesForScan, listCodeProjectRefs, listCodeRunTurnsForScan, createCodeUserQuestion, getCodeUserQuestion, getCodeSessionHead, createCodeRunRecoveryNotice, listCodeRunRecoveryNotices, createCodeSessionRewind, getCodeSessionRewind, listCodeSessionRewinds, createCodeSessionFork, getCodeSessionFork, listCodeSessionForks, createCodeGoal, getCodeGoal, listCodeGoals, updateCodeGoal, createCodeSessionPlan, listCodeSessionPlans, listCodeSessionTodos, createCodeContextSummary, listCodeContextSummaries, createCodeActivityEvent, listCodeActivityEvents, findMatchingCodeApprovalRule, type InMemoryCodeState } from "./in-memory-code-store";
import { getUserSetting, setUserSetting, listUserBusinesses, getUserBusiness, updateUserBusiness, assertCompany, listCompanies, getCompany, createCompany, updateCompany, deleteCompany, assertCompanyAgent, listCompanyAgents, listCompanyAgentsPage, getCompanyAgent, createCompanyAgent, updateCompanyAgent, deleteCompanyAgent, listCompanyAgentEdges, createCompanyAgentRun, listCompanyAgentRuns, getCompanyAgentRun, getCompanyRunPendingPlan, updateCompanyAgentRun, listUserGoals, listUserMemories, getCompanyMembership, listCompanyMembers, createCompanyInvite, updateCompanyMemberRole, grantHostedProviderConsent, revokeHostedProviderConsent, setCompanyMainAgent, convertBusinessToCompany, listRecoverableCompanyAgentRuns, replaceCompanyAgentRunSteps, appendCompanyAgentToolAudit, appendCompanyAgentRunEvent, claimCompanyAgentRun, heartbeatCompanyAgentRun, requeueCompanyAgentRun, type InMemoryCompanyState } from "./in-memory-company-store";
import { ensure, assertBusiness, assertUserBusiness, overview, setCurrentBusiness, listBusinesses, listBusinessesPage, getBusiness, createBusiness, updateBusiness, deleteBusiness, linkGoal, linkMemory, deleteMemory, listConversations, createConversation, getConversation, updateConversation, deleteConversation, appendMessage, listNeutralConversations, createNeutralConversation, getNeutralConversation, updateNeutralConversation, deleteNeutralConversation, appendNeutralMessage, listOnboardings, getOnboarding, startOnboarding, advanceOnboarding, setOnboardingStatus, completeOnboarding, type InMemoryCollaborationState } from "./in-memory-collaboration-store";
import { appendAuditEntry, listAuditEntries, verifyAuditChain, auditChainState, recordAuditAnchor, listAuditAnchors, latestAuditAnchor, auditCompanies, systemAuditChains, systemRecordAuditAnchor, type InMemoryAuditState } from "./in-memory-audit-store";

export type StoredUserSetting = import('./types').UserSetting;
export class InMemoryWorkspaceStore implements WorkspaceStore {
  readonly codeProcesses = new MemoryCodeProcessStore(async (scope) => [...this.codeRunStates.values()]
    .filter((run) => run.companyId === scope.companyId && run.projectId === scope.projectId)
    .map((run) => ({ runId: run.runId, sessionId: run.sessionId, owner: run.leaseOwner,
      live: run.status === "running" && !!run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now(), terminal: ["completed", "failed", "cancelled"].includes(run.status) })));
  readonly codeInbox = new MemoryCodeInboxStore(async (scope) => [...this.codeRunStates.values()]
    .filter((run) => run.companyId === scope.companyId && run.sessionId === scope.sessionId)
    .map((run) => ({ runId: run.runId, owner: run.leaseOwner,
      live: run.status === "running" && !!run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now(),
      terminal: ["completed", "failed", "cancelled"].includes(run.status), interrupted: run.status === "interrupted" })));
  private readonly identities = new Map<string, { displayName: string; workspaceName: string; role: string }>();
  private readonly businesses = new Map<string, Business>();
  private readonly companies = new Map<string, Company>();
  private readonly companyAgents = new Map<string, CompanyAgent>();
  private readonly projects = new Map<string, Project>();
  private readonly codeSessions = new Map<string, CodeSession>();
  private readonly projectCodeTrust = new Map<string, ProjectCodeTrust>();

  private readonly projectMountedFolders = new Map<string, ProjectMountedFolder>();
  private readonly auditLog = new Map<string, AuditEntry[]>();
  private readonly auditAnchors = new Map<string, AuditAnchor[]>();
  private readonly featureFlags = new Map<string, FeatureFlag>();
  private readonly featureFlagHistory: FeatureFlagHistoryEntry[] = [];
  private readonly codeToolManifests = new Map<number, CodeToolManifest>();
  private readonly sandboxImages = new Map<string, SandboxImage>();

  private readonly platformOps = new InMemoryPlatformStore(
    this.featureFlags,
    this.featureFlagHistory,
    this.codeToolManifests,
    this.sandboxImages,
  );
  private readonly codeApprovalRules = new Map<string, CodeApprovalRule>();

  private readonly providerDataPolicies = new Map<string, ProviderDataPolicyRecord>();
  private readonly providerDataPolicyVersions: ProviderDataPolicyVersionRecord[] = [];
  private readonly projectDataPolicies = new Map<string, ProjectDataPolicyRecord>();
  private readonly hostedProviderConsent = new Map<string, ProviderHostedConsentRecord>();

  private readonly dataPolicyOps = new InMemoryDataPolicyStore(
    this.providerDataPolicies,
    this.providerDataPolicyVersions,
    this.projectDataPolicies,
    this.hostedProviderConsent,
  );
  private readonly projectCreateRequests = new Map<string, string>();
  private readonly projectCheckpoints = new Map<string, ProjectCheckpoint>();
  private readonly projectDeployments = new Map<string, ProjectDeployment>();
  private readonly projectQaReports = new Map<string, ProjectQaReport>();
  private readonly companyEdges = new Map<string, CompanyAgentEdge>();
  private readonly companyRuns = new Map<string, CompanyAgentRun>();
  private readonly companyRunPendingPlans = new Map<string, unknown>();
  private readonly companyRunSteps = new Map<string, CompanyAgentRunStep>();
  private readonly companyToolAudit = new Map<string, CompanyAgentToolAudit>();
  private readonly companyRunEvents = new Map<string, CompanyAgentRunEvent>();
  private readonly companyRunRequests = new Map<string, string>();
  private readonly companyCreateRequests = new Map<string, string>();
  private readonly companyAgentCreateRequests = new Map<string, string>();
  private readonly current = new Map<string, string>();
  private readonly goals = new Map<string, Goal>();
  private readonly memories = new Map<string, MemoryItem>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, ConversationMessage>();
  private readonly userSettings = new Map<string, StoredUserSetting>();
  private readonly businessCreateRequests = new Map<string, string>();
  private readonly onboardings = new Map<string, Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">>();

  private readonly companyMembers = new Map<string, CompanyMember>();
  private readonly companyInvites = new Map<string, CompanyInvite>();

  private readonly companyMembershipOps = new InMemoryCompanyMembershipStore(
    this.companyMembers,
    this.companyInvites,
  );

  private readonly codeRunStates = new Map<string, CodeRunStateRecord>();
  private readonly codeRunTurns = new Map<string, CodeRunTurnRecord>();

  private readonly codeRunRequests = new Map<string, CodeRunRequestRecord>();

  private readonly executionSnapshots = new Map<string, ExecutionSnapshotRecord>();
  private readonly snapshotConfigVersions = new Map<string, SnapshotConfigVersionRecord>();

  private readonly codeActivityEvents = new Map<string, CodeActivityEventRecord>();

  private readonly codeContextSummaries = new Map<string, CodeContextSummaryRecord>();
  private readonly replayBundles = new Map<string, ReplayBundleRecord>();
  private readonly replayBundleSteps = new Map<string, ReplayBundleStepRecord[]>();

  private readonly codeRunOps = new InMemoryCodeRunStore(
    this.codeRunStates,
    this.codeRunRequests,
    this.codeRunTurns,
    this.executionSnapshots,
    this.snapshotConfigVersions,
    this.codeContextSummaries,
    this.codeActivityEvents,
    this.replayBundles,
    this.replayBundleSteps,
  );

  private readonly codeGoalState = new InMemoryCodeGoalStore();

  private readonly codeUserQuestionState = new InMemoryCodeUserQuestionStore();

  private readonly codeSessionDurabilityState = new InMemoryCodeSessionDurabilityStore();

  private companyState(): InMemoryCompanyState {
    return {
      businesses: this.businesses,
      companies: this.companies,
      companyAgentCreateRequests: this.companyAgentCreateRequests,
      companyAgents: this.companyAgents,
      companyCreateRequests: this.companyCreateRequests,
      companyEdges: this.companyEdges,
      companyMembershipOps: this.companyMembershipOps,
      companyRunEvents: this.companyRunEvents,
      companyRunPendingPlans: this.companyRunPendingPlans,
      companyRunRequests: this.companyRunRequests,
      companyRunSteps: this.companyRunSteps,
      companyRuns: this.companyRuns,
      companyToolAudit: this.companyToolAudit,
      goals: this.goals,
      hostedProviderConsent: this.hostedProviderConsent,
      memories: this.memories,
      projects: this.projects,
      userSettings: this.userSettings,
      assertBusiness: this.assertBusiness.bind(this),
      assertUserBusiness: this.assertUserBusiness.bind(this),
      ensure: this.ensure.bind(this),
    };
  }

  private codeState(): InMemoryCodeState {
    return {
      codeApprovalRules: this.codeApprovalRules,
      codeGoalState: this.codeGoalState,
      codeRunOps: this.codeRunOps,
      codeSessionDurabilityState: this.codeSessionDurabilityState,
      codeSessions: this.codeSessions,
      codeUserQuestionState: this.codeUserQuestionState,
      companyAgents: this.companyAgents,
      assertCompany: this.assertCompany.bind(this),
      getProject: this.getProject.bind(this),
    };
  }

  private goalState(): InMemoryGoalState {
    return {
      companyEdges: this.companyEdges,
      goals: this.goals,
      memories: this.memories,
      assertBusiness: this.assertBusiness.bind(this),
      assertCompanyAgent: this.assertCompanyAgent.bind(this),
      agentDisplay: (agentId: string) => { const agent = this.companyAgents.get(agentId); const company = agent ? this.companies.get(agent.companyId) : undefined; return agent && company ? { name: agent.name, role: agent.role, companyName: company.name } : null; },
      assertOwnedAgent: (context, agentId) => {
        const agent = this.companyAgents.get(agentId);
        if (!agent) throw new WorkspaceAccessError("Assigned agent is not available");
        return this.assertCompanyAgent(context, agent.companyId, agentId);
      },
    };
  }

  private projectState(): InMemoryProjectState {
    return {
      dataPolicyOps: this.dataPolicyOps,
      projectCheckpoints: this.projectCheckpoints,
      projectCodeTrust: this.projectCodeTrust,
      projectCreateRequests: this.projectCreateRequests,
      projectDeployments: this.projectDeployments,
      projectMountedFolders: this.projectMountedFolders,
      projectQaReports: this.projectQaReports,
      projects: this.projects,
      assertCompany: this.assertCompany.bind(this),
    };
  }

  private collaborationState(): InMemoryCollaborationState {
    return {
      identities: this.identities,
      businesses: this.businesses,
      businessCreateRequests: this.businessCreateRequests,
      conversations: this.conversations,
      messages: this.messages,
      onboardings: this.onboardings,
      goals: this.goals,
      memories: this.memories,
      current: this.current,
      initialize: this.initialize.bind(this),
      updateMemory: this.updateMemory.bind(this),
      linkedBusinessId: (companyId: string) => this.companies.get(companyId)?.businessId ?? null,
    };
  }

  private auditState(): InMemoryAuditState {
    return {
      auditLog: this.auditLog,
      auditAnchors: this.auditAnchors,
      assertCompany: this.assertCompany.bind(this),
    };
  }

  async initialize(context?: AuthContext) {
    if (context) this.identities.set(`${context.workspaceId}:${context.userId}`, { displayName: "Dev User", workspaceName: "My Workspace", role: "owner" });
  }

  async health() { return "ok" as const; }

    async getUserSetting(context: AuthContext, key: string) { return getUserSetting(this.companyState(), context, key); }

    async setUserSetting(context: AuthContext, key: string, value: unknown, expectedRevision: number) { return setUserSetting(this.companyState(), context, key, value, expectedRevision); }

  private async ensure(context: AuthContext) { return ensure(this.collaborationState(), context); }
  private assertBusiness(context: AuthContext, businessId: string) { return assertBusiness(this.collaborationState(), context, businessId); }
  private assertUserBusiness(context: AuthContext, businessId: string) { return assertUserBusiness(this.collaborationState(), context, businessId); }
  async overview(context: AuthContext): Promise<WorkspaceOverview> { return overview(this.collaborationState(), context); }
  async setCurrentBusiness(context: AuthContext, businessId: string) { return setCurrentBusiness(this.collaborationState(), context, businessId); }
  async listBusinesses(context: AuthContext) { return listBusinesses(this.collaborationState(), context); }
  async listUserBusinesses(context: AuthContext) { return listUserBusinesses(this.companyState(), context); }
  async listBusinessesPage(context: AuthContext, requestedLimit = 20, cursor?: string) { return listBusinessesPage(this.collaborationState(), context, requestedLimit, cursor); }
  async getBusiness(context: AuthContext, businessId: string) { return getBusiness(this.collaborationState(), context, businessId); }
  async getUserBusiness(context: AuthContext, businessId: string) { return getUserBusiness(this.companyState(), context, businessId); }
  async createBusiness(context: AuthContext, input: BusinessInput, idempotencyKey?: string) { return createBusiness(this.collaborationState(), context, input, idempotencyKey); }
  async updateBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>) { return updateBusiness(this.collaborationState(), context, businessId, input); }
  async updateUserBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>) { return updateUserBusiness(this.companyState(), context, businessId, input); }
  async deleteBusiness(context: AuthContext, businessId: string) { return deleteBusiness(this.collaborationState(), context, businessId); }

    private assertCompany(context: AuthContext, companyId: string) { return assertCompany(this.companyState(), context, companyId); }

    async listCompanies(context: AuthContext, requestedLimit = 20, cursor?: string) { return listCompanies(this.companyState(), context, requestedLimit, cursor); }

    async getCompany(context: AuthContext, companyId: string) { return getCompany(this.companyState(), context, companyId); }

    async createCompany(context: AuthContext, input: CompanyInput, idempotencyKey: string) { return createCompany(this.companyState(), context, input, idempotencyKey); }

  async convertBusinessToCompany(context: AuthContext, businessId: string, input: BusinessToCompanyInput, idempotencyKey: string): Promise<{ company: Company; created: boolean }> {
    return convertBusinessToCompany(this.companyState(), context, businessId, input, idempotencyKey);
  }

  async updateCompany(context: AuthContext, companyId: string, input: Partial<CompanyInput>, expectedRevision: number) { return updateCompany(this.companyState(), context, companyId, input, expectedRevision); }

  async deleteCompany(context: AuthContext, companyId: string) { return deleteCompany(this.companyState(), context, companyId); }

  async setCompanyMainAgent(context: AuthContext, companyId: string, agentId: string | null, expectedRevision: number) { return setCompanyMainAgent(this.companyState(), context, companyId, agentId, expectedRevision); }

    private assertCompanyAgent(context: AuthContext, companyId: string, agentId: string) { return assertCompanyAgent(this.companyState(), context, companyId, agentId); }

    async listCompanyAgents(context: AuthContext, companyId: string) { return listCompanyAgents(this.companyState(), context, companyId); }

    async listCompanyAgentsPage(context: AuthContext, companyId: string, requestedLimit = 50, cursor?: string) { return listCompanyAgentsPage(this.companyState(), context, companyId, requestedLimit, cursor); }

    async createProject(context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string) { return createProject(this.projectState(), context, companyId, input, idempotencyKey); }

    async listProjects(context: AuthContext, companyId: string, includeArchived = false) { return listProjects(this.projectState(), context, companyId, includeArchived); }
    async listProjectCatalog(context: AuthContext, input: import("./project-catalog").ProjectCatalogInput) {
      const { catalogCursor, catalogPage, catalogFramework } = await import("./project-catalog");
      const cursor = catalogCursor(context, input);
      if (input.companyId) this.assertCompany(context, input.companyId);
      const rows = [...this.projects.values()].filter(project => {
        if (project.workspaceId !== context.workspaceId || project.createdBy !== context.userId || (context.companyId && project.companyId !== context.companyId) || (input.companyId && project.companyId !== input.companyId)) return false;
        try { this.assertCompany(context, project.companyId); } catch { return false; }
        if (["soft_deleted", "purging", "deleted"].includes(project.status)) return false;
        if (input.status === "active" && project.status === "archived" || input.status === "archived" && project.status !== "archived") return false;
        if (input.kind && input.kind !== "all" && project.kind !== input.kind) return false;
        if (!catalogFramework(project.framework ?? "", input.framework ?? "all")) return false;
        if (input.search && !(project.name + " " + (project.description ?? "")).toLowerCase().includes(input.search.toLowerCase())) return false;
        const time = project.createdAt || project.updatedAt;
        return !cursor || time < cursor.time || (time === cursor.time && project.id > cursor.id);
      }).sort((a, b) => {
        const timeA = a.createdAt || a.updatedAt;
        const timeB = b.createdAt || b.updatedAt;
        return timeB.localeCompare(timeA) || a.id.localeCompare(b.id);
      });
      return catalogPage(context, input, rows);
    }

    async getProject(context: AuthContext, companyId: string, projectId: string) { return getProject(this.projectState(), context, companyId, projectId); }

    async updateProject(context: AuthContext, companyId: string, projectId: string, input: { name?: string; expectedRevision: number; code?: ProjectCodeSettings }) { return updateProject(this.projectState(), context, companyId, projectId, input); }

    async createCodeSession(context: AuthContext, companyId: string, projectId: string, input: CodeSessionInput): Promise<CodeSession> { return createCodeSession(this.codeState(), context, companyId, projectId, input); }

    async getCodeSession(context: AuthContext, companyId: string, sessionId: string): Promise<CodeSession> { return getCodeSession(this.codeState(), context, companyId, sessionId); }

    async listCodeSessions(context: AuthContext, companyId: string, projectId?: string, options: { includeArchived?: boolean; limit?: number } = {}): Promise<CodeSession[]> { return listCodeSessions(this.codeState(), context, companyId, projectId, options); }

  async appendAuditEntry(context: AuthContext, companyId: string, input: AuditEntryInput): Promise<AuditEntry> { return appendAuditEntry(this.auditState(), context, companyId, input); }
  async listAuditEntries(context: AuthContext, companyId: string, filters: { actor?: string; requestId?: string; correlationId?: string; action?: string; limit?: number; fromSequence?: number } = {}): Promise<AuditEntry[]> { return listAuditEntries(this.auditState(), context, companyId, filters); }
  async verifyAuditChain(context: AuthContext, companyId: string, range: { fromSequence?: number; toSequence?: number } = {}): Promise<AuditChainVerification> { return verifyAuditChain(this.auditState(), context, companyId, range); }
  async auditChainState(context: AuthContext, companyId: string): Promise<AuditChainState> { return auditChainState(this.auditState(), context, companyId); }
  async recordAuditAnchor(context: AuthContext, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor> { return recordAuditAnchor(this.auditState(), context, companyId, anchor); }
  async listAuditAnchors(context: AuthContext, companyId: string, limit = 90): Promise<AuditAnchor[]> { return listAuditAnchors(this.auditState(), context, companyId, limit); }
  async latestAuditAnchor(context: AuthContext, companyId: string): Promise<AuditAnchor | null> { return latestAuditAnchor(this.auditState(), context, companyId); }
  async auditCompanies(context: AuthContext): Promise<string[]> { return auditCompanies(this.auditState(), context); }
  async systemAuditChains(workspaceId: string) { return systemAuditChains(this.auditState(), workspaceId); }
  async systemRecordAuditAnchor(workspaceId: string, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor> { return systemRecordAuditAnchor(this.auditState(), workspaceId, companyId, anchor); }

  async setFeatureFlag(context: AuthContext, input: FeatureFlagInput): Promise<FeatureFlag> { return this.platformOps.setFeatureFlag(context, input); }

  async listFeatureFlags(context: AuthContext): Promise<FeatureFlag[]> { return this.platformOps.listFeatureFlags(context); }

  async listFeatureFlagHistory(context: AuthContext, flagKey?: string, limit = 100): Promise<FeatureFlagHistoryEntry[]> { return this.platformOps.listFeatureFlagHistory(context, flagKey, limit); }

  async publishCodeToolManifest(context: AuthContext, manifest: { version: number; tools: CodeToolManifest["tools"]; checksum: string }): Promise<CodeToolManifest> { return this.platformOps.publishCodeToolManifest(context, manifest); }

  async latestCodeToolManifest(): Promise<CodeToolManifest | null> { return this.platformOps.latestCodeToolManifest(); }

    async createCodeApprovalRule(context: AuthContext, companyId: string, input: CodeApprovalRuleInput): Promise<CodeApprovalRule> { return createCodeApprovalRule(this.codeState(), context, companyId, input); }

    async listCodeApprovalRules(context: AuthContext, companyId: string, filters: { projectId?: string; sessionId?: string; scope?: CodeApprovalRuleScope } = {}): Promise<CodeApprovalRule[]> { return listCodeApprovalRules(this.codeState(), context, companyId, filters); }

    async deleteCodeApprovalRule(context: AuthContext, companyId: string, ruleId: string): Promise<void> { return deleteCodeApprovalRule(this.codeState(), context, companyId, ruleId); }

  async findMatchingCodeApprovalRule(context: AuthContext, query: { companyId: string; projectId?: string | null; sessionId?: string | null; action: string }): Promise<CodeApprovalRule | null> { return findMatchingCodeApprovalRule(this.codeState(), context, query); }

  async listSandboxImages(context: AuthContext): Promise<SandboxImage[]> { return this.platformOps.listSandboxImages(context); }

  async getSandboxImage(context: AuthContext, reference: string): Promise<SandboxImage | null> { return this.platformOps.getSandboxImage(context, reference); }

  async upsertSandboxImage(context: AuthContext, input: SandboxImageInput): Promise<SandboxImage> { return this.platformOps.upsertSandboxImage(context, input); }

  async revokeSandboxImage(context: AuthContext, reference: string, input: { actor: string; reason: string }): Promise<SandboxImage> { return this.platformOps.revokeSandboxImage(context, reference, input); }

  async latestVerifiedSandboxImage(context: AuthContext, variant: SandboxImageVariant): Promise<SandboxImage | null> { return this.platformOps.latestVerifiedSandboxImage(context, variant); }

    async updateCodeSession(context: AuthContext, companyId: string, sessionId: string, patch: { status?: CodeSessionStatus; summary?: string; runId?: string | null; modelProfile?: string; dataClassification?: DataClassification; retentionClass?: RetentionClass; toolManifestVersion?: number | null; mode?: CodeSessionMode; expectedRevision?: number }): Promise<CodeSession> { return updateCodeSession(this.codeState(), context, companyId, sessionId, patch); }

    async getProjectCodeTrust(context: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null> { return getProjectCodeTrust(this.projectState(), context, companyId, projectId); }

  async setProjectCodeTrust(context: AuthContext, companyId: string, projectId: string, input: ProjectCodeTrustInput): Promise<ProjectCodeTrust> { return setProjectCodeTrust(this.projectState(), context, companyId, projectId, input); }
  async getProjectMountedFolder(context: AuthContext, companyId: string, projectId: string): Promise<ProjectMountedFolder | null> { return getProjectMountedFolder(this.projectState(), context, companyId, projectId); }
  async getProjectMountedFolderForSystem(companyId: string, projectId: string): Promise<ProjectMountedFolder | null> { return getProjectMountedFolderForSystem(this.projectState(), companyId, projectId); }
  async setProjectMountedFolder(context: AuthContext, companyId: string, projectId: string, input: ProjectMountedFolderInput): Promise<ProjectMountedFolder> { return setProjectMountedFolder(this.projectState(), context, companyId, projectId, input); }
  async setProjectSandbox(context: AuthContext, companyId: string, projectId: string, sandboxId: string | null, expectedSandboxId: string | null) { return setProjectSandbox(this.projectState(), context, companyId, projectId, sandboxId, expectedSandboxId); }
  async updateProjectRepository(context: AuthContext, companyId: string, projectId: string, input: { provider: string; url: string; branch: string }): Promise<Project> { return updateProjectRepository(this.projectState(), context, companyId, projectId, input); }
  async updateProjectPreview(context: AuthContext, companyId: string, projectId: string, patch: { status?: ProjectStatus; previewUrl?: string | null; previewPort?: number | null; framework?: string | null; runtime?: string | null; lastBuildStatus?: string | null; deploymentUrl?: string | null; deploymentStatus?: string | null; lastDeploymentStatus?: string | null; lastDeployedAt?: string | null }) { return updateProjectPreview(this.projectState(), context, companyId, projectId, patch); }
  async archiveProject(context: AuthContext, companyId: string, projectId: string, expectedRevision: number) { return archiveProject(this.projectState(), context, companyId, projectId, expectedRevision); }
  async deleteProject(context: AuthContext, companyId: string, projectId: string) { return deleteProject(this.projectState(), context, companyId, projectId); }
  async softDeleteProject(context: AuthContext, companyId: string, projectId: string, reason?: string, purgeAfter?: string) { return softDeleteProject(this.projectState(), context, companyId, projectId, reason, purgeAfter); }
  async restoreProject(context: AuthContext, companyId: string, projectId: string) { return restoreProject(this.projectState(), context, companyId, projectId); }
  async transitionProjectToPurging(context: AuthContext, companyId: string, projectId: string) { return transitionProjectToPurging(this.projectState(), context, companyId, projectId); }
  async recordProjectLifecycleRecord(record: { workspaceId: string; companyId: string; projectId: string; operation: "soft_delete" | "restore" | "hard_purge"; status: "pending" | "in_progress" | "completed" | "failed"; details?: Record<string, unknown>; lastError?: string }) { return recordProjectLifecycleRecord(this.projectState(), record); }
  async listExpiredSoftDeletedProjects(limit?: number) { return listExpiredSoftDeletedProjects(this.projectState(), limit); }
  async createProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, input: CreateCheckpointInput): Promise<ProjectCheckpoint> { return createProjectCheckpoint(this.projectState(), context, companyId, projectId, input); }
  async listProjectCheckpoints(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectCheckpoint[]> { return listProjectCheckpoints(this.projectState(), context, companyId, projectId, limit); }
  async getProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<ProjectCheckpoint> { return getProjectCheckpoint(this.projectState(), context, companyId, projectId, checkpointId); }
  async deleteProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<boolean> { return deleteProjectCheckpoint(this.projectState(), context, companyId, projectId, checkpointId); }
  async createProjectDeployment(context: AuthContext, companyId: string, projectId: string, input: CreateDeploymentInput): Promise<ProjectDeployment> { return createProjectDeployment(this.projectState(), context, companyId, projectId, input); }
  async listProjectDeployments(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectDeployment[]> { return listProjectDeployments(this.projectState(), context, companyId, projectId, limit); }
  async getProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string): Promise<ProjectDeployment | null> { return getProjectDeployment(this.projectState(), context, companyId, projectId, deploymentId); }
  async updateProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string, patch: Partial<ProjectDeployment>): Promise<ProjectDeployment> { return updateProjectDeployment(this.projectState(), context, companyId, projectId, deploymentId, patch); }
  async createProjectQaReport(context: AuthContext, companyId: string, projectId: string, input: CreateProjectQaReportInput): Promise<ProjectQaReport> { return createProjectQaReport(this.projectState(), context, companyId, projectId, input); }
  async listProjectQaReports(context: AuthContext, companyId: string, projectId: string, limit = 50, runId?: string): Promise<ProjectQaReport[]> { return listProjectQaReports(this.projectState(), context, companyId, projectId, limit, runId); }
  async getProjectQaReport(context: AuthContext, companyId: string, projectId: string, reportId: string): Promise<ProjectQaReport | null> { return getProjectQaReport(this.projectState(), context, companyId, projectId, reportId); }
  async getLatestProjectQaReport(context: AuthContext, companyId: string, projectId: string): Promise<ProjectQaReport | null> { return getLatestProjectQaReport(this.projectState(), context, companyId, projectId); }

    async getCompanyAgent(context: AuthContext, companyId: string, agentId: string) { return getCompanyAgent(this.companyState(), context, companyId, agentId); }

    async createCompanyAgent(context: AuthContext, companyId: string, input: CompanyAgentInput, idempotencyKey: string) { return createCompanyAgent(this.companyState(), context, companyId, input, idempotencyKey); }

    async updateCompanyAgent(context: AuthContext, companyId: string, agentId: string, input: Partial<CompanyAgentInput>, expectedRevision: number) { return updateCompanyAgent(this.companyState(), context, companyId, agentId, input, expectedRevision); }

    async deleteCompanyAgent(context: AuthContext, companyId: string, agentId: string, expectedRevision: number) { return deleteCompanyAgent(this.companyState(), context, companyId, agentId, expectedRevision); }

    async listCompanyAgentEdges(context: AuthContext, companyId: string, agentIds?: string[]) { return listCompanyAgentEdges(this.companyState(), context, companyId, agentIds); }

    async setCompanyAgentParent(context: AuthContext, companyId: string, childAgentId: string, parentAgentId: string | null) { return setCompanyAgentParent(this.goalState(), context, companyId, childAgentId, parentAgentId); }

    async createCompanyAgentRun(context: AuthContext, companyId: string, input: { task: string; requestedMode: "auto" | "single" | "pipeline" | "fusion"; projectId?: string }, idempotencyKey: string) { return createCompanyAgentRun(this.companyState(), context, companyId, input, idempotencyKey); }

    async listCompanyAgentRuns(context: AuthContext, companyId: string, limit = 50, filter?: { projectId?: string; contentOnly?: boolean }) { return listCompanyAgentRuns(this.companyState(), context, companyId, limit, filter); }

  async listProjectRuns(context: AuthContext, companyId: string, projectId: string, limit = 50) { return this.listCompanyAgentRuns(context, companyId, limit, { projectId }); }

    async getCompanyAgentRun(context: AuthContext, companyId: string, runId: string) { return getCompanyAgentRun(this.companyState(), context, companyId, runId); }

    async getCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string): Promise<unknown | null> { return getCompanyRunPendingPlan(this.companyState(), context, companyId, runId); }
  async setCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string, plan: unknown | null): Promise<void> {
    await this.getCompanyAgentRun(context, companyId, runId);
    if (plan === null) this.companyRunPendingPlans.delete(runId);
    else this.companyRunPendingPlans.set(runId, structuredClone(plan));
  }
    async updateCompanyAgentRun(context: AuthContext, companyId: string, runId: string, patch: Partial<CompanyAgentRun>) { return updateCompanyAgentRun(this.companyState(), context, companyId, runId, patch); }

  async updateCompanyAgentRunStep(context: AuthContext, companyId: string, runId: string, agentId: string, status: CompanyAgentRunStep["status"]) {
    await this.getCompanyAgentRun(context, companyId, runId);
    for (const [id, step] of this.companyRunSteps) if (step.runId === runId && step.agentId === agentId)
      this.companyRunSteps.set(id, { ...step, status, updatedAt: new Date().toISOString() });
  }
  async replaceCompanyAgentRunSteps(context: AuthContext, companyId: string, runId: string, steps: Array<Pick<CompanyAgentRunStep, "agentId" | "stepOrder" | "lane" | "role" | "status" | "modelId">>) { return replaceCompanyAgentRunSteps(this.companyState(), context, companyId, runId, steps); }
  async appendCompanyAgentToolAudit(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentToolAudit, "agentId" | "toolName" | "decision" | "status" | "inputSummary" | "errorMessage"> & Partial<Pick<CompanyAgentToolAudit, "latencyMs" | "cost" | "tokens" | "reasonCode" | "sequenceNumber">>) { return appendCompanyAgentToolAudit(this.companyState(), context, companyId, runId, entry); }
  async appendCompanyAgentRunEvent(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentRunEvent, "eventKey" | "eventType" | "runStatus" | "message"> & Partial<Pick<CompanyAgentRunEvent, "workerId" | "attemptCount" | "details">>) { return appendCompanyAgentRunEvent(this.companyState(), context, companyId, runId, entry); }
  async claimCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) { return claimCompanyAgentRun(this.companyState(), context, companyId, runId, workerId, leaseMs); }
  async heartbeatCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) { return heartbeatCompanyAgentRun(this.companyState(), context, companyId, runId, workerId, leaseMs); }
  async requeueCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, delayMs: number) { return requeueCompanyAgentRun(this.companyState(), context, companyId, runId, workerId, delayMs); }
  async listRecoverableCompanyAgentRuns(limit = 200) { return listRecoverableCompanyAgentRuns(this.companyState(), limit); }

    async listGoals(context: AuthContext, businessId: string) { return listGoals(this.goalState(), context, businessId); }

    async listUserGoals(context: AuthContext) { return listUserGoals(this.companyState(), context); }

    async createGoal(context: AuthContext, businessId: string, input: GoalInput) { return createGoal(this.goalState(), context, businessId, input); }

  async linkGoal(context: AuthContext, businessId: string, goalId: string) { return linkGoal(this.collaborationState(), context, businessId, goalId); }
  async updateGoal(context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>) { return updateGoal(this.goalState(), context, businessId, goalId, input); }
  async deleteGoal(context: AuthContext, businessId: string, goalId: string) { return deleteGoal(this.goalState(), context, businessId, goalId); }
  async listMemory(context: AuthContext, businessId: string, query = "", limit = 100) { return listMemory(this.goalState(), context, businessId, query, limit); }
  async listUserMemories(context: AuthContext, query = "", limit = 100) { return listUserMemories(this.companyState(), context, query, limit); }
  async createMemory(context: AuthContext, businessId: string, input: MemoryInput) { return createMemory(this.goalState(), context, businessId, input); }
  async linkMemory(context: AuthContext, businessId: string, memoryId: string) { return linkMemory(this.collaborationState(), context, businessId, memoryId); }
  async updateMemory(context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>) { return updateMemory(this.goalState(), context, businessId, memoryId, input); }
  async deleteMemory(context: AuthContext, businessId: string, memoryId: string) { return deleteMemory(this.collaborationState(), context, businessId, memoryId); }
  async listConversations(context: AuthContext, businessId: string) { return listConversations(this.collaborationState(), context, businessId); }
  async createConversation(context: AuthContext, businessId: string, title: string) { return createConversation(this.collaborationState(), context, businessId, title); }
  async getConversation(context: AuthContext, businessId: string, conversationId: string) { return getConversation(this.collaborationState(), context, businessId, conversationId); }
  async updateConversation(context: AuthContext, businessId: string, conversationId: string, title: string) { return updateConversation(this.collaborationState(), context, businessId, conversationId, title); }
  async deleteConversation(context: AuthContext, businessId: string, conversationId: string) { return deleteConversation(this.collaborationState(), context, businessId, conversationId); }
  async appendMessage(context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string) { return appendMessage(this.collaborationState(), context, businessId, conversationId, role, content); }
  async listNeutralConversations(context: AuthContext) { return listNeutralConversations(this.collaborationState(), context); }
  async createNeutralConversation(context: AuthContext, title: string) { return createNeutralConversation(this.collaborationState(), context, title); }
  async getNeutralConversation(context: AuthContext, conversationId: string) { return getNeutralConversation(this.collaborationState(), context, conversationId); }
  async updateNeutralConversation(context: AuthContext, conversationId: string, title: string) { return updateNeutralConversation(this.collaborationState(), context, conversationId, title); }
  async deleteNeutralConversation(context: AuthContext, conversationId: string) { return deleteNeutralConversation(this.collaborationState(), context, conversationId); }
  async appendNeutralMessage(context: AuthContext, conversationId: string, role: ConversationMessage["role"], content: string) { return appendNeutralMessage(this.collaborationState(), context, conversationId, role, content); }
  private readonly conversationResearch = new InMemoryConversationResearch(this.conversations);
  async appendConversationResearch(context: AuthContext, conversationId: string, input: ConversationResearchInput) { if (input.companyId) await this.getCompany(context, input.companyId); return this.conversationResearch.append(context, conversationId, input); }
  async listConversationResearch(context: AuthContext, conversationId: string, limit?: number) { return this.conversationResearch.list(context, conversationId, limit); }
  async listOnboardings(context: AuthContext) { return listOnboardings(this.collaborationState(), context); }
  async getOnboarding(context: AuthContext, businessId?: string) { return getOnboarding(this.collaborationState(), context, businessId); }
  async startOnboarding(context: AuthContext, scenario: OnboardingScenario, options?: { forceNew?: boolean }) { return startOnboarding(this.collaborationState(), context, scenario, options); }
  async advanceOnboarding(context: AuthContext, sessionId: string, input: { value?: string; skip?: boolean; businessPatch?: Partial<BusinessInput> }) { return advanceOnboarding(this.collaborationState(), context, sessionId, input); }
  async setOnboardingStatus(context: AuthContext, sessionId: string, status: "active" | "paused") { return setOnboardingStatus(this.collaborationState(), context, sessionId, status); }
  async completeOnboarding(context: AuthContext, sessionId: string) { return completeOnboarding(this.collaborationState(), context, sessionId); }

    async getCompanyMembership(companyId: string, userId: string): Promise<CompanyMember | null> { return getCompanyMembership(this.companyState(), companyId, userId); }

    async listCompanyMembers(companyId: string): Promise<CompanyMember[]> { return listCompanyMembers(this.companyState(), companyId); }

  async countCompanyOwners(companyId: string): Promise<number> { return this.companyMembershipOps.countCompanyOwners(companyId); }

    async createCompanyInvite(input: CompanyInviteInput): Promise<CompanyInvite> { return createCompanyInvite(this.companyState(), input); }

  async findCompanyInviteByTokenHash(tokenHash: string): Promise<CompanyInvite | null> { return this.companyMembershipOps.findCompanyInviteByTokenHash(tokenHash); }

  async acceptCompanyInvite(input: AcceptCompanyInviteInput): Promise<CompanyMember> { return this.companyMembershipOps.acceptCompanyInvite(input); }

    async updateCompanyMemberRole(input: UpdateCompanyMemberRoleInput): Promise<CompanyMember> { return updateCompanyMemberRole(this.companyState(), input); }

  async removeCompanyMember(input: RemoveCompanyMemberInput): Promise<void> { return this.companyMembershipOps.removeCompanyMember(input); }

  private providerPolicyKey(companyId: string | null, providerId: string, modelPattern: string | null): string { return ruleProviderPolicyKey(companyId, providerId, modelPattern); }

  private assertValidProviderPolicy(input: UpsertProviderDataPolicyStoreInput): void { return ruleAssertValidProviderPolicy(input); }

  async getProviderDataPolicy(input: {
    companyId: string | null;
    providerId: string;
    modelPattern: string | null;
  }): Promise<ProviderDataPolicyRecord | null> {
    return structuredClone(
      this.providerDataPolicies.get(ruleProviderPolicyKey(input.companyId, input.providerId, input.modelPattern)) ?? null,
    );
  }

  async listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]> { return this.dataPolicyOps.listProviderDataPolicies(companyId); }

  async upsertProviderDataPolicy(input: UpsertProviderDataPolicyStoreInput): Promise<ProviderDataPolicyRecord> { return this.dataPolicyOps.upsertProviderDataPolicy(input); }

  async listProviderDataPolicyVersions(
    companyId: string | null,
    providerId?: string,
  ): Promise<ProviderDataPolicyVersionRecord[]> {
    return this.dataPolicyOps.listProviderDataPolicyVersions(companyId, providerId);
  }

    async getProjectDataPolicy(companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null> { return getProjectDataPolicy(this.projectState(), companyId, projectId); }

  async upsertProjectDataPolicy(input: UpsertProjectDataPolicyStoreInput): Promise<ProjectDataPolicyRecord> { return this.dataPolicyOps.upsertProjectDataPolicy(input); }

  private assertValidPathRule(rule: ProjectDataPolicyPathRule): ProjectDataPolicyPathRule { return ruleAssertValidPathRule(rule); }

    async grantHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    grantedBy: string;
    grantedAt: Date;
  }): Promise<ProviderHostedConsentRecord> {
    return grantHostedProviderConsent(this.companyState(), input);
  }

    async revokeHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    revokedAt: Date;
  }): Promise<ProviderHostedConsentRecord> {
    return revokeHostedProviderConsent(this.companyState(), input);
  }

  async getHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
  }): Promise<ProviderHostedConsentRecord | null> {
    return structuredClone(
      this.hostedProviderConsent.get(`${input.companyId}\u0000${input.projectId}\u0000${input.providerId}`) ?? null,
    );
  }

  private findInviteByTokenHash(tokenHash: string): CompanyInvite | undefined { return this.companyMembershipOps.findInviteByTokenHash(tokenHash); }

    async createCodeRunState(input: CreateCodeRunStateInput): Promise<CodeRunStateRecord> { return createCodeRunState(this.codeState(), input); }

    async getCodeRunRequest(companyId: string, runId: string): Promise<CodeRunRequestRecord | null> { return getCodeRunRequest(this.codeState(), companyId, runId); }

    async applyCodeRunStateEvent(input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord> { return applyCodeRunStateEvent(this.codeState(), input); }

    async getCodeRunState(companyId: string, runId: string): Promise<CodeRunStateRecord | null> { return getCodeRunState(this.codeState(), companyId, runId); }

  async listStaleCodeRunStates(input: { now: Date; limit: number }): Promise<CodeRunStateRecord[]> { return this.codeRunOps.listStaleCodeRunStates(input); }

  async upsertCodeRunTurn(input: UpsertCodeRunTurnInput): Promise<CodeRunTurnRecord> { return this.codeRunOps.upsertCodeRunTurn(input); }

    async getCodeRunTurn(companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null> { return getCodeRunTurn(this.codeState(), companyId, runId, turnIndex); }

    async listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]> { return listCodeRunTurns(this.codeState(), companyId, runId); }

    async listCodeRunStates(input: ListCodeRunStatesInput): Promise<CodeRunStateRecord[]> { return listCodeRunStates(this.codeState(), input); }

    async listCodeRunStatesForScan(input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>> { return listCodeRunStatesForScan(this.codeState(), input); }

    async listCodeProjectRefs(input: CodeProjectRefScanInput): Promise<CodeProjectRefScanPage> { return listCodeProjectRefs(this.codeState(), input); }

    async getProjectForSystem(companyId: string, projectId: string): Promise<Project | null> { return getProjectForSystem(this.projectState(), companyId, projectId); }

    async listCodeRunTurnsForScan(input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>> { return listCodeRunTurnsForScan(this.codeState(), input); }

  private activeOwnerCount(companyId: string): number { return this.companyMembershipOps.activeOwnerCount(companyId); }

  private isLastActiveOwnerDemotion(member: CompanyMember, nextRole: string): boolean { return this.companyMembershipOps.isLastActiveOwnerDemotion(member, nextRole); }

  private isLastActiveOwner(member: CompanyMember): boolean { return this.companyMembershipOps.isLastActiveOwner(member); }

  async createExecutionSnapshot(input: CreateExecutionSnapshotInput): Promise<ExecutionSnapshotRecord> { return this.codeRunOps.createExecutionSnapshot(input); }

  async getExecutionSnapshot(companyId: string, snapshotId: string): Promise<ExecutionSnapshotRecord | null> { return this.codeRunOps.getExecutionSnapshot(companyId, snapshotId); }

  async getLatestSnapshotForSession(companyId: string, sessionId: string): Promise<ExecutionSnapshotRecord | null> { return this.codeRunOps.getLatestSnapshotForSession(companyId, sessionId); }

  async getSnapshotForRun(companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null> { return this.codeRunOps.getSnapshotForRun(companyId, runId); }

  async listExecutionSnapshots(input: ListExecutionSnapshotsInput): Promise<ExecutionSnapshotRecord[]> { return this.codeRunOps.listExecutionSnapshots(input); }

  diffExecutionSnapshots(a: ExecutionSnapshotRecord, b: ExecutionSnapshotRecord): ExecutionSnapshotDiff {
    const { changes, unchanged } = diffSnapshotPayloads(a.payload, b.payload);
    return {
      fromSnapshotId: a.id, toSnapshotId: b.id,
      fromVersion: a.snapshotVersion, toVersion: b.snapshotVersion,
      changes, unchanged,
    };
  }

  async createSnapshotConfigVersion(input: CreateSnapshotConfigVersionInput): Promise<SnapshotConfigVersionRecord> { return this.codeRunOps.createSnapshotConfigVersion(input); }

  async getSnapshotConfigVersion(
    companyId: string, kind: SnapshotConfigKind, version: number,
  ): Promise<SnapshotConfigVersionRecord | null> {
    return this.codeRunOps.getSnapshotConfigVersion(companyId, kind, version);
  }

  async findSnapshotConfigVersionByHash(
    companyId: string, kind: SnapshotConfigKind, contentHash: string,
  ): Promise<SnapshotConfigVersionRecord | null> {
    return this.codeRunOps.findSnapshotConfigVersionByHash(companyId, kind, contentHash);
  }

  async listSnapshotConfigVersions(companyId: string, kind: SnapshotConfigKind): Promise<SnapshotConfigVersionRecord[]> { return this.codeRunOps.listSnapshotConfigVersions(companyId, kind); }

    async createCodeUserQuestion(input: CreateCodeUserQuestionInput): Promise<CodeUserQuestionRecord> { return createCodeUserQuestion(this.codeState(), input); }

    async getCodeUserQuestion(companyId: string, questionId: string): Promise<CodeUserQuestionRecord | null> { return getCodeUserQuestion(this.codeState(), companyId, questionId); }

  async getPendingCodeUserQuestionForRun(companyId: string, runId: string): Promise<CodeUserQuestionRecord | null> { return this.codeUserQuestionState.getPendingQuestionForRun(companyId, runId); }

  async answerCodeUserQuestion(input: AnswerCodeUserQuestionInput): Promise<CodeUserQuestionRecord> { return this.codeUserQuestionState.answerQuestion(input); }

  async expireCodeUserQuestions(input: { now?: Date; companyId?: string; runId?: string } = {}): Promise<number> { return this.codeUserQuestionState.expireQuestions(input); }

  async listExpiredCodeUserQuestions(input: { now?: Date; limit?: number } = {}): Promise<CodeUserQuestionRecord[]> { return this.codeUserQuestionState.listExpiredQuestions(input); }

  async cancelPendingCodeUserQuestions(input: { companyId: string; runId: string; now?: Date }): Promise<number> { return this.codeUserQuestionState.cancelPendingQuestions(input); }

    async getCodeSessionHead(companyId: string, sessionId: string): Promise<CodeSessionHeadRecord | null> { return getCodeSessionHead(this.codeState(), companyId, sessionId); }

  async setCodeSessionHead(input: SetCodeSessionHeadInput): Promise<CodeSessionHeadRecord> { return this.codeSessionDurabilityState.setHead(input); }

    async createCodeRunRecoveryNotice(input: CreateCodeRunRecoveryNoticeInput): Promise<CodeRunRecoveryNoticeRecord> { return createCodeRunRecoveryNotice(this.codeState(), input); }

  async getLatestCodeRunRecoveryNotice(companyId: string, runId: string): Promise<CodeRunRecoveryNoticeRecord | null> { return this.codeSessionDurabilityState.getLatestNotice(companyId, runId); }

    async listCodeRunRecoveryNotices(input: { companyId: string; runId: string; limit?: number }): Promise<CodeRunRecoveryNoticeRecord[]> { return listCodeRunRecoveryNotices(this.codeState(), input); }

    async createCodeSessionRewind(input: CreateCodeSessionRewindInput): Promise<{ record: CodeSessionRewindRecord; replayed: boolean }> {
    return createCodeSessionRewind(this.codeState(), input);
  }

    async getCodeSessionRewind(companyId: string, operationId: string): Promise<CodeSessionRewindRecord | null> { return getCodeSessionRewind(this.codeState(), companyId, operationId); }

  async reopenCodeSessionRewind(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionRewindRecord | null; reopened: boolean }> {
    return this.codeSessionDurabilityState.reopenRewind(input);
  }

  async completeCodeSessionRewind(input: CompleteCodeSessionRewindInput): Promise<CodeSessionRewindRecord> { return this.codeSessionDurabilityState.completeRewind(input); }

    async listCodeSessionRewinds(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionRewindRecord[]> { return listCodeSessionRewinds(this.codeState(), input); }

    async createCodeSessionFork(input: CreateCodeSessionForkInput): Promise<{ record: CodeSessionForkRecord; replayed: boolean }> {
    return createCodeSessionFork(this.codeState(), input);
  }

    async getCodeSessionFork(companyId: string, operationId: string): Promise<CodeSessionForkRecord | null> { return getCodeSessionFork(this.codeState(), companyId, operationId); }

  async completeCodeSessionFork(input: CompleteCodeSessionForkInput): Promise<CodeSessionForkRecord> { return this.codeSessionDurabilityState.completeFork(input); }

    async listCodeSessionForks(input: { companyId: string; parentSessionId: string; limit?: number }): Promise<CodeSessionForkRecord[]> { return listCodeSessionForks(this.codeState(), input); }

  async reopenCodeSessionFork(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionForkRecord | null; reopened: boolean }> {
    return this.codeSessionDurabilityState.reopenFork(input);
  }

    async createCodeGoal(input: CreateCodeGoalInput): Promise<CodeGoalWithCriteria> { return createCodeGoal(this.codeState(), input); }

    async getCodeGoal(companyId: string, goalId: string): Promise<CodeGoalWithCriteria | null> { return getCodeGoal(this.codeState(), companyId, goalId); }

    async listCodeGoals(input: { companyId: string; sessionId?: string; projectId?: string; limit?: number }): Promise<CodeGoalRecord[]> { return listCodeGoals(this.codeState(), input); }

    async updateCodeGoal(input: UpdateCodeGoalInput): Promise<CodeGoalWithCriteria> { return updateCodeGoal(this.codeState(), input); }

  async setCodeGoalCriterionStatus(input: SetCodeGoalCriterionStatusInput): Promise<CodeGoalWithCriteria> { return this.codeGoalState.setCriterionStatus(input); }

    async createCodeSessionPlan(input: CreateCodeSessionPlanInput): Promise<CodeSessionPlanRecord> { return createCodeSessionPlan(this.codeState(), input); }

  async getLatestCodeSessionPlan(companyId: string, sessionId: string): Promise<CodeSessionPlanRecord | null> { return this.codeGoalState.getLatestPlan(companyId, sessionId); }

    async listCodeSessionPlans(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionPlanRecord[]> { return listCodeSessionPlans(this.codeState(), input); }

  async decideCodeSessionPlan(input: DecideCodeSessionPlanInput): Promise<CodeSessionPlanRecord> { return this.codeGoalState.decidePlan(input); }

  async replaceCodeSessionTodos(input: ReplaceCodeSessionTodosInput): Promise<CodeSessionTodoRecord[]> { return this.codeGoalState.replaceTodos(input); }

    async listCodeSessionTodos(input: { companyId: string; sessionId: string }): Promise<CodeSessionTodoRecord[]> { return listCodeSessionTodos(this.codeState(), input); }

    async createCodeContextSummary(input: CreateCodeContextSummaryInput): Promise<CodeContextSummaryRecord> { return createCodeContextSummary(this.codeState(), input); }

    async listCodeContextSummaries(input: ListCodeContextSummariesInput): Promise<CodeContextSummaryRecord[]> { return listCodeContextSummaries(this.codeState(), input); }

    async createCodeActivityEvent(input: CreateCodeActivityEventInput): Promise<CodeActivityEventRecord> { return createCodeActivityEvent(this.codeState(), input); }

    async listCodeActivityEvents(input: ListCodeActivityEventsInput): Promise<CodeActivityEventRecord[]> { return listCodeActivityEvents(this.codeState(), input); }

  async createReplayBundle(input: CreateReplayBundleInput): Promise<ReplayBundleRecord> { return this.codeRunOps.createReplayBundle(input); }

  async getReplayBundle(companyId: string, runId: string, bundleVersion?: number): Promise<ReplayBundleRecord | null> { return this.codeRunOps.getReplayBundle(companyId, runId, bundleVersion); }

  async getReplayBundleById(companyId: string, bundleId: string): Promise<ReplayBundleRecord | null> { return this.codeRunOps.getReplayBundleById(companyId, bundleId); }

  async listReplayBundles(input: ListReplayBundlesInput): Promise<ReplayBundleRecord[]> { return this.codeRunOps.listReplayBundles(input); }

  async listReplayBundleSteps(companyId: string, bundleId: string): Promise<ReplayBundleStepRecord[]> { return this.codeRunOps.listReplayBundleSteps(companyId, bundleId); }
}
