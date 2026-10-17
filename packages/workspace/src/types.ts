import type {
  CodeGoalRecord,
  CodeGoalWithCriteria,
  CodeSessionPlanRecord,
  CodeSessionTodoRecord,
  CreateCodeGoalInput,
  CreateCodeSessionPlanInput,
  DecideCodeSessionPlanInput,
  ReplaceCodeSessionTodosInput,
  SetCodeGoalCriterionStatusInput,
  UpdateCodeGoalInput,
} from "./code-goal-types";
import type { CodeInboxStore } from "./code-session-inbox";
import type {
  AnswerCodeUserQuestionInput,
  CodeUserQuestionRecord,
  CreateCodeUserQuestionInput,
} from "./code-question-store";
import type {
  CodeRunRecoveryNoticeRecord,
  CodeSessionForkRecord,
  CodeSessionHeadRecord,
  CodeSessionRewindRecord,
  CompleteCodeSessionForkInput,
  CompleteCodeSessionRewindInput,
  CreateCodeRunRecoveryNoticeInput,
  CreateCodeSessionForkInput,
  CreateCodeSessionRewindInput,
  SetCodeSessionHeadInput,
} from "./code-session-durability-store";

/**
 * C9 types are defined in `code-goal-types.ts` and `code-question-store.ts` and re-exported here so the store
 * interface can name them without this file growing another few hundred lines. The dependency is type-only in
 * both directions, so there is no runtime cycle.
 */
export type {
  CodeGoalCriterionRecord,
  CodeGoalCriterionStatus,
  CodeGoalRecord,
  CodeGoalStatus,
  CodeGoalWithCriteria,
  CodePlanBody,
  CodePlanExecutionMode,
  CodeSessionPlanRecord,
  CodeSessionPlanStatus,
  CodeSessionTodoRecord,
  CodeSessionTodoStatus,
  CreateCodeGoalInput,
  CreateCodeSessionPlanInput,
  DecideCodeSessionPlanInput,
  ReplaceCodeSessionTodosInput,
  SetCodeGoalCriterionStatusInput,
  UpdateCodeGoalInput,
} from "./code-goal-types";
export {
  CODE_GOAL_CRITERION_STATUSES,
  CODE_GOAL_STATUSES,
  CODE_PLAN_EXECUTION_MODES,
  CODE_SESSION_PLAN_STATUSES,
  CODE_SESSION_TODO_STATUSES,
  CodeGoalAcceptanceUnverifiedError,
  CodeSessionPlanRevisionConflictError,
  CodeSessionTodosInvalidError,
  isCodePlanExecutionMode,
} from "./code-goal-types";
export type {
  AnswerCodeUserQuestionInput,
  CodeUserQuestionAnswer,
  CodeUserQuestionChoice,
  CodeUserQuestionRecord,
  CodeUserQuestionStatus,
  CreateCodeUserQuestionInput,
} from "./code-question-store";
export {
  CODE_USER_QUESTION_STATUSES,
  CodeUserQuestionAnswerInvalidError,
  CodeUserQuestionNotFoundError,
  CodeUserQuestionRevisionConflictError,
  CodeUserQuestionStateError,
  DEFAULT_QUESTION_TTL_MS,
  MAX_QUESTION_ANSWER_CHARS,
  MAX_QUESTION_CHOICES,
  MAX_QUESTION_PROMPT_CHARS,
  MAX_QUESTION_TTL_MS,
  questionTtlMs,
  validateQuestionAnswer,
  validateQuestionRequest,
} from "./code-question-store";
/**
 * C10 types are defined in `code-session-durability-store.ts` (the conversation cursor, the recovery notice and
 * the two operation ledgers) and re-exported here so the store interface can name them. The dependency is
 * type-only in both directions, so there is no runtime cycle.
 */
export type {
  CodeForkStatus,
  CodeRewindStatus,
  CodeRewindTarget,
  CodeRunRecoveryNoticeRecord,
  CodeSessionForkRecord,
  CodeSessionHeadReason,
  CodeSessionHeadRecord,
  CodeSessionRewindRecord,
  CompleteCodeSessionForkInput,
  CompleteCodeSessionRewindInput,
  CreateCodeRunRecoveryNoticeInput,
  CreateCodeSessionForkInput,
  CreateCodeSessionRewindInput,
  SetCodeSessionHeadInput,
} from "./code-session-durability-store";
export {
  CODE_FORK_STATUSES,
  CODE_REWIND_STATUSES,
  CODE_REWIND_TARGETS,
  CODE_SESSION_HEAD_REASONS,
  CodeSessionHeadRevisionConflictError,
  CodeSessionOperationInProgressError,
  CodeSessionOperationNotFoundError,
} from "./code-session-durability-store";


export * from "./types/index";

