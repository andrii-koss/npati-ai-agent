import * as support from "./postgres-store-support";
import * as research from "./conversation-research-evidence";
import * as company from "./postgres-company-repositories";
import * as project from "./postgres-workspace-repositories";
import * as policy from "./postgres-policy-repositories";
import * as replay from "./postgres-replay-repositories";
import * as governance from "./postgres-governance-repositories";
import * as onboarding from "./postgres-onboarding-repositories";
import * as collab from "./postgres-collaboration-repositories";
import { listGoalPage } from "./postgres-goal-repositories";
import { listMemoryPage } from "./postgres-memory-page";
import { readContentLibrary } from "./content-library-read";
import type { MemoryPageQuery } from "./memory-page";
import type { GoalPageQuery } from "./goals-page";
import { readNeutralMessagePage, readChatSidebarPage } from "./postgres-chat-pages";
import { PostgresSessionRepositories } from "./postgres-session-repositories";
import type {
  AnswerCodeUserQuestionInput,
  CodeGoalRecord,
  CodeGoalWithCriteria,
  CodeRunRecoveryNoticeRecord,
  CodeSessionForkRecord,
  CodeSessionHeadRecord,
  CodeSessionPlanRecord,
  CodeSessionRewindRecord,
  CodeSessionTodoRecord,
  CodeUserQuestionRecord,
  CompleteCodeSessionForkInput,
  CompleteCodeSessionRewindInput,
  CreateCodeGoalInput,
  CreateCodeRunRecoveryNoticeInput,
  CreateCodeSessionForkInput,
  CreateCodeSessionPlanInput,
  CreateCodeSessionRewindInput,
  CreateCodeUserQuestionInput,
  DecideCodeSessionPlanInput,
  ReplaceCodeSessionTodosInput,
  SetCodeGoalCriterionStatusInput,
  SetCodeSessionHeadInput,
  UpdateCodeGoalInput,
} from "./types.js";

import * as projectMutations from "./postgres-project-mutations";
import * as agentRepos from "./postgres-agent-repositories";
import * as codeRuns from "./postgres-code-run-repositories";
import { createPostgresDataLifecycleStore } from "./postgres-data-lifecycle-repository";
import { runPostgresMigrationsEarly } from "./postgres-store-migrations-early";
import { runPostgresMigrationsLatePart1, runPostgresMigration083, runPostgresMigration085, runPostgresMigrationsPost086 } from "./postgres-store-migrations-late";
import { PostgresCodeInboxStore } from "./code-session-inbox-postgres";
import { PostgresCodeProcessStore } from "./code-process-store-postgres";
import { Pool } from "pg";
import type { AuthContext, ConversationResearchInput, Business, BusinessInput, BusinessOnboardingSession, BusinessToCompanyInput, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentInput, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, CompanyInput, Project, ProjectCheckpoint, CreateCheckpointInput, ProjectDeployment, CreateDeploymentInput, ProjectQaReport, CreateProjectQaReportInput, ProjectInput, ProjectStatus, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview, WorkspaceStore, CodeSession, CodeSessionInput, CodeSessionMode, CodeSessionStatus, ProjectCodeSettings, ProjectCodeTrust, ProjectCodeTrustInput, ProjectMountedFolder, ProjectMountedFolderInput, DataClassification, RetentionClass, AuditEntry, AuditEntryInput, AuditAnchor, AuditChainState, AuditChainVerification, FeatureFlag, FeatureFlagInput, FeatureFlagHistoryEntry, CodeToolManifest, SandboxImage, SandboxImageInput, SandboxImageVariant, CodeApprovalRule, CodeApprovalRuleInput, CodeApprovalRuleScope,
  CompanyMember, CompanyInvite, CompanyInviteInput, AcceptCompanyInviteInput, UpdateCompanyMemberRoleInput, RemoveCompanyMemberInput, CompanyRole,
  ProviderDataPolicyRecord, UpsertProviderDataPolicyStoreInput, ProviderDataPolicyVersionRecord, ProjectDataPolicyRecord,
  UpsertProjectDataPolicyStoreInput, ProjectDataPolicyPathRule, ProviderHostedConsentRecord,
  CodeRunStateRecord, CodeRunTurnRecord, CodeRunTurnStatus, CreateCodeRunStateInput, ApplyCodeRunStateEventInput,
  UpsertCodeRunTurnInput, CodeRunStateScanInput, CodeRunTurnScanInput, CodeRunScanPage,
  ListCodeRunStatesInput,
  CodeRunRequestRecord,
  CodeProjectRefScanInput, CodeProjectRefScanPage,
  CreateExecutionSnapshotInput, ExecutionSnapshotRecord, ExecutionSnapshotTrigger, ExecutionSnapshotDiff,
  ListExecutionSnapshotsInput, SnapshotConfigKind, SnapshotConfigVersionRecord,
  CreateSnapshotConfigVersionInput, CodeActivityEventKind, CodeActivityEventRecord,
  CreateCodeActivityEventInput, ListCodeActivityEventsInput, ReplayBundleRecord, ReplayBundleStepRecord,
  ReplayMode, ReplayStepKind, CreateReplayBundleInput, ListReplayBundlesInput,
  CodeContextSummaryRecord, CreateCodeContextSummaryInput, ListCodeContextSummariesInput,
  CodeRetentionWindows, CodeDataRetentionReport, CodeDataErasureReport, CodeDataErasureTarget,
  CodeDataErasureOutcome, CodeDataFamilyOutcome, CodeDataLifecycleStore } from "./types";
import type { StoredUserSetting } from "./postgres-store-schema";