import type {
  AcceptCompanyInviteInput,
  ApplyCodeRunStateEventInput,
  AuditAnchor,
  AuditChainState,
  AuditChainVerification,
  AuditEntry,
  AuditEntryInput,
  AuthContext,
  Business,
  BusinessInput,
  BusinessOnboardingSession,
  BusinessPage,
  BusinessToCompanyInput,
  CodeActivityEventRecord,
  CodeApprovalRule,
  CodeApprovalRuleInput,
  CodeApprovalRuleScope,
  CodeContextSummaryRecord,
  CodeDataLifecycleStore,
  CodeProjectRef,
  CodeProjectRefScanInput,
  CodeProjectRefScanPage,
  CodeRunRequestRecord,
  CodeRunScanPage,
  CodeRunStateRecord,
  CodeRunStateScanInput,
  CodeRunTurnRecord,
  CodeRunTurnScanInput,
  CodeSession,
  CodeSessionInput,
  CodeSessionMode,
  CodeSessionStatus,
  CodeToolManifest,
  Company,
  CompanyAgent,
  CompanyAgentEdge,
  CompanyAgentInput,
  CompanyAgentPage,
  CompanyAgentRun,
  CompanyAgentRunDetails,
  CompanyAgentRunEvent,
  CompanyAgentRunStep,
  CompanyAgentToolAudit,
  CompanyInput,
  CompanyInvite,
  CompanyInviteInput,
  CompanyMember,
  CompanyPage,
  CompanyRunMode,
  Conversation,
  ConversationMessage,
  CreateCheckpointInput,
  CreateCodeActivityEventInput,
  CreateCodeContextSummaryInput,
  CreateCodeRunStateInput,
  CreateDeploymentInput,
  CreateExecutionSnapshotInput,
  CreateProjectQaReportInput,
  CreateReplayBundleInput,
  CreateSnapshotConfigVersionInput,
  DataClassification,
  DeploymentStatus,
  ExecutionSnapshotDiff,
  ExecutionSnapshotRecord,
  FeatureFlag,
  FeatureFlagHistoryEntry,
  FeatureFlagInput,
  Goal,
  GoalInput,
  ListCodeActivityEventsInput,
  ListCodeContextSummariesInput,
  ListCodeRunStatesInput,
  ListExecutionSnapshotsInput,
  ListReplayBundlesInput,
  MemoryInput,
  MemoryItem,
  OnboardingScenario,
  OnboardingStatus,
  Project,
  ProjectCheckpoint,
  ProjectCodeSettings,
  ProjectCodeTrust,
  ProjectCodeTrustInput,
  ProjectDataPolicyRecord,
  ProjectDeployment,
  ProjectInput,
  ProjectMountedFolder,
  ProjectMountedFolderInput,
  ProjectQaReport,
  ProjectStatus,
  ProviderDataPolicyRecord,
  ProviderDataPolicyVersionRecord,
  ProviderHostedConsentRecord,
  RemoveCompanyMemberInput,
  ReplayBundleRecord,
  ReplayBundleStepRecord,
  RetentionClass,
  SandboxImage,
  SandboxImageInput,
  SandboxImageVariant,
  SnapshotConfigKind,
  SnapshotConfigVersionRecord,
  UpdateCompanyMemberRoleInput,
  UpsertCodeRunTurnInput,
  UpsertProjectDataPolicyStoreInput,
  UpsertProviderDataPolicyStoreInput,
  UserSetting,
  WorkspaceOverview,
} from "./types/index";