export class PostgresWorkspaceStore implements WorkspaceStore {
  private codeProcessesInstance?: PostgresCodeProcessStore;
  get codeProcesses(): PostgresCodeProcessStore { return this.codeProcessesInstance ??= new PostgresCodeProcessStore(this.pool); }
  private codeInboxInstance?: PostgresCodeInboxStore;
  get codeInbox(): PostgresCodeInboxStore { return this.codeInboxInstance ??= new PostgresCodeInboxStore(this.pool); }
  private readonly pool: Pool;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 10 }); }

  async close(): Promise<void> { await this.pool.end(); }

  async initialize(context?: AuthContext) {
    await runPostgresMigrationsEarly(this.pool);
    await runPostgresMigrationsLatePart1(this.pool, context);

    const sessionDurabilityMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='082_code_session_durability'");
    if (!sessionDurabilityMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration082 } = await import("./migration-082");
        await runMigration082(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('082_code_session_durability')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    await runPostgresMigration083(this.pool);

    const activityParentMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='084_code_activity_parents'");
    if (!activityParentMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration084 } = await import("./migration-084");
        await runMigration084(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('084_code_activity_parents')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    await runPostgresMigration085(this.pool);

    const mountedFolderMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='086_project_mounted_folders'");
    if (!mountedFolderMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration086 } = await import("./migration-086");
        await runMigration086(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('086_project_mounted_folders')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    await runPostgresMigrationsPost086(this.pool);
  }

  private sessionRepoInstance?: PostgresSessionRepositories;
  private sessions(): PostgresSessionRepositories { return this.sessionRepoInstance ??= new PostgresSessionRepositories(this.pool); }
  async createCodeUserQuestion(input: CreateCodeUserQuestionInput): Promise<CodeUserQuestionRecord> { return this.sessions().createCodeUserQuestion(input); }
  async getCodeUserQuestion(companyId: string, questionId: string): Promise<CodeUserQuestionRecord | null> { return this.sessions().getCodeUserQuestion(companyId, questionId); }
  async getPendingCodeUserQuestionForRun(companyId: string, runId: string): Promise<CodeUserQuestionRecord | null> { return this.sessions().getPendingCodeUserQuestionForRun(companyId, runId); }
  async answerCodeUserQuestion(input: AnswerCodeUserQuestionInput): Promise<CodeUserQuestionRecord> { return this.sessions().answerCodeUserQuestion(input); }
  async expireCodeUserQuestions(input: { now?: Date; companyId?: string; runId?: string } = {}): Promise<number> { return this.sessions().expireCodeUserQuestions(input); }
  async listExpiredCodeUserQuestions(input: { now?: Date; limit?: number } = {}): Promise<CodeUserQuestionRecord[]> { return this.sessions().listExpiredCodeUserQuestions(input); }
  async cancelPendingCodeUserQuestions(input: { companyId: string; runId: string; now?: Date }): Promise<number> { return this.sessions().cancelPendingCodeUserQuestions(input); }
  async getCodeSessionHead(companyId: string, sessionId: string): Promise<CodeSessionHeadRecord | null> { return this.sessions().getCodeSessionHead(companyId, sessionId); }
  async setCodeSessionHead(input: SetCodeSessionHeadInput): Promise<CodeSessionHeadRecord> { return this.sessions().setCodeSessionHead(input); }
  async createCodeRunRecoveryNotice(input: CreateCodeRunRecoveryNoticeInput): Promise<CodeRunRecoveryNoticeRecord> { return this.sessions().createCodeRunRecoveryNotice(input); }
  async getLatestCodeRunRecoveryNotice(companyId: string, runId: string): Promise<CodeRunRecoveryNoticeRecord | null> { return this.sessions().getLatestCodeRunRecoveryNotice(companyId, runId); }
  async listCodeRunRecoveryNotices(input: { companyId: string; runId: string; limit?: number }): Promise<CodeRunRecoveryNoticeRecord[]> { return this.sessions().listCodeRunRecoveryNotices(input); }
  async createCodeSessionRewind(input: CreateCodeSessionRewindInput): Promise<{ record: CodeSessionRewindRecord; replayed: boolean }> {
    return this.sessions().createCodeSessionRewind(input);
  }

  async getCodeSessionRewind(companyId: string, operationId: string): Promise<CodeSessionRewindRecord | null> { return this.sessions().getCodeSessionRewind(companyId, operationId); }
  async reopenCodeSessionRewind(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionRewindRecord | null; reopened: boolean }> {
    return this.sessions().reopenCodeSessionRewind(input);
  }

  async completeCodeSessionRewind(input: CompleteCodeSessionRewindInput): Promise<CodeSessionRewindRecord> { return this.sessions().completeCodeSessionRewind(input); }
  async listCodeSessionRewinds(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionRewindRecord[]> { return this.sessions().listCodeSessionRewinds(input); }
  async createCodeSessionFork(input: CreateCodeSessionForkInput): Promise<{ record: CodeSessionForkRecord; replayed: boolean }> {
    return this.sessions().createCodeSessionFork(input);
  }

  async getCodeSessionFork(companyId: string, operationId: string): Promise<CodeSessionForkRecord | null> { return this.sessions().getCodeSessionFork(companyId, operationId); }
  async completeCodeSessionFork(input: CompleteCodeSessionForkInput): Promise<CodeSessionForkRecord> { return this.sessions().completeCodeSessionFork(input); }
  async listCodeSessionForks(input: { companyId: string; parentSessionId: string; limit?: number }): Promise<CodeSessionForkRecord[]> { return this.sessions().listCodeSessionForks(input); }
  async reopenCodeSessionFork(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionForkRecord | null; reopened: boolean }> {
    return this.sessions().reopenCodeSessionFork(input);
  }

  async createCodeGoal(input: CreateCodeGoalInput): Promise<CodeGoalWithCriteria> { return this.sessions().createCodeGoal(input); }
  async getCodeGoal(companyId: string, goalId: string): Promise<CodeGoalWithCriteria | null> { return this.sessions().getCodeGoal(companyId, goalId); }
  async listCodeGoals(input: { companyId: string; sessionId?: string; projectId?: string; limit?: number }): Promise<CodeGoalRecord[]> { return this.sessions().listCodeGoals(input); }
  async updateCodeGoal(input: UpdateCodeGoalInput): Promise<CodeGoalWithCriteria> { return this.sessions().updateCodeGoal(input); }
  async setCodeGoalCriterionStatus(input: SetCodeGoalCriterionStatusInput): Promise<CodeGoalWithCriteria> { return this.sessions().setCodeGoalCriterionStatus(input); }
  async createCodeSessionPlan(input: CreateCodeSessionPlanInput): Promise<CodeSessionPlanRecord> { return this.sessions().createCodeSessionPlan(input); }
  async getLatestCodeSessionPlan(companyId: string, sessionId: string): Promise<CodeSessionPlanRecord | null> { return this.sessions().getLatestCodeSessionPlan(companyId, sessionId); }
  async listCodeSessionPlans(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionPlanRecord[]> { return this.sessions().listCodeSessionPlans(input); }
  async decideCodeSessionPlan(input: DecideCodeSessionPlanInput): Promise<CodeSessionPlanRecord> { return this.sessions().decideCodeSessionPlan(input); }
  async replaceCodeSessionTodos(input: ReplaceCodeSessionTodosInput): Promise<CodeSessionTodoRecord[]> { return this.sessions().replaceCodeSessionTodos(input); }
  async listCodeSessionTodos(input: { companyId: string; sessionId: string }): Promise<CodeSessionTodoRecord[]> { return this.sessions().listCodeSessionTodos(input); }
  async listSandboxImages(context: AuthContext): Promise<SandboxImage[]> { return governance.listSandboxImages(this.pool, context); }
  async getSandboxImage(context: AuthContext, reference: string): Promise<SandboxImage | null> { return governance.getSandboxImage(this.pool, context, reference); }
  async upsertSandboxImage(context: AuthContext, input: SandboxImageInput): Promise<SandboxImage> { return governance.upsertSandboxImage(this.pool, context, input); }
  async revokeSandboxImage(context: AuthContext, reference: string, input: { actor: string; reason: string }): Promise<SandboxImage> { return governance.revokeSandboxImage(this.pool, context, reference, input); }
  async latestVerifiedSandboxImage(context: AuthContext, variant: SandboxImageVariant): Promise<SandboxImage | null> { return governance.latestVerifiedSandboxImage(this.pool, context, variant); }
  async listFeatureFlags(context: AuthContext): Promise<FeatureFlag[]> { return governance.listFeatureFlags(this.pool, context); }
  async setFeatureFlag(context: AuthContext, input: FeatureFlagInput): Promise<FeatureFlag> { return governance.setFeatureFlag(this.pool, context, input); }
  async listFeatureFlagHistory(context: AuthContext, flagKey?: string, limit = 100): Promise<FeatureFlagHistoryEntry[]> { return governance.listFeatureFlagHistory(this.pool, context, flagKey, limit); }
  async publishCodeToolManifest(context: AuthContext, manifest: { version: number; tools: CodeToolManifest["tools"]; checksum: string }): Promise<CodeToolManifest> { return governance.publishCodeToolManifest(this.pool, context, manifest); }
  async latestCodeToolManifest(context: AuthContext): Promise<CodeToolManifest | null> { return governance.latestCodeToolManifest(this.pool, context); }
  async appendAuditEntry(context: AuthContext, companyId: string, input: AuditEntryInput): Promise<AuditEntry> { return company.appendAuditEntry(this.pool, context, companyId, input); }
  async listAuditEntries(context: AuthContext, companyId: string, filters: { actor?: string; requestId?: string; correlationId?: string; action?: string; limit?: number; fromSequence?: number } = {}): Promise<AuditEntry[]> { return company.listAuditEntries(this.pool, context, companyId, filters); }
  async createCodeApprovalRule(context: AuthContext, companyId: string, input: CodeApprovalRuleInput): Promise<CodeApprovalRule> { return governance.createCodeApprovalRule(this.pool, context, companyId, input); }
  async listCodeApprovalRules(context: AuthContext, companyId: string, filters: { projectId?: string; sessionId?: string; scope?: CodeApprovalRuleScope } = {}): Promise<CodeApprovalRule[]> { return governance.listCodeApprovalRules(this.pool, context, companyId, filters); }
  async deleteCodeApprovalRule(context: AuthContext, companyId: string, ruleId: string): Promise<void> { return governance.deleteCodeApprovalRule(this.pool, context, companyId, ruleId); }
  async findMatchingCodeApprovalRule(context: AuthContext, query: { companyId: string; projectId?: string | null; sessionId?: string | null; action: string }): Promise<CodeApprovalRule | null> { return governance.findMatchingCodeApprovalRule(this.pool, context, query); }
  async verifyAuditChain(context: AuthContext, companyId: string, range: { fromSequence?: number; toSequence?: number } = {}): Promise<AuditChainVerification> { return company.verifyAuditChain(this.pool, context, companyId, range); }
  async auditChainState(context: AuthContext, companyId: string): Promise<AuditChainState> { return company.auditChainState(this.pool, context, companyId); }
  async recordAuditAnchor(context: AuthContext, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor> { return governance.recordAuditAnchor(this.pool, context, companyId, anchor); }
  async listAuditAnchors(context: AuthContext, companyId: string, limit = 90): Promise<AuditAnchor[]> { return company.listAuditAnchors(this.pool, context, companyId, limit); }
  async latestAuditAnchor(context: AuthContext, companyId: string): Promise<AuditAnchor | null> {
    const anchors = await this.listAuditAnchors(context, companyId, 1);
    return anchors[0] ?? null;
  }

  async auditCompanies(context: AuthContext): Promise<string[]> { return company.auditCompanies(this.pool, context); }
  async systemAuditChains(workspaceId: string) { return company.systemAuditChains(this.pool, workspaceId); }
  async systemRecordAuditAnchor(workspaceId: string, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor> { return governance.systemRecordAuditAnchor(this.pool, workspaceId, companyId, anchor); }
  async health() {
    try { await this.pool.query("SELECT 1"); return "ok" as const; }
    catch { return "unavailable" as const; }
  }

  async getUserSetting(context: AuthContext, key: string): Promise<StoredUserSetting | null> { return collab.getUserSetting(this.pool, context, key); }
  async readContentLibrary(context: AuthContext, settingsKey: string) { return readContentLibrary(this.pool, context, settingsKey); }
  async setUserSetting(context: AuthContext, key: string, value: unknown, expectedRevision: number): Promise<StoredUserSetting | null> { return collab.setUserSetting(this.pool, context, key, value, expectedRevision); }
  private async ensureIdentity(context: AuthContext) { await support.ensureIdentity(this.pool, context); }
  private async assertMember(context: AuthContext) { return support.assertMember(this.pool, context); }
  async getBusiness(context: AuthContext, businessId: string) { return support.getBusiness(this.pool, context, businessId); }
  async getUserBusiness(context: AuthContext, businessId: string) { return project.getUserBusiness(this.pool, context, businessId); }
  async listBusinesses(context: AuthContext) { return project.listBusinesses(this.pool, context); }
  async listUserBusinesses(context: AuthContext) { return project.listUserBusinesses(this.pool, context); }
  async listBusinessesPage(context: AuthContext, requestedLimit = 20, cursor?: string) { return project.listBusinessesPage(this.pool, context, requestedLimit, cursor); }
  async overview(context: AuthContext): Promise<WorkspaceOverview> { return collab.overview(this.pool, context); }
  async setCurrentBusiness(context: AuthContext, businessId: string) { return project.setCurrentBusiness(this.pool, context, businessId); }
  async createBusiness(context: AuthContext, input: BusinessInput, idempotencyKey?: string) { return project.createBusiness(this.pool, context, input, idempotencyKey); }
  async updateBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>) { return project.updateBusiness(this.pool, context, businessId, input); }
  async updateUserBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>) { return project.updateUserBusiness(this.pool, context, businessId, input); }
  async deleteBusiness(context: AuthContext, businessId: string) { return project.deleteBusiness(this.pool, context, businessId); }
  private async assertCompany(context: AuthContext, companyId: string) { return support.assertCompany(this.pool, context, companyId); }
  async listCompanies(context: AuthContext, requestedLimit = 20, cursor?: string) { return company.listCompanies(this.pool, context, requestedLimit, cursor); }
  async getCompany(context: AuthContext, companyId: string) { return company.getCompany(this.pool, context, companyId); }
  async createCompany(context: AuthContext, input: CompanyInput, idempotencyKey: string) { return company.createCompany(this.pool, context, input, idempotencyKey); }
  async convertBusinessToCompany(context: AuthContext, businessId: string, input: BusinessToCompanyInput, idempotencyKey: string): Promise<{ company: Company; created: boolean }> {
    return company.convertBusinessToCompany(this.pool, context, businessId, input, idempotencyKey);
  }

  async updateCompany(context: AuthContext, companyId: string, input: Partial<CompanyInput>, expectedRevision: number) { return company.updateCompany(this.pool, context, companyId, input, expectedRevision); }
  async deleteCompany(context: AuthContext, companyId: string) { return company.deleteCompany(this.pool, context, companyId); }
  async setCompanyMainAgent(context: AuthContext, companyId: string, agentId: string | null, expectedRevision: number) { return company.setCompanyMainAgent(this.pool, context, companyId, agentId, expectedRevision); }
  async listCompanyAgents(context: AuthContext, companyId: string) { return company.listCompanyAgents(this.pool, context, companyId); }
  async listCompanyAgentsPage(context: AuthContext, companyId: string, requestedLimit = 50, cursor?: string) { return company.listCompanyAgentsPage(this.pool, context, companyId, requestedLimit, cursor); }
  async createProject(context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string) { return project.createProject(this.pool, context, companyId, input, idempotencyKey); }
  async listProjects(context: AuthContext, companyId: string, includeArchived = false) { return project.listProjects(this.pool, context, companyId, includeArchived); }
  async listProjectCatalog(context: AuthContext, input: import("./project-catalog").ProjectCatalogInput) {
    return (await import("./postgres-project-catalog")).listProjectCatalog(this.pool, context, input);
  }
  async findProjectByDomain(domain: string) {
    return (await import("./postgres-project-catalog")).findProjectByDomain(this.pool, domain);
  }
  async getProject(context: AuthContext, companyId: string, projectId: string) { return support.getProject(this.pool, context, companyId, projectId); }
  async updateProject(context: AuthContext, companyId: string, projectId: string, input: { name?: string; expectedRevision: number; code?: ProjectCodeSettings }) { return project.updateProject(this.pool, context, companyId, projectId, input); }
  async setProjectSandbox(context: AuthContext, companyId: string, projectId: string, sandboxId: string | null, expectedSandboxId: string | null) { return project.setProjectSandbox(this.pool, context, companyId, projectId, sandboxId, expectedSandboxId); }
  async updateProjectRepository(context: AuthContext, companyId: string, projectId: string, input: { provider: string; url: string; branch: string }): Promise<Project> { return projectMutations.updateProjectRepository(this.pool, context, companyId, projectId, input); }
  async updateProjectPreview(context: AuthContext, companyId: string, projectId: string, patch: { status?: ProjectStatus; previewUrl?: string | null; previewPort?: number | null; framework?: string | null; runtime?: string | null; lastBuildStatus?: string | null; deploymentUrl?: string | null; deploymentStatus?: string | null; lastDeploymentStatus?: string | null; lastDeployedAt?: string | null }) { return projectMutations.updateProjectPreview(this.pool, context, companyId, projectId, patch); }
  async archiveProject(context: AuthContext, companyId: string, projectId: string, expectedRevision: number) { return project.archiveProject(this.pool, context, companyId, projectId, expectedRevision); }
  async deleteProject(context: AuthContext, companyId: string, projectId: string) { return project.deleteProject(this.pool, context, companyId, projectId); }
  async softDeleteProject(context: AuthContext, companyId: string, projectId: string, reason?: string, purgeAfter?: string) { return project.softDeleteProject(this.pool, context, companyId, projectId, reason, purgeAfter); }
  async restoreProject(context: AuthContext, companyId: string, projectId: string) { return project.restoreProject(this.pool, context, companyId, projectId); }
  async transitionProjectToPurging(context: AuthContext, companyId: string, projectId: string) { return project.transitionProjectToPurging(this.pool, context, companyId, projectId); }
  async recordProjectLifecycleRecord(record: { workspaceId: string; companyId: string; projectId: string; operation: "soft_delete" | "restore" | "hard_purge"; status: "pending" | "in_progress" | "completed" | "failed"; details?: Record<string, unknown>; lastError?: string }) { return project.recordProjectLifecycleRecord(this.pool, record); }
  async listExpiredSoftDeletedProjects(limit?: number) { return project.listExpiredSoftDeletedProjects(this.pool, limit); }
  async createCodeSession(context: AuthContext, companyId: string, projectId: string, input: CodeSessionInput): Promise<CodeSession> { return project.createCodeSession(this.pool, context, companyId, projectId, input); }
  async getCodeSession(context: AuthContext, companyId: string, sessionId: string): Promise<CodeSession> { return project.getCodeSession(this.pool, context, companyId, sessionId); }
  async listCodeSessions(context: AuthContext, companyId: string, projectId?: string, options: { includeArchived?: boolean; limit?: number } = {}): Promise<CodeSession[]> { return project.listCodeSessions(this.pool, context, companyId, projectId, options); }
  async updateCodeSession(context: AuthContext, companyId: string, sessionId: string, patch: { status?: CodeSessionStatus; summary?: string; runId?: string | null; modelProfile?: string; dataClassification?: DataClassification; retentionClass?: RetentionClass; toolManifestVersion?: number | null; mode?: CodeSessionMode; expectedRevision?: number }): Promise<CodeSession> { return project.updateCodeSession(this.pool, context, companyId, sessionId, patch); }
  async getProjectCodeTrust(context: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null> { return project.getProjectCodeTrust(this.pool, context, companyId, projectId); }
  async setProjectCodeTrust(context: AuthContext, companyId: string, projectId: string, input: ProjectCodeTrustInput): Promise<ProjectCodeTrust> { return projectMutations.setProjectCodeTrust(this.pool, context, companyId, projectId, input); }
  async getProjectMountedFolder(context: AuthContext, companyId: string, projectId: string): Promise<ProjectMountedFolder | null> { return project.getProjectMountedFolder(this.pool, context, companyId, projectId); }
  async getProjectMountedFolderForSystem(companyId: string, projectId: string): Promise<ProjectMountedFolder | null> { return project.getProjectMountedFolderForSystem(this.pool, companyId, projectId); }
  async setProjectMountedFolder(context: AuthContext, companyId: string, projectId: string, input: ProjectMountedFolderInput): Promise<ProjectMountedFolder> { return projectMutations.setProjectMountedFolder(this.pool, context, companyId, projectId, input); }
  private async assertProjectAgent(context: AuthContext, companyId: string, agentId?: string) { return company.assertProjectAgent(this.pool, context, companyId, agentId); }
  async createProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, input: CreateCheckpointInput): Promise<ProjectCheckpoint> { return project.createProjectCheckpoint(this.pool, context, companyId, projectId, input); }
  async listProjectCheckpoints(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectCheckpoint[]> { return project.listProjectCheckpoints(this.pool, context, companyId, projectId, limit); }
  async getProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<ProjectCheckpoint> { return project.getProjectCheckpoint(this.pool, context, companyId, projectId, checkpointId); }
  async deleteProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<boolean> { return project.deleteProjectCheckpoint(this.pool, context, companyId, projectId, checkpointId); }
  async createProjectDeployment(context: AuthContext, companyId: string, projectId: string, input: CreateDeploymentInput): Promise<ProjectDeployment> { return project.createProjectDeployment(this.pool, context, companyId, projectId, input); }
  async listProjectDeployments(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectDeployment[]> { return project.listProjectDeployments(this.pool, context, companyId, projectId, limit); }
  async getProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string): Promise<ProjectDeployment | null> { return project.getProjectDeployment(this.pool, context, companyId, projectId, deploymentId); }
  async updateProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string, patch: Partial<ProjectDeployment>): Promise<ProjectDeployment> { return project.updateProjectDeployment(this.pool, context, companyId, projectId, deploymentId, patch); }
  async createProjectQaReport(context: AuthContext, companyId: string, projectId: string, input: CreateProjectQaReportInput): Promise<ProjectQaReport> { return project.createProjectQaReport(this.pool, context, companyId, projectId, input); }
  async listProjectQaReports(context: AuthContext, companyId: string, projectId: string, limit = 50, runId?: string): Promise<ProjectQaReport[]> { return project.listProjectQaReports(this.pool, context, companyId, projectId, limit, runId); }
  async getProjectQaReport(context: AuthContext, companyId: string, projectId: string, reportId: string): Promise<ProjectQaReport | null> { return project.getProjectQaReport(this.pool, context, companyId, projectId, reportId); }
  async getLatestProjectQaReport(context: AuthContext, companyId: string, projectId: string): Promise<ProjectQaReport | null> {
    const list = await this.listProjectQaReports(context, companyId, projectId, 1);
    return list[0] ?? null;
  }

  async getCompanyAgent(context: AuthContext, companyId: string, agentId: string) { return company.getCompanyAgent(this.pool, context, companyId, agentId); }
  async createCompanyAgent(context: AuthContext, companyId: string, input: CompanyAgentInput, idempotencyKey: string) { return company.createCompanyAgent(this.pool, context, companyId, input, idempotencyKey); }
  async updateCompanyAgent(context: AuthContext, companyId: string, agentId: string, input: Partial<CompanyAgentInput>, expectedRevision: number) { return company.updateCompanyAgent(this.pool, context, companyId, agentId, input, expectedRevision); }
  async deleteCompanyAgent(context: AuthContext, companyId: string, agentId: string, expectedRevision: number) { return company.deleteCompanyAgent(this.pool, context, companyId, agentId, expectedRevision); }
  async listCompanyAgentEdges(context: AuthContext, companyId: string, agentIds?: string[]) { return company.listCompanyAgentEdges(this.pool, context, companyId, agentIds); }
  async setCompanyAgentParent(context: AuthContext, companyId: string, childAgentId: string, parentAgentId: string | null) { return agentRepos.setCompanyAgentParent(this.pool, context, companyId, childAgentId, parentAgentId); }
  async createCompanyAgentRun(context: AuthContext, companyId: string, input: { task: string; requestedMode: "auto" | "single" | "pipeline" | "fusion"; projectId?: string }, idempotencyKey: string) { return company.createCompanyAgentRun(this.pool, context, companyId, input, idempotencyKey); }
  async listCompanyAgentRuns(context: AuthContext, companyId: string, limit = 50, filter?: { projectId?: string; contentOnly?: boolean }) { return company.listCompanyAgentRuns(this.pool, context, companyId, limit, filter); }
  async listProjectRuns(context: AuthContext, companyId: string, projectId: string, limit = 50) {
    return this.listCompanyAgentRuns(context, companyId, limit, { projectId });
  }

  async getCompanyAgentRun(context: AuthContext, companyId: string, runId: string) { return company.getCompanyAgentRun(this.pool, context, companyId, runId); }
  async getCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string): Promise<unknown | null> { return company.getCompanyRunPendingPlan(this.pool, context, companyId, runId); }
  async setCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string, plan: unknown | null): Promise<void> { return company.setCompanyRunPendingPlan(this.pool, context, companyId, runId, plan); }
  async updateCompanyAgentRun(context: AuthContext, companyId: string, runId: string, patch: Partial<CompanyAgentRun>) { return company.updateCompanyAgentRun(this.pool, context, companyId, runId, patch); }
  async updateCompanyAgentRunStep(context: AuthContext, companyId: string, runId: string, agentId: string, status: CompanyAgentRunStep["status"]) {
    await this.getCompanyAgentRun(context, companyId, runId);
    await this.pool.query('UPDATE company_agent_run_steps SET status=$5,updated_at=now() WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 AND agent_id=$4', [context.workspaceId, companyId, runId, agentId, status]);
  }
  async replaceCompanyAgentRunSteps(context: AuthContext, companyId: string, runId: string, steps: Array<Pick<CompanyAgentRunStep, "agentId" | "stepOrder" | "lane" | "role" | "status" | "modelId">>) { return company.replaceCompanyAgentRunSteps(this.pool, context, companyId, runId, steps); }
  async appendCompanyAgentToolAudit(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentToolAudit, "agentId" | "toolName" | "decision" | "status" | "inputSummary" | "errorMessage"> & Partial<Pick<CompanyAgentToolAudit, "latencyMs" | "cost" | "tokens" | "reasonCode" | "sequenceNumber">>) { return company.appendCompanyAgentToolAudit(this.pool, context, companyId, runId, entry); }
  async appendCompanyAgentRunEvent(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentRunEvent, "eventKey" | "eventType" | "runStatus" | "message"> & Partial<Pick<CompanyAgentRunEvent, "workerId" | "attemptCount" | "details">>) { return company.appendCompanyAgentRunEvent(this.pool, context, companyId, runId, entry); }
  async claimCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) { return company.claimCompanyAgentRun(this.pool, context, companyId, runId, workerId, leaseMs); }
  async heartbeatCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) { return company.heartbeatCompanyAgentRun(this.pool, context, companyId, runId, workerId, leaseMs); }
  async requeueCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, delayMs: number) { return company.requeueCompanyAgentRun(this.pool, context, companyId, runId, workerId, delayMs); }
  async listRecoverableCompanyAgentRuns(limit = 200) { return company.listRecoverableCompanyAgentRuns(this.pool, limit); }
  async heartbeatInlineCompanyAgentRuns(owner: string, runIds: string[]) { return company.heartbeatInlineCompanyAgentRuns(this.pool, owner, runIds); }
  async failOrphanedInlineCompanyAgentRuns(staleMs: number) { return company.failOrphanedInlineCompanyAgentRuns(this.pool, staleMs); }
  async listGoals(context: AuthContext, businessId: string) { return collab.listGoals(this.pool, context, businessId); }
  async listUserGoals(context: AuthContext) { return collab.listUserGoals(this.pool, context); }
  async listGoalPage(context: AuthContext, query: GoalPageQuery) { return listGoalPage(this.pool, context, query); }
  async createGoal(context: AuthContext, businessId: string, input: GoalInput) { return collab.createGoal(this.pool, context, businessId, input); }
  async linkGoal(context: AuthContext, businessId: string, goalId: string) { return collab.linkGoal(this.pool, context, businessId, goalId); }
  async updateGoal(context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>) { return collab.updateGoal(this.pool, context, businessId, goalId, input); }
  async deleteGoal(context: AuthContext, businessId: string, goalId: string) { return collab.deleteGoal(this.pool, context, businessId, goalId); }
  async listMemory(context: AuthContext, businessId: string, query = "", limit = 100) { return collab.listMemory(this.pool, context, businessId, query, limit); }
  async listMemoryPage(context: AuthContext, query: MemoryPageQuery) { return listMemoryPage(this.pool, context, query); }
  async listUserMemories(context: AuthContext, query = "", limit = 100) { return collab.listUserMemories(this.pool, context, query, limit); }
  async createMemory(context: AuthContext, businessId: string, input: MemoryInput) { return collab.createMemory(this.pool, context, businessId, input); }
  async linkMemory(context: AuthContext, businessId: string, memoryId: string) { return collab.linkMemory(this.pool, context, businessId, memoryId); }
  async updateMemory(context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>) { return collab.updateMemory(this.pool, context, businessId, memoryId, input); }
  async deleteMemory(context: AuthContext, businessId: string, memoryId: string) { return collab.deleteMemory(this.pool, context, businessId, memoryId); }
  async listConversations(context: AuthContext, businessId: string) { return collab.listConversations(this.pool, context, businessId); }
  async createConversation(context: AuthContext, businessId: string, title: string) { return collab.createConversation(this.pool, context, businessId, title); }
  async getConversation(context: AuthContext, businessId: string, conversationId: string) { return collab.getConversation(this.pool, context, businessId, conversationId); }
  async updateConversation(context: AuthContext, businessId: string, conversationId: string, title: string) { return collab.updateConversation(this.pool, context, businessId, conversationId, title); }
  async deleteConversation(context: AuthContext, businessId: string, conversationId: string) { return collab.deleteConversation(this.pool, context, businessId, conversationId); }
  async appendMessage(context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string) { return collab.appendMessage(this.pool, context, businessId, conversationId, role, content); }
  async listNeutralConversations(context: AuthContext) { return collab.listNeutralConversations(this.pool, context); }
  async createNeutralConversation(context: AuthContext, title: string) { return collab.createNeutralConversation(this.pool, context, title); }
  async getNeutralConversation(context: AuthContext, conversationId: string) { return collab.getNeutralConversation(this.pool, context, conversationId); }
  async getNeutralConversationPage(context: AuthContext, conversationId: string, before?: string, limit?: number) {
    await support.ensureIdentity(this.pool, context);
    return readNeutralMessagePage(this.pool, context, conversationId, before, limit);
  }
  async listChatSidebarPage(context: AuthContext, offset?: number, limit?: number) {
    await support.ensureIdentity(this.pool, context);
    await support.assertMember(this.pool, context);
    return readChatSidebarPage(this.pool, context, offset, limit);
  }
  async updateNeutralConversation(context: AuthContext, conversationId: string, title: string) { return collab.updateNeutralConversation(this.pool, context, conversationId, title); }
  async deleteNeutralConversation(context: AuthContext, conversationId: string) { return collab.deleteNeutralConversation(this.pool, context, conversationId); }
  async appendNeutralMessage(context: AuthContext, conversationId: string, role: ConversationMessage["role"], content: string) { return collab.appendNeutralMessage(this.pool, context, conversationId, role, content); }
  async appendConversationResearch(context: AuthContext, conversationId: string, input: ConversationResearchInput) { if (input.companyId) await this.getCompany(context, input.companyId); return research.appendConversationResearch(this.pool, context, conversationId, input); }
  async listConversationResearch(context: AuthContext, conversationId: string, limit?: number) { return research.listConversationResearch(this.pool, context, conversationId, limit); }
  async getCompanyMembership(companyId: string, userId: string): Promise<CompanyMember | null> { return company.getCompanyMembership(this.pool, companyId, userId); }
  async listCompanyMembers(companyId: string): Promise<CompanyMember[]> { return company.listCompanyMembers(this.pool, companyId); }
  async countCompanyOwners(companyId: string): Promise<number> { return company.countCompanyOwners(this.pool, companyId); }
  async createCompanyInvite(input: CompanyInviteInput): Promise<CompanyInvite> { return company.createCompanyInvite(this.pool, input); }
  async findCompanyInviteByTokenHash(tokenHash: string): Promise<CompanyInvite | null> { return company.findCompanyInviteByTokenHash(this.pool, tokenHash); }
  async acceptCompanyInvite(input: AcceptCompanyInviteInput): Promise<CompanyMember> { return onboarding.acceptCompanyInvite(this.pool, input); }
  async updateCompanyMemberRole(input: UpdateCompanyMemberRoleInput): Promise<CompanyMember> { return company.updateCompanyMemberRole(this.pool, input); }
  async removeCompanyMember(input: RemoveCompanyMemberInput): Promise<void> { return company.removeCompanyMember(this.pool, input); }
  private async hydrateOnboarding(context: AuthContext, row: Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">): Promise<BusinessOnboardingSession> { return project.hydrateOnboarding(this.pool, context, row); }
  async listOnboardings(context: AuthContext) { return project.listOnboardings(this.pool, context); }
  async getOnboarding(context: AuthContext, businessId?: string) { return project.getOnboarding(this.pool, context, businessId); }
  private async getOnboardingSession(context: AuthContext, sessionId: string) { return project.getOnboardingSession(this.pool, context, sessionId); }
  async startOnboarding(context: AuthContext, scenario: OnboardingScenario, options?: { forceNew?: boolean }) { return onboarding.startOnboarding(this.pool, context, scenario, options); }
  async advanceOnboarding(context: AuthContext, sessionId: string, input: { value?: string; skip?: boolean; businessPatch?: Partial<BusinessInput> }) { return project.advanceOnboarding(this.pool, context, sessionId, input); }
  async setOnboardingStatus(context: AuthContext, sessionId: string, status: "active" | "paused") { return project.setOnboardingStatus(this.pool, context, sessionId, status); }
  async completeOnboarding(context: AuthContext, sessionId: string): Promise<BusinessOnboardingSession> { return onboarding.completeOnboarding(this.pool, context, sessionId); }
  async getProviderDataPolicy(input: { companyId: string | null; providerId: string; modelPattern: string | null }): Promise<ProviderDataPolicyRecord | null> { return policy.getProviderDataPolicy(this.pool, input); }
  async listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]> { return policy.listProviderDataPolicies(this.pool, companyId); }
  async upsertProviderDataPolicy(input: UpsertProviderDataPolicyStoreInput): Promise<ProviderDataPolicyRecord> { return policy.upsertProviderDataPolicy(this.pool, input); }
  async listProviderDataPolicyVersions(companyId: string | null, providerId: string, modelPattern?: string | null): Promise<ProviderDataPolicyVersionRecord[]> { return policy.listProviderDataPolicyVersions(this.pool, companyId, providerId, modelPattern); }
  async getProjectDataPolicy(companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null> { return policy.getProjectDataPolicy(this.pool, companyId, projectId); }
  async upsertProjectDataPolicy(input: UpsertProjectDataPolicyStoreInput): Promise<ProjectDataPolicyRecord> { return policy.upsertProjectDataPolicy(this.pool, input); }
  async grantHostedProviderConsent(input: { companyId: string; projectId: string; providerId: string; grantedBy: string; grantedAt?: Date }): Promise<ProviderHostedConsentRecord> { return policy.grantHostedProviderConsent(this.pool, input); }
  async revokeHostedProviderConsent(input: { companyId: string; projectId: string; providerId: string; revokedAt?: Date }): Promise<ProviderHostedConsentRecord> { return policy.revokeHostedProviderConsent(this.pool, input); }
  async getHostedProviderConsent(input: { companyId: string; projectId: string; providerId: string }): Promise<ProviderHostedConsentRecord | null> { return policy.getHostedProviderConsent(this.pool, input); }
  async createCodeRunState(input: CreateCodeRunStateInput): Promise<CodeRunStateRecord> { return project.createCodeRunState(this.pool, input); }
  async getCodeRunRequest(companyId: string, runId: string): Promise<CodeRunRequestRecord | null> { return project.getCodeRunRequest(this.pool, companyId, runId); }
  async applyCodeRunStateEvent(input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord> { return project.applyCodeRunStateEvent(this.pool, input); }
  async getCodeRunState(companyId: string, runId: string): Promise<CodeRunStateRecord | null> { return project.getCodeRunState(this.pool, companyId, runId); }
  async listStaleCodeRunStates(input: { now: Date; limit: number }): Promise<CodeRunStateRecord[]> { return project.listStaleCodeRunStates(this.pool, input); }
  async listCodeRunStates(input: ListCodeRunStatesInput): Promise<CodeRunStateRecord[]> { return project.listCodeRunStates(this.pool, input); }
  async upsertCodeRunTurn(input: UpsertCodeRunTurnInput): Promise<CodeRunTurnRecord> { return codeRuns.upsertCodeRunTurn(this.pool, input); }
  async getCodeRunTurn(companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null> { return project.getCodeRunTurn(this.pool, companyId, runId, turnIndex); }
  async listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]> { return project.listCodeRunTurns(this.pool, companyId, runId); }
  async listCodeRunStatesForScan(input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>> { return project.listCodeRunStatesForScan(this.pool, input); }
  async listCodeProjectRefs(input: CodeProjectRefScanInput): Promise<CodeProjectRefScanPage> { return project.listCodeProjectRefs(this.pool, input); }
  async getProjectForSystem(companyId: string, projectId: string): Promise<Project | null> { return project.getProjectForSystem(this.pool, companyId, projectId); }
  async listCodeRunTurnsForScan(input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>> { return project.listCodeRunTurnsForScan(this.pool, input); }
  private async insertExecutionSnapshot(record: ExecutionSnapshotRecord): Promise<void> { return codeRuns.insertExecutionSnapshot(this.pool, record); }
  async createExecutionSnapshot(input: CreateExecutionSnapshotInput): Promise<ExecutionSnapshotRecord> { return codeRuns.createExecutionSnapshot(this.pool, input); }
  async getExecutionSnapshot(companyId: string, snapshotId: string): Promise<ExecutionSnapshotRecord | null> { return codeRuns.getExecutionSnapshot(this.pool, companyId, snapshotId); }
  async getLatestSnapshotForSession(companyId: string, sessionId: string): Promise<ExecutionSnapshotRecord | null> { return codeRuns.getLatestSnapshotForSession(this.pool, companyId, sessionId); }
  async getSnapshotForRun(companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null> { return codeRuns.getSnapshotForRun(this.pool, companyId, runId); }
  async listExecutionSnapshots(input: ListExecutionSnapshotsInput): Promise<ExecutionSnapshotRecord[]> { return codeRuns.listExecutionSnapshots(this.pool, input); }
  diffExecutionSnapshots(a: ExecutionSnapshotRecord, b: ExecutionSnapshotRecord): ExecutionSnapshotDiff { return codeRuns.diffExecutionSnapshots(a, b); }
  async createSnapshotConfigVersion(input: CreateSnapshotConfigVersionInput): Promise<SnapshotConfigVersionRecord> { return replay.createSnapshotConfigVersion(this.pool, input); }
  async getSnapshotConfigVersion(
    companyId: string, kind: SnapshotConfigKind, version: number,
  ): Promise<SnapshotConfigVersionRecord | null> {
    return replay.getSnapshotConfigVersion(this.pool, companyId, kind, version);
  }

  async findSnapshotConfigVersionByHash(
    companyId: string, kind: SnapshotConfigKind, contentHash: string,
  ): Promise<SnapshotConfigVersionRecord | null> {
    return replay.findSnapshotConfigVersionByHash(this.pool, companyId, kind, contentHash);
  }

  async listSnapshotConfigVersions(companyId: string, kind: SnapshotConfigKind): Promise<SnapshotConfigVersionRecord[]> { return replay.listSnapshotConfigVersions(this.pool, companyId, kind); }
  async createCodeActivityEvent(input: CreateCodeActivityEventInput): Promise<CodeActivityEventRecord> { return project.createCodeActivityEvent(this.pool, input); }
  async listCodeActivityEvents(input: ListCodeActivityEventsInput): Promise<CodeActivityEventRecord[]> { return project.listCodeActivityEvents(this.pool, input); }
  async createCodeContextSummary(input: CreateCodeContextSummaryInput): Promise<CodeContextSummaryRecord> { return project.createCodeContextSummary(this.pool, input); }
  async listCodeContextSummaries(input: ListCodeContextSummariesInput): Promise<CodeContextSummaryRecord[]> { return project.listCodeContextSummaries(this.pool, input); }
  async createReplayBundle(input: CreateReplayBundleInput): Promise<ReplayBundleRecord> { return replay.createReplayBundle(this.pool, input); }
  async getReplayBundle(companyId: string, runId: string, bundleVersion?: number): Promise<ReplayBundleRecord | null> { return replay.getReplayBundle(this.pool, companyId, runId, bundleVersion); }
  async getReplayBundleById(companyId: string, bundleId: string): Promise<ReplayBundleRecord | null> { return replay.getReplayBundleById(this.pool, companyId, bundleId); }
  async listReplayBundles(input: ListReplayBundlesInput): Promise<ReplayBundleRecord[]> { return replay.listReplayBundles(this.pool, input); }
  async listReplayBundleSteps(companyId: string, bundleId: string): Promise<ReplayBundleStepRecord[]> { return replay.listReplayBundleSteps(this.pool, companyId, bundleId); }
  private codeDataLifecycleInstance?: CodeDataLifecycleStore;
  get codeDataLifecycle(): CodeDataLifecycleStore | undefined {
    return this.codeDataLifecycleInstance ??= createPostgresDataLifecycleStore(this.pool);
  }
}