export interface WorkspaceStore {
  /** Optional additive inbox port; absent deployments refuse asynchronous input. */
  codeInbox?: CodeInboxStore;
  codeProcesses?: import("./code-process-store").CodeProcessStore;
  initialize(context?: AuthContext): Promise<void>;
  /**
   * G1 (item 2): releases the resources the store owns — for the PostgreSQL implementation the connection
   * pool it created and that nothing else owns (`apps/agent-api/src/app.ts` closes it **last** in `onClose`,
   * because `ApiKeysRepository`, `ScopedMemoryEngine` and `GuardrailPolicyRepository` borrow that pool).
   *
   * Optional on purpose: a store without owned resources (the in-memory one) has nothing to release, so a
   * caller must write `close?.()`. Closing is idempotent from the caller's side — `pg`'s `Pool.end()`
   * resolves when it has already been ended — so a shutdown path and a test can both call it.
   */
  close?(): Promise<void>;
  /**
   * R1-C (items 11–13): retention and erasure of the Coding Agent's own rows.
   *
   * Optional by construction, exactly like `close?.()`: the database backend implements it, and a backend
   * without it (the in-memory store, a future one) makes the caller report `data_lifecycle_unavailable`
   * rather than silently doing nothing. Never required, because a caller must not be able to assume an
   * erasure happened.
   */
  codeDataLifecycle?: CodeDataLifecycleStore;
  getUserSetting(context: AuthContext, key: string): Promise<UserSetting | null>;
  setUserSetting(context: AuthContext, key: string, value: unknown, expectedRevision: number): Promise<UserSetting | null>;
  health(): Promise<"ok" | "unavailable">;
  overview(context: AuthContext): Promise<WorkspaceOverview>;
  setCurrentBusiness(context: AuthContext, businessId: string): Promise<Business>;
  listBusinesses(context: AuthContext): Promise<Business[]>;
  listUserBusinesses(context: AuthContext): Promise<Business[]>;
  listBusinessesPage(context: AuthContext, limit?: number, cursor?: string): Promise<BusinessPage>;
  getBusiness(context: AuthContext, businessId: string): Promise<Business>;
  getUserBusiness(context: AuthContext, businessId: string): Promise<Business>;
  createBusiness(context: AuthContext, input: BusinessInput, idempotencyKey?: string): Promise<Business>;
  updateBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>): Promise<Business>;
  updateUserBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>): Promise<Business>;
  deleteBusiness(context: AuthContext, businessId: string): Promise<boolean>;
  listCompanies(context: AuthContext, limit?: number, cursor?: string): Promise<CompanyPage>;
  getCompany(context: AuthContext, companyId: string): Promise<Company>;
  createCompany(context: AuthContext, input: CompanyInput, idempotencyKey: string): Promise<Company>;
  convertBusinessToCompany(context: AuthContext, businessId: string, input: BusinessToCompanyInput, idempotencyKey: string): Promise<{ company: Company; created: boolean }>;
  updateCompany(context: AuthContext, companyId: string, input: Partial<CompanyInput>, expectedRevision: number): Promise<Company>;
  deleteCompany(context: AuthContext, companyId: string): Promise<boolean>;
  setCompanyMainAgent(context: AuthContext, companyId: string, agentId: string | null, expectedRevision: number): Promise<Company>;
  createProject(context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string): Promise<{ project: Project; created: boolean }>;
  listProjects(context: AuthContext, companyId: string, includeArchived?: boolean): Promise<Project[]>;
  getProject(context: AuthContext, companyId: string, projectId: string): Promise<Project>;
  updateProject(context: AuthContext, companyId: string, projectId: string, input: { name?: string; expectedRevision: number; code?: ProjectCodeSettings }): Promise<Project>;
  archiveProject(context: AuthContext, companyId: string, projectId: string, expectedRevision: number): Promise<Project>;
  setProjectSandbox(context: AuthContext, companyId: string, projectId: string, sandboxId: string | null, expectedSandboxId: string | null): Promise<Project>;
  updateProjectRepository(context: AuthContext, companyId: string, projectId: string, input: { provider: string; url: string; branch: string }): Promise<Project>;
  updateProjectPreview(context: AuthContext, companyId: string, projectId: string, patch: { status?: ProjectStatus; previewUrl?: string | null; previewPort?: number | null; framework?: string | null; runtime?: string | null; lastBuildStatus?: string | null; deploymentUrl?: string | null; deploymentStatus?: string | null; lastDeploymentStatus?: string | null; lastDeployedAt?: string | null }): Promise<Project>;
  deleteProject(context: AuthContext, companyId: string, projectId: string): Promise<boolean>;


  /** C1a: feature flags (resolution is user -> company -> global) and their change history. */
  listFeatureFlags(context: AuthContext): Promise<FeatureFlag[]>;
  setFeatureFlag(context: AuthContext, input: FeatureFlagInput): Promise<FeatureFlag>;
  listFeatureFlagHistory(context: AuthContext, flagKey?: string, limit?: number): Promise<FeatureFlagHistoryEntry[]>;
  /** C1a: published tool-schema manifest, so an old session reads with the manifest it was created with. */
  publishCodeToolManifest(context: AuthContext, manifest: { version: number; tools: CodeToolManifest["tools"]; checksum: string }): Promise<CodeToolManifest>;
  latestCodeToolManifest(context: AuthContext): Promise<CodeToolManifest | null>;

  /** C1b: sandbox image catalogue. Admission reads it; allow/revoke/waiver write it (audited first). */
  listSandboxImages(context: AuthContext): Promise<SandboxImage[]>;
  getSandboxImage(context: AuthContext, reference: string): Promise<SandboxImage | null>;
  upsertSandboxImage(context: AuthContext, input: SandboxImageInput): Promise<SandboxImage>;
  revokeSandboxImage(context: AuthContext, reference: string, input: { actor: string; reason: string }): Promise<SandboxImage>;
  latestVerifiedSandboxImage(context: AuthContext, variant: SandboxImageVariant): Promise<SandboxImage | null>;

  /**
   * C5: scoped approval rules (`session` | `project`). A rule widens an approval inside a bounded
   * scope; it can never widen a prohibition, because hard deny, the network gate and the session-mode
   * denial are decided in earlier policy phases than the approval phase that consults these rules.
   */
  createCodeApprovalRule(context: AuthContext, companyId: string, input: CodeApprovalRuleInput): Promise<CodeApprovalRule>;
  listCodeApprovalRules(context: AuthContext, companyId: string, filters?: { projectId?: string; sessionId?: string; scope?: CodeApprovalRuleScope }): Promise<CodeApprovalRule[]>;
  deleteCodeApprovalRule(context: AuthContext, companyId: string, ruleId: string): Promise<void>;
  findMatchingCodeApprovalRule(context: AuthContext, query: { companyId: string; projectId?: string | null; sessionId?: string | null; action: string }): Promise<CodeApprovalRule | null>;


  /** C1c: append-only audit journal. `appendAuditEntry` fails closed and is never idempotent-silent. */  appendAuditEntry(context: AuthContext, companyId: string, input: AuditEntryInput): Promise<AuditEntry>;
  listAuditEntries(context: AuthContext, companyId: string, filters?: { actor?: string; requestId?: string; correlationId?: string; action?: string; limit?: number; fromSequence?: number }): Promise<AuditEntry[]>;
  verifyAuditChain(context: AuthContext, companyId: string, range?: { fromSequence?: number; toSequence?: number }): Promise<AuditChainVerification>;
  auditChainState(context: AuthContext, companyId: string): Promise<AuditChainState>;
  recordAuditAnchor(context: AuthContext, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor>;
  listAuditAnchors(context: AuthContext, companyId: string, limit?: number): Promise<AuditAnchor[]>;
  latestAuditAnchor(context: AuthContext, companyId: string): Promise<AuditAnchor | null>;
  /** Company ids that have at least one audit entry, used by the background verifier/anchor job. */
  auditCompanies(context: AuthContext): Promise<string[]>;

  /**
   * System path for the background verifier and anchor job: it runs without a user context, so it is
   * scoped by workspace only and never exposes entry contents (states, counts and hashes only).
   */
  systemAuditChains(workspaceId: string): Promise<Array<{ companyId: string; state: AuditChainState; verification: AuditChainVerification; anchor?: AuditAnchor | null; anchorVerification?: AuditChainVerification }>>;
  systemRecordAuditAnchor(workspaceId: string, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor>;

  /** C1: code sessions. Scoped by workspace + company + project + owner. */  createCodeSession(context: AuthContext, companyId: string, projectId: string, input: CodeSessionInput): Promise<CodeSession>;
  getCodeSession(context: AuthContext, companyId: string, sessionId: string): Promise<CodeSession>;
  listCodeSessions(context: AuthContext, companyId: string, projectId?: string, options?: { includeArchived?: boolean; limit?: number }): Promise<CodeSession[]>;
  updateCodeSession(context: AuthContext, companyId: string, sessionId: string, patch: { status?: CodeSessionStatus; summary?: string; runId?: string | null; modelProfile?: string; dataClassification?: DataClassification; retentionClass?: RetentionClass; toolManifestVersion?: number | null; mode?: CodeSessionMode; expectedRevision?: number }): Promise<CodeSession>;

  /** C5: project trust. Owner/admin only at the API layer; the store is the single writer. */
  getProjectCodeTrust(context: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null>;
  setProjectCodeTrust(context: AuthContext, companyId: string, projectId: string, input: ProjectCodeTrustInput): Promise<ProjectCodeTrust>;
  /**
   * C15: the mounted-folder allowlist. `getProjectMountedFolder` is the tenant-scoped read the API and the
   * workspace resolver use; `setProjectMountedFolder` is the single writer (revision-checked).
   */
  getProjectMountedFolder(context: AuthContext, companyId: string, projectId: string): Promise<ProjectMountedFolder | null>;
  setProjectMountedFolder(context: AuthContext, companyId: string, projectId: string, input: ProjectMountedFolderInput): Promise<ProjectMountedFolder>;
  /**
   * C15: the same record, read **without a user context**, for the sandbox runner. The runner is the component
   * that really creates the container, so it must re-read the allowlist itself right before `docker create`
   * instead of trusting a path the API sent: between the confirmation and the create the path could have
   * become a symlink, and a client could simply have sent another one. `null` for an unknown id, so a runner
   * without the database mounts nothing (fail closed).
   */
  getProjectMountedFolderForSystem(companyId: string, projectId: string): Promise<ProjectMountedFolder | null>;
  createProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, input: CreateCheckpointInput): Promise<ProjectCheckpoint>;
  listProjectCheckpoints(context: AuthContext, companyId: string, projectId: string, limit?: number): Promise<ProjectCheckpoint[]>;
  getProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<ProjectCheckpoint>;
  deleteProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<boolean>;
  createProjectDeployment(context: AuthContext, companyId: string, projectId: string, input: CreateDeploymentInput): Promise<ProjectDeployment>;
  listProjectDeployments(context: AuthContext, companyId: string, projectId: string, limit?: number): Promise<ProjectDeployment[]>;
  getProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string): Promise<ProjectDeployment | null>;
  updateProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string, patch: Partial<ProjectDeployment>): Promise<ProjectDeployment>;
  createProjectQaReport(context: AuthContext, companyId: string, projectId: string, input: CreateProjectQaReportInput): Promise<ProjectQaReport>;
  listProjectQaReports(context: AuthContext, companyId: string, projectId: string, limit?: number, runId?: string): Promise<ProjectQaReport[]>;
  getProjectQaReport(context: AuthContext, companyId: string, projectId: string, reportId: string): Promise<ProjectQaReport | null>;
  getLatestProjectQaReport(context: AuthContext, companyId: string, projectId: string): Promise<ProjectQaReport | null>;
  listCompanyAgents(context: AuthContext, companyId: string): Promise<CompanyAgent[]>;
  listCompanyAgentsPage(context: AuthContext, companyId: string, limit?: number, cursor?: string): Promise<CompanyAgentPage>;
  getCompanyAgent(context: AuthContext, companyId: string, agentId: string): Promise<CompanyAgent>;
  createCompanyAgent(context: AuthContext, companyId: string, input: CompanyAgentInput, idempotencyKey: string): Promise<CompanyAgent>;
  updateCompanyAgent(context: AuthContext, companyId: string, agentId: string, input: Partial<CompanyAgentInput>, expectedRevision: number): Promise<CompanyAgent>;
  deleteCompanyAgent(context: AuthContext, companyId: string, agentId: string, expectedRevision: number): Promise<boolean>;
  listCompanyAgentEdges(context: AuthContext, companyId: string, agentIds?: string[]): Promise<CompanyAgentEdge[]>;
  setCompanyAgentParent(context: AuthContext, companyId: string, childAgentId: string, parentAgentId: string | null): Promise<CompanyAgentEdge | null>;
  createCompanyAgentRun(context: AuthContext, companyId: string, input: { task: string; requestedMode: CompanyRunMode; projectId?: string }, idempotencyKey: string): Promise<{ run: CompanyAgentRun; created: boolean }>;
  listCompanyAgentRuns(context: AuthContext, companyId: string, limit?: number, filter?: { projectId?: string }): Promise<CompanyAgentRun[]>;
  listProjectRuns(context: AuthContext, companyId: string, projectId: string, limit?: number): Promise<CompanyAgentRun[]>;
  getCompanyAgentRun(context: AuthContext, companyId: string, runId: string): Promise<CompanyAgentRunDetails>;
  getCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string): Promise<unknown | null>;
  setCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string, plan: unknown | null): Promise<void>;
  updateCompanyAgentRun(context: AuthContext, companyId: string, runId: string, patch: Partial<Pick<CompanyAgentRun, "status" | "executionMode" | "selectedAgentIds" | "omnirouteTaskId" | "omnirouteComboName" | "result" | "errorCode" | "errorMessage" | "cancelRequested" | "cancelReason" | "totalCost" | "totalTokens" | "totalDurationMs">>): Promise<CompanyAgentRun>;
  replaceCompanyAgentRunSteps(context: AuthContext, companyId: string, runId: string, steps: Array<Pick<CompanyAgentRunStep, "agentId" | "stepOrder" | "lane" | "role" | "status" | "modelId">>): Promise<CompanyAgentRunStep[]>;
  appendCompanyAgentToolAudit(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentToolAudit, "agentId" | "toolName" | "decision" | "status" | "inputSummary" | "errorMessage"> & Partial<Pick<CompanyAgentToolAudit, "latencyMs" | "cost" | "tokens" | "reasonCode" | "sequenceNumber">>): Promise<CompanyAgentToolAudit>;
  appendCompanyAgentRunEvent(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentRunEvent, "eventKey" | "eventType" | "runStatus" | "message"> & Partial<Pick<CompanyAgentRunEvent, "workerId" | "attemptCount" | "details">>): Promise<CompanyAgentRunEvent>;
  claimCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number): Promise<boolean>;
  heartbeatCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number): Promise<boolean>;
  requeueCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, delayMs: number): Promise<boolean>;
  listRecoverableCompanyAgentRuns(limit?: number): Promise<Array<{ context: AuthContext; companyId: string; runId: string }>>;
  listGoals(context: AuthContext, businessId: string): Promise<Goal[]>;
  listUserGoals(context: AuthContext): Promise<Goal[]>;
  createGoal(context: AuthContext, businessId: string, input: GoalInput): Promise<Goal>;
  linkGoal(context: AuthContext, businessId: string, goalId: string): Promise<Goal>;
  updateGoal(context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>): Promise<Goal>;
  deleteGoal(context: AuthContext, businessId: string, goalId: string): Promise<boolean>;
  listMemory(context: AuthContext, businessId: string, query?: string, limit?: number): Promise<MemoryItem[]>;
  listUserMemories(context: AuthContext, query?: string, limit?: number): Promise<MemoryItem[]>;
  createMemory(context: AuthContext, businessId: string, input: MemoryInput): Promise<MemoryItem>;
  linkMemory(context: AuthContext, businessId: string, memoryId: string): Promise<MemoryItem>;
  updateMemory(context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>): Promise<MemoryItem>;
  deleteMemory(context: AuthContext, businessId: string, memoryId: string): Promise<boolean>;
  listConversations(context: AuthContext, businessId: string): Promise<Conversation[]>;
  createConversation(context: AuthContext, businessId: string, title: string): Promise<Conversation>;
  getConversation(context: AuthContext, businessId: string, conversationId: string): Promise<{ conversation: Conversation; messages: ConversationMessage[] }>;
  updateConversation(context: AuthContext, businessId: string, conversationId: string, title: string): Promise<Conversation>;
  deleteConversation(context: AuthContext, businessId: string, conversationId: string): Promise<boolean>;
  appendMessage(context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string): Promise<ConversationMessage>;
  listNeutralConversations(context: AuthContext): Promise<Conversation[]>;
  createNeutralConversation(context: AuthContext, title: string): Promise<Conversation>;
  getNeutralConversation(context: AuthContext, conversationId: string): Promise<{ conversation: Conversation; messages: ConversationMessage[] }>;
  updateNeutralConversation(context: AuthContext, conversationId: string, title: string): Promise<Conversation>;
  deleteNeutralConversation(context: AuthContext, conversationId: string): Promise<boolean>;
  appendNeutralMessage(context: AuthContext, conversationId: string, role: ConversationMessage["role"], content: string): Promise<ConversationMessage>;
  getOnboarding(context: AuthContext, businessId?: string): Promise<BusinessOnboardingSession | null>;
  listOnboardings(context: AuthContext): Promise<BusinessOnboardingSession[]>;
  startOnboarding(context: AuthContext, scenario: OnboardingScenario, options?: { forceNew?: boolean }): Promise<BusinessOnboardingSession>;
  advanceOnboarding(context: AuthContext, sessionId: string, input: { value?: string; skip?: boolean; businessPatch?: Partial<BusinessInput> }): Promise<BusinessOnboardingSession>;
  setOnboardingStatus(context: AuthContext, sessionId: string, status: "active" | "paused"): Promise<BusinessOnboardingSession>;
  completeOnboarding(context: AuthContext, sessionId: string): Promise<BusinessOnboardingSession>;

  /**
   * C5a: company membership and invites — the `CodeMembershipStore` port from
   * `apps/agent-api/src/code-membership.ts`, mirrored verbatim so a `WorkspaceStore` can be injected into
   * `CodeMembershipService` without an adapter. These methods are company-scoped (not workspace/user
   * scoped) and deliberately take no `AuthContext`: membership **is** the authorisation anchor, and the
   * service has already resolved the acting principal and the company.
   *
   * Invariants every implementation must keep:
   * - No row means `null` — never a default role and never "owner by default".
   * - `getCompanyMembership` / `listCompanyMembers` return the **actual** stored role and status.
   * - `acceptCompanyInvite` re-reads the invite and refuses one that is expired or already accepted.
   * - `updateCompanyMemberRole` refuses a stale `expectedRevision` and any change that would leave the
   *   company without an active owner; `removeCompanyMember` refuses the same for the last active owner.
   */
  getCompanyMembership(companyId: string, userId: string): Promise<CompanyMember | null>;
  listCompanyMembers(companyId: string): Promise<CompanyMember[]>;
  /** Active owners only: a suspended owner cannot administer anything, so it cannot be the protection. */
  countCompanyOwners(companyId: string): Promise<number>;
  createCompanyInvite(input: CompanyInviteInput): Promise<CompanyInvite>;
  findCompanyInviteByTokenHash(tokenHash: string): Promise<CompanyInvite | null>;
  acceptCompanyInvite(input: AcceptCompanyInviteInput): Promise<CompanyMember>;
  updateCompanyMemberRole(input: UpdateCompanyMemberRoleInput): Promise<CompanyMember>;
  removeCompanyMember(input: RemoveCompanyMemberInput): Promise<void>;

  /**
   * C5b: ProviderDataPolicy storage — company-scoped, no `AuthContext`, mirroring the C5a convention:
   * the caller (an app-side service) has already resolved the principal and the company, and the policy
   * tables are the authorisation *subject*, not the authorisation check.
   *
   * Invariants every implementation must keep:
   * - a read with no row returns `null`: absence is never a permissive policy;
   * - `upsertProviderDataPolicy` bumps `policyVersion` (previous + 1, starting at 1), appends the full
   *   snapshot to the history table with the given `actor`, and refuses a mismatch against
   *   `expectedPolicyVersion` (`data_policy_revision_conflict`, 409) instead of merging;
   * - `upsertProviderDataPolicy` refuses a `requiredRedactions` list that omits secrets/tokens/keys, and an
   *   unknown kind/classification/training policy/retention/content type (`invalid_*`, 400);
   * - every method is scoped by `companyId`; a row of another company is never read, listed or written;
   * - `getHostedProviderConsent` returns the row whatever its state, and a row with `revokedAt` set counts
   *   as no consent for callers.
   */
  getProviderDataPolicy(input: {
    companyId: string | null;
    providerId: string;
    modelPattern: string | null;
  }): Promise<ProviderDataPolicyRecord | null>;
  listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]>;
  upsertProviderDataPolicy(input: UpsertProviderDataPolicyStoreInput): Promise<ProviderDataPolicyRecord>;
  listProviderDataPolicyVersions(
    companyId: string | null,
    providerId?: string,
  ): Promise<ProviderDataPolicyVersionRecord[]>;
  getProjectDataPolicy(companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null>;
  upsertProjectDataPolicy(input: UpsertProjectDataPolicyStoreInput): Promise<ProjectDataPolicyRecord>;
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

  /**
   * C6a: durable Coding Agent run state. Company-scoped like the C5a/C5b tables (the app-side
   * `CodeRunStateLog` has already resolved the principal), with one deliberate system-wide exception noted
   * below.
   *
   * Invariants every implementation must keep:
   * - `createCodeRunState` is idempotent by `runId`: a retried create returns the existing row rather than
   *   resetting its cursor or stealing its lease;
   * - `applyCodeRunStateEvent` is idempotent by `seq`: a write whose sequence is not greater than the stored
   *   `lastEventSeq` changes nothing and returns the stored row;
   * - a lease transition (`acquire`/`renew`/`release`) is applied in the same statement as the rest of the
   *   patch and is refused (row untouched) when another owner holds a live lease;
   * - `upsertCodeRunTurn` is idempotent by (`runId`, `turnIndex`): re-recording the same turn merges the
   *   given tool calls by `toolCallId` instead of duplicating them, and never downgrades a terminal outcome
   *   back to `unknown_outcome`;
   * - reads are scoped by `companyId`: a run of another company is never returned;
   * - `listStaleCodeRunStates` is the **only** system-wide read (the reconciler is a system process); every
   *   subsequent write in that flow is scoped by the `companyId` of the row it just read.
   */
  createCodeRunState(input: CreateCodeRunStateInput): Promise<CodeRunStateRecord>;
  applyCodeRunStateEvent(input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord>;
  getCodeRunState(companyId: string, runId: string): Promise<CodeRunStateRecord | null>;
  listStaleCodeRunStates(input: { now: Date; limit: number }): Promise<CodeRunStateRecord[]>;
  upsertCodeRunTurn(input: UpsertCodeRunTurnInput): Promise<CodeRunTurnRecord>;
  getCodeRunTurn(companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null>;
  listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]>;
  /**
   * C10: the run's **original request**, tenant-scoped like every other run read. `null` means the run row does
   * not exist for this company — never "the request was empty": a run whose request was never recorded answers
   * with a record whose `status` says so, so a resume can tell "we lost it" from "there was none".
   *
   * It is a separate read from `getCodeRunState` on purpose: the request is content, and the lease/status row is
   * read by the reaper's and the reconciler's scans, which have no business pulling prompt text into memory.
   */
  getCodeRunRequest(companyId: string, runId: string): Promise<CodeRunRequestRecord | null>;
  /**
   * Read-only keyset scans for the run reaper. Both are tenant-scoped (`companyId: null` is the documented
   * system scope) and bounded: they never return more than `limit` rows and hand back a cursor when more may
   * follow, so a reaper cannot pull an unbounded result set into memory on a busy deployment.
   */
  listCodeRunStatesForScan(input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>>;
  /**
   * C14 (owner decision 3): the tenant-scoped read of finished **and** running run rows that the metrics
   * aggregation is built from. It is a different question from the reaper's scan above (`status='running'` only)
   * and from `getCodeRunState` (one run by id), and it reads the same rows both already read — no column, table
   * or derived record is added, so there is still exactly one source of truth for a run's outcome and estimate.
   */
  listCodeRunStates(input: ListCodeRunStatesInput): Promise<CodeRunStateRecord[]>;
  /**
   * C10 (ТЗ item 7): enumerate the projects that own a code session, tenant-scoped by the same system-scope rule
   * the run scans use. The sandbox-retention sweep needs this to find a sandbox whose owning project is no longer
   * in the process's idle map — after a restart nothing else can name it.
   */
  listCodeProjectRefs(input: CodeProjectRefScanInput): Promise<CodeProjectRefScanPage>;
  /**
   * C10 (ТЗ item 7): read one of those projects **without** a user context. `getProject` is tenant-scoped by
   * `createdBy`, so the reaper's system identity cannot use it; this is the same system scope the run scans already
   * carry, and it returns the project row the caller could have addressed the sandbox by anyway.
   */
  getProjectForSystem(companyId: string, projectId: string): Promise<Project | null>;
  listCodeRunTurnsForScan(input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>>;

  // --- C6b: immutable execution snapshots and versioned configuration -------------------------------
  /**
   * Snapshots are append-only: `create` refuses to touch an existing row and there is no update or delete
   * method at all, so the only way to change what the system looked like is to record a new snapshot.
   */
  createExecutionSnapshot(input: CreateExecutionSnapshotInput): Promise<ExecutionSnapshotRecord>;
  getExecutionSnapshot(companyId: string, snapshotId: string): Promise<ExecutionSnapshotRecord | null>;
  /** The newest snapshot of a session, or `null` when the session predates C6b (`legacy_no_snapshot`). */
  getLatestSnapshotForSession(companyId: string, sessionId: string): Promise<ExecutionSnapshotRecord | null>;
  getSnapshotForRun(companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null>;
  listExecutionSnapshots(input: ListExecutionSnapshotsInput): Promise<ExecutionSnapshotRecord[]>;
  /** Structural diff of two snapshots, metadata only. Never returns values from the payload verbatim. */
  diffExecutionSnapshots(a: ExecutionSnapshotRecord, b: ExecutionSnapshotRecord): ExecutionSnapshotDiff;
  /** Config versions are immutable: identical content returns the existing version instead of a new one. */
  createSnapshotConfigVersion(input: CreateSnapshotConfigVersionInput): Promise<SnapshotConfigVersionRecord>;
  getSnapshotConfigVersion(companyId: string, kind: SnapshotConfigKind, version: number): Promise<SnapshotConfigVersionRecord | null>;
  findSnapshotConfigVersionByHash(companyId: string, kind: SnapshotConfigKind, contentHash: string): Promise<SnapshotConfigVersionRecord | null>;
  listSnapshotConfigVersions(companyId: string, kind: SnapshotConfigKind): Promise<SnapshotConfigVersionRecord[]>;

  // --- C6b: durable Activity events referencing their snapshot ---------------------------------------
  /**
   * Append-only: there is no update or delete method for activity events. `snapshotId` is optional because
   * events from before C6b (or from a path outside any run) have no snapshot, and storing a fabricated id
   * would be worse than storing none.
   */
  createCodeActivityEvent(input: CreateCodeActivityEventInput): Promise<CodeActivityEventRecord>;
  /** Newest first. Tenant-scoped; filters by session, run or snapshot when given. */
  listCodeActivityEvents(input: ListCodeActivityEventsInput): Promise<CodeActivityEventRecord[]>;

  // --- C8: durable context summaries --------------------------------------------------------------------
  /**
   * Append-only: there is no update or delete method, and migration 079 refuses both at the database level.
   * A summary that could be rewritten would misrepresent what the model was actually given during the run it
   * describes. `contentHash` is the hash of the exact compacted message list, which is what ties the stored
   * artifact to reproducible replay input (C6b).
   */
  createCodeContextSummary(input: CreateCodeContextSummaryInput): Promise<CodeContextSummaryRecord>;
  /** Newest first, tenant-scoped; filters by session or run when given. */
  listCodeContextSummaries(input: ListCodeContextSummariesInput): Promise<CodeContextSummaryRecord[]>;

  // --- C9: goals, plan revisions and session todos ------------------------------------------------------
  /**
   * Creates a goal together with its acceptance criteria as separate rows. A goal with no criteria is
   * refused: completion is defined as "every criterion verified", so a goal without criteria could never be
   * completed honestly.
   */
  createCodeGoal(input: CreateCodeGoalInput): Promise<CodeGoalWithCriteria>;
  getCodeGoal(companyId: string, goalId: string): Promise<CodeGoalWithCriteria | null>;
  /** Newest first, tenant-scoped. */
  listCodeGoals(input: { companyId: string; sessionId?: string; projectId?: string; limit?: number }): Promise<CodeGoalRecord[]>;
  /**
   * Optimistic update by `expectedRevision`. Transitioning to `completed` is refused with
   * `CodeGoalAcceptanceUnverifiedError` unless every acceptance criterion is verified — the service refuses
   * first so callers get a structured reason, and migration 080 enforces the same rule in the database.
   */
  updateCodeGoal(input: UpdateCodeGoalInput): Promise<CodeGoalWithCriteria>;
  setCodeGoalCriterionStatus(input: SetCodeGoalCriterionStatusInput): Promise<CodeGoalWithCriteria>;
  /** Creates the next revision of the session plan (revisions are never edited in place). */
  createCodeSessionPlan(input: CreateCodeSessionPlanInput): Promise<CodeSessionPlanRecord>;
  getLatestCodeSessionPlan(companyId: string, sessionId: string): Promise<CodeSessionPlanRecord | null>;
  listCodeSessionPlans(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionPlanRecord[]>;
  /**
   * Approves or rejects the current revision. `executionMode` is taken from the caller, never from the plan
   * body: a plan is model-produced data and must not choose the mode it runs in.
   */
  decideCodeSessionPlan(input: DecideCodeSessionPlanInput): Promise<CodeSessionPlanRecord>;
  /**
   * Replaces the whole todo list of a session. Replace semantics make the tool idempotent by construction: the
   * same call replayed produces the same list instead of appending duplicates. More than one `in_progress` is
   * refused with `CodeSessionTodosInvalidError` (a partial unique index enforces it in the database too).
   */
  replaceCodeSessionTodos(input: ReplaceCodeSessionTodosInput): Promise<CodeSessionTodoRecord[]>;
  listCodeSessionTodos(input: { companyId: string; sessionId: string }): Promise<CodeSessionTodoRecord[]>;

  // --- C9: `code.ask_user` — the question a run waits on ------------------------------------------------
  /**
   * Creates the question, or returns the one the same tool call already asked. Idempotent by
   * `(companyId, runId, toolCallId)`: repeating the call must not produce a second question the user would have
   * to answer twice, which is also what makes the pause safe to observe after a restart.
   */
  createCodeUserQuestion(input: CreateCodeUserQuestionInput): Promise<CodeUserQuestionRecord>;
  /** Tenant-scoped: a question of another company is not found, and looks exactly like a question that never existed. */
  getCodeUserQuestion(companyId: string, questionId: string): Promise<CodeUserQuestionRecord | null>;
  /** The oldest still-pending question of a run — what a resumed run (or the UI) looks for first. */
  getPendingCodeUserQuestionForRun(companyId: string, runId: string): Promise<CodeUserQuestionRecord | null>;
  /**
   * Records the user's decision. A repeat of the *same* answer by the *same* user is an idempotent no-op, so a
   * retrying client cannot resume a run twice; a different answer, a stale revision or an expired question is
   * refused. The answer is never guessed: there is no default, and expiry never fills one in.
   */
  answerCodeUserQuestion(input: AnswerCodeUserQuestionInput): Promise<CodeUserQuestionRecord>;
  /** Moves pending questions past their TTL to `expired`; returns how many moved. Nothing is auto-answered. */
  expireCodeUserQuestions(input?: { now?: Date; companyId?: string; runId?: string }): Promise<number>;
  /**
   * The pending questions a given instant has already outlived, so the reaper can report what it would expire
   * (dry run) and release each held run with `ask_user_timeout`. Read-only: it changes no state, and the run each
   * question is holding comes back with it because expiring a question without releasing its run would leave a
   * run waiting on a question nobody can answer any more.
   */
  listExpiredCodeUserQuestions(input?: { now?: Date; limit?: number }): Promise<CodeUserQuestionRecord[]>;
  /** Cancels the pending questions of a run (a stopped or cancelled run can no longer be answered). */
  cancelPendingCodeUserQuestions(input: { companyId: string; runId: string; now?: Date }): Promise<number>;

  // --- C6b: versioned replay bundles -------------------------------------------------------------------
  /**
   * Writes a bundle header together with its ordered steps. Both tables are append-only, so there is no
   * update or delete method. Idempotent by `(runId, bundleVersion)`: recording the same run twice returns the
   * stored bundle instead of appending a second one.
   */
  createReplayBundle(input: CreateReplayBundleInput): Promise<ReplayBundleRecord>;
  /** The bundle of a run; without `bundleVersion` the newest one is returned. */
  getReplayBundle(companyId: string, runId: string, bundleVersion?: number): Promise<ReplayBundleRecord | null>;
  /**
   * The same bundle addressed by its own id, which is what a replay status endpoint and the UI hold.
   * Tenant-scoped: a bundle of another company is simply not found.
   */
  getReplayBundleById(companyId: string, bundleId: string): Promise<ReplayBundleRecord | null>;
  /** Newest first, tenant-scoped. */
  listReplayBundles(input: ListReplayBundlesInput): Promise<ReplayBundleRecord[]>;
  /** Steps in the recorded (executed) order. */
  listReplayBundleSteps(companyId: string, bundleId: string): Promise<ReplayBundleStepRecord[]>;

  // --- C10: session durability (the conversation cursor, the recovery notice, the operation ledgers) -----
  /**
   * The conversation cursor of a session, or `null` when the session has never been re-pointed. Every reader of
   * a transcript applies it: turns after `turnIndex` are outside the conversation. Rewinding is a pointer move
   * because the replay bundle and the context summaries are append-only (078, 079) — deleting them would be
   * deleting the evidence of what the model was shown.
   */
  getCodeSessionHead(companyId: string, sessionId: string): Promise<CodeSessionHeadRecord | null>;
  /**
   * Moves (or creates) the cursor. Optimistic by `expectedRevision` (0 means "no head yet"), so two concurrent
   * rewinds cannot silently overwrite one another.
   */
  setCodeSessionHead(input: SetCodeSessionHeadInput): Promise<CodeSessionHeadRecord>;
  /** Append-only: a notice describes a moment, so it is never rewritten (migration 082 refuses both). */
  createCodeRunRecoveryNotice(input: CreateCodeRunRecoveryNoticeInput): Promise<CodeRunRecoveryNoticeRecord>;
  /** The newest notice of a run, which is what a resume hands to the model. Tenant-scoped. */
  getLatestCodeRunRecoveryNotice(companyId: string, runId: string): Promise<CodeRunRecoveryNoticeRecord | null>;
  /** Newest first, tenant-scoped. */
  listCodeRunRecoveryNotices(input: { companyId: string; runId: string; limit?: number }): Promise<CodeRunRecoveryNoticeRecord[]>;
  /**
   * Claims a rewind operation. Idempotent by `(companyId, operationId)`: a repeated call returns the stored
   * operation instead of performing a second rollback, and a call that arrives while the first is still pending
   * is refused (`CodeSessionOperationInProgressError`) rather than duplicated.
   */
  createCodeSessionRewind(input: CreateCodeSessionRewindInput): Promise<{ record: CodeSessionRewindRecord; replayed: boolean }>;
  getCodeSessionRewind(companyId: string, operationId: string): Promise<CodeSessionRewindRecord | null>;
  /**
   * Reopens a claim that provably changed nothing (a `failed` operation with no effect, or a `pending` claim older
   * than `staleMs`), so a retry after a crash can perform the operation. An operation that created a checkpoint or
   * moved the cursor is never reopened — that is what keeps a retry from creating a second safety checkpoint.
   */
  reopenCodeSessionRewind(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionRewindRecord | null; reopened: boolean }>;
  /** Stamps the outcome. Only a `pending` operation can be completed, so a retry cannot rewrite a result. */
  completeCodeSessionRewind(input: CompleteCodeSessionRewindInput): Promise<CodeSessionRewindRecord>;
  listCodeSessionRewinds(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionRewindRecord[]>;
  /** The same claim protocol as the rewind ledger, for the same reason: `createCodeSession` is not idempotent. */
  createCodeSessionFork(input: CreateCodeSessionForkInput): Promise<{ record: CodeSessionForkRecord; replayed: boolean }>;
  getCodeSessionFork(companyId: string, operationId: string): Promise<CodeSessionForkRecord | null>;
  completeCodeSessionFork(input: CompleteCodeSessionForkInput): Promise<CodeSessionForkRecord>;
  /** Newest first: the branches that were forked from a session. */
  listCodeSessionForks(input: { companyId: string; parentSessionId: string; limit?: number }): Promise<CodeSessionForkRecord[]>;
  /**
   * Reopens a fork claim that provably created no session, so a retry can perform the fork. A claim that already
   * minted a session is never reopened — that is what keeps a retry from creating a second session.
   */
  reopenCodeSessionFork(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionForkRecord | null; reopened: boolean }>;
}

