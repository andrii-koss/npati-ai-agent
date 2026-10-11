import { randomUUID } from "node:crypto";
import { codeChildSessionId } from "./code-child-session-id";
import { MemoryCodeInboxStore } from "./code-session-inbox-memory";
import { MemoryCodeProcessStore } from "./code-process-store-memory";
import { assertNoSecrets } from "@npati/memory";
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
import { auditEntryHash, verifyAuditEntries } from "./audit-chain";
import { ONBOARDING_FLOWS, onboardingBusinessPatch, onboardingPlaceholder } from "./onboarding";
import { companyPageLimit, decodeBusinessCursor, encodeBusinessCursor } from './pagination';
import { now } from "./in-memory-clock";
import { createProject, listProjects, getProject, updateProject, getProjectCodeTrust, getProjectMountedFolder, getProjectMountedFolderForSystem, updateProjectRepository, updateProjectPreview, archiveProject, deleteProject, createProjectCheckpoint, getProjectCheckpoint, deleteProjectCheckpoint, createProjectDeployment, getProjectDeployment, updateProjectDeployment, createProjectQaReport, getProjectQaReport, getProjectDataPolicy, getProjectForSystem, type InMemoryProjectState } from "./in-memory-project-store";
import { setCompanyAgentParent, listGoals, createGoal, updateGoal, deleteGoal, listMemory, createMemory, updateMemory, type InMemoryGoalState } from "./in-memory-goal-store";

type StoredUserSetting = import('./types').UserSetting;
export class InMemoryWorkspaceStore implements WorkspaceStore {
  readonly codeProcesses = new MemoryCodeProcessStore(async (scope) => [...this.codeRunStates.values()]
    .filter((run) => run.companyId === scope.companyId && run.projectId === scope.projectId)
    .map((run) => ({ runId: run.runId, sessionId: run.sessionId, owner: run.leaseOwner,
      live: run.status === "running" && !!run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now(), terminal: ["completed", "failed", "cancelled"].includes(run.status) })));
  readonly codeInbox = new MemoryCodeInboxStore(async (scope) => [...this.codeRunStates.values()]
    .filter((run) => run.companyId === scope.companyId && run.sessionId === scope.sessionId)
    .map((run) => ({ runId: run.runId, owner: run.leaseOwner,
      live: run.status === "running" && !!run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now(),
      terminal: ["completed", "failed", "cancelled"].includes(run.status) })));
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

  private goalState(): InMemoryGoalState {
    return {
      companyEdges: this.companyEdges,
      goals: this.goals,
      memories: this.memories,
      assertBusiness: this.assertBusiness.bind(this),
      assertCompanyAgent: this.assertCompanyAgent.bind(this),
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

  async initialize(context?: AuthContext) {
    if (context) this.identities.set(`${context.workspaceId}:${context.userId}`, { displayName: "Dev User", workspaceName: "My Workspace", role: "owner" });
  }

  async health() { return "ok" as const; }

  async getUserSetting(context: AuthContext, key: string) {
    await this.ensure(context);
    return structuredClone(this.userSettings.get(`${context.workspaceId}:${context.userId}:${key}`) ?? null);
  }

  async setUserSetting(context: AuthContext, key: string, value: unknown, expectedRevision: number) {
    await this.ensure(context);
    const storageKey = `${context.workspaceId}:${context.userId}:${key}`;
    const current = this.userSettings.get(storageKey);
    if ((current?.revision ?? 0) !== expectedRevision) return null;
    const next: StoredUserSetting = { key, value: structuredClone(value), revision: expectedRevision + 1, updatedAt: now() };
    this.userSettings.set(storageKey, next);
    return structuredClone(next);
  }

  private async ensure(context: AuthContext) {
    const key = `${context.workspaceId}:${context.userId}`;
    if (!this.identities.has(key)) await this.initialize(context);
    return this.identities.get(key)!;
  }

  private assertBusiness(context: AuthContext, businessId: string) {
    const business = this.businesses.get(businessId);
    if (!business || business.workspaceId !== context.workspaceId) throw new WorkspaceAccessError("Business is not available in this workspace");
    return business;
  }

  private assertUserBusiness(context: AuthContext, businessId: string) {
    const business = this.businesses.get(businessId);
    if (!business || business.workspaceId !== context.workspaceId || business.ownerUserId !== context.userId) {
      throw new WorkspaceAccessError("Business is not available or not owned by this user");
    }
    return business;
  }

  async overview(context: AuthContext): Promise<WorkspaceOverview> {
    const identity = await this.ensure(context);
    const businesses = await this.listBusinesses(context);
    let currentId = this.current.get(`${context.workspaceId}:${context.userId}`);
    if (!currentId && businesses.length > 0) {
      currentId = businesses[0]!.id;
      this.current.set(`${context.workspaceId}:${context.userId}`, currentId);
    }
    return {
      user: { id: context.userId, displayName: identity.displayName },
      workspace: { id: context.workspaceId, name: identity.workspaceName, role: identity.role },
      businesses,
      currentBusiness: businesses.find((business) => business.id === currentId) ?? null,
      onboarding: (await this.listOnboardings(context))[0] ?? null,
      onboardings: await this.listOnboardings(context),
    };
  }

  async setCurrentBusiness(context: AuthContext, businessId: string) {
    const business = this.assertBusiness(context, businessId);
    this.current.set(`${context.workspaceId}:${context.userId}`, businessId);
    return business;
  }

  async listBusinesses(context: AuthContext) {
    return [...this.businesses.values()].filter((business) => business.workspaceId === context.workspaceId && business.activationStatus === "active").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async listUserBusinesses(context: AuthContext) {
    return [...this.businesses.values()]
      .filter((business) => business.workspaceId === context.workspaceId && business.ownerUserId === context.userId && business.activationStatus === "active")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
  }

  async listBusinessesPage(context: AuthContext, requestedLimit = 20, cursor?: string) {
    const limit = companyPageLimit(requestedLimit);
    const after = decodeBusinessCursor(cursor);
    const businesses = (await this.listBusinesses(context)).filter((business) => !after || business.createdAt > after.createdAt || (business.createdAt === after.createdAt && business.id > after.id));
    const items = businesses.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: businesses.length > limit && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

  async getBusiness(context: AuthContext, businessId: string) { return this.assertBusiness(context, businessId); }

  async getUserBusiness(context: AuthContext, businessId: string) { return this.assertUserBusiness(context, businessId); }

  async createBusiness(context: AuthContext, input: BusinessInput, idempotencyKey?: string) {
    await this.ensure(context);
    const requestKey = idempotencyKey ? `${context.workspaceId}:${context.userId}:${idempotencyKey}` : null;
    const existingId = requestKey ? this.businessCreateRequests.get(requestKey) : undefined;
    const existing = existingId ? this.businesses.get(existingId) : undefined;
    if (existing) return existing;
    const timestamp = now();
    const business: Business = {
      id: randomUUID(), workspaceId: context.workspaceId, ownerUserId: context.userId,
      name: input.name.trim(), businessStage: input.businessStage ?? "starting", activationStatus: "active", createdAt: timestamp, updatedAt: timestamp,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    } as Business;
    if (!business.name) throw new Error("Business name is required");
    this.businesses.set(business.id, business);
    if (requestKey) this.businessCreateRequests.set(requestKey, business.id);
    this.current.set(`${context.workspaceId}:${context.userId}`, business.id);
    return business;
  }

  async updateBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>) {
    const current = this.assertBusiness(context, businessId);
    const updated = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), updatedAt: now() };
    if (!updated.name.trim()) throw new Error("Business name is required");
    this.businesses.set(businessId, updated);
    return updated;
  }

  async updateUserBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>) {
    const current = this.assertUserBusiness(context, businessId);
    const updated = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), updatedAt: now() };
    if (!updated.name.trim()) throw new Error("Business name is required");
    this.businesses.set(businessId, updated);
    return updated;
  }

  async deleteBusiness(context: AuthContext, businessId: string) {
    this.assertBusiness(context, businessId);
    this.businesses.delete(businessId);
    for (const [id, goal] of this.goals) if (goal.businessId === businessId) this.goals.delete(id);
    for (const [id, memory] of this.memories) if (memory.businessId === businessId) this.memories.delete(id);
    for (const [id, conversation] of this.conversations) if (conversation.businessId === businessId) this.conversations.delete(id);
    if (this.current.get(`${context.workspaceId}:${context.userId}`) === businessId) this.current.delete(`${context.workspaceId}:${context.userId}`);
    return true;
  }

  private assertCompany(context: AuthContext, companyId: string) {
    if (context.companyId && context.companyId !== companyId) throw new WorkspaceAccessError("API key is not valid for this company");
    const company = this.companies.get(companyId);
    if (!company || company.workspaceId !== context.workspaceId || company.userId !== context.userId) {
      throw new WorkspaceAccessError("Company is not available to this user");
    }
    return company;
  }

  async listCompanies(context: AuthContext, requestedLimit = 20, cursor?: string) {
    await this.ensure(context);
    const limit = companyPageLimit(requestedLimit), after = decodeBusinessCursor(cursor);
    const rows = [...this.companies.values()]
      .filter((company) => company.workspaceId === context.workspaceId && company.userId === context.userId && (!context.companyId || company.id === context.companyId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .filter((company) => !after || company.createdAt > after.createdAt || (company.createdAt === after.createdAt && company.id > after.id));
    const items = rows.slice(0, limit), last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

  async getCompany(context: AuthContext, companyId: string) { return this.assertCompany(context, companyId); }

  async createCompany(context: AuthContext, input: CompanyInput, idempotencyKey: string) {
    if (context.companyId) throw new WorkspaceAccessError("Company-scoped API keys cannot create companies");
    await this.ensure(context);
    const requestKey = `${context.workspaceId}:${context.userId}:${idempotencyKey}`;
    const existingId = this.companyCreateRequests.get(requestKey);
    if (existingId) return this.assertCompany(context, existingId);
    if (!input.name?.trim()) throw new Error("Company name is required");
    if (input.businessId) this.assertBusiness(context, input.businessId);
    const timestamp = now();
    const company: Company = {
      id: randomUUID(), workspaceId: context.workspaceId, userId: context.userId, name: input.name.trim(),
      businessId: input.businessId, website: input.website, industry: input.industry, description: input.description,
      productsServices: input.productsServices, languages: input.languages ?? [], brandTone: input.brandTone,
      companyInstructions: input.companyInstructions, knowledge: input.knowledge ?? [], memory: input.memory ?? {},
      status: input.status ?? "active", revision: 1, createdAt: timestamp, updatedAt: timestamp,
    };
    this.companies.set(company.id, company);
    this.companyCreateRequests.set(requestKey, company.id);
    return company;
  }

  async convertBusinessToCompany(context: AuthContext, businessId: string, input: BusinessToCompanyInput, idempotencyKey: string): Promise<{ company: Company; created: boolean }> {
    const business = await this.getBusiness(context, businessId);
    const requestKey = `${context.workspaceId}:${context.userId}:${idempotencyKey}`;
    const existingId = this.companyCreateRequests.get(requestKey);
    if (existingId) {
      return { company: structuredClone(this.assertCompany(context, existingId)), created: false };
    }

    const memory: Record<string, unknown> = {};
    if (input.includeConfirmedMemory) {
      const memories = await this.listMemory(context, businessId);
      memory["confirmed_business_facts"] = memories.map((m) => m.content);
    }
    if (input.includeGoals) {
      const goals = await this.listGoals(context, businessId);
      memory["transferred_goals"] = goals.map((g) => ({ title: g.title, description: g.description, status: g.status }));
    }

    const instructionParts: string[] = [];
    if (input.includeInstructions) {
      if (business.description) instructionParts.push(`Business Description: ${business.description}`);
      if (business.businessModel) instructionParts.push(`Business Model: ${business.businessModel}`);
    }
    if (input.includeResearchSummary) {
      if (business.audienceSummary) instructionParts.push(`Target Audience: ${business.audienceSummary}`);
      if (business.market) instructionParts.push(`Market & Niche: ${business.market} / ${business.niche ?? ""}`);
    }

    const companyInput: CompanyInput = {
      name: input.companyName?.trim() || business.name,
      businessId: business.id,
      website: business.website,
      industry: business.industry,
      description: business.description,
      productsServices: business.productsServicesSummary,
      knowledge: business.logoFileId ? [{ attachmentId: business.logoFileId, kind: "image", name: "Company logo", source: "linked_business" }] : [],
      companyInstructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
      memory,
      languages: ["Ukrainian", "English"],
      status: "active",
    };

    const company = await this.createCompany(context, companyInput, idempotencyKey);

    const mainAgent = await this.createCompanyAgent(context, company.id, {
      name: "Main Agent",
      role: "Coordinator",
      description: `Primary executive agent for ${company.name}`,
      tools: ["web.search", "files", "knowledge"],
      isActive: true,
    }, `${idempotencyKey}:main-agent`);

    await this.setCompanyMainAgent(context, company.id, mainAgent.id, company.revision);
    const updatedCompany = this.assertCompany(context, company.id);

    return { company: structuredClone(updatedCompany), created: true };
  }

  async updateCompany(context: AuthContext, companyId: string, input: Partial<CompanyInput>, expectedRevision: number) {
    const current = this.assertCompany(context, companyId);
    if (current.revision !== expectedRevision) throw new Error("Company was changed by another request. Reload and try again.");
    if (input.businessId) this.assertBusiness(context, input.businessId);
    const updated = { ...current, ...input, name: input.name?.trim() ?? current.name, revision: current.revision + 1, updatedAt: now() };
    if (!updated.name) throw new Error("Company name is required");
    this.companies.set(companyId, updated);
    return updated;
  }

  async deleteCompany(context: AuthContext, companyId: string) {
    this.assertCompany(context, companyId);
    this.companies.delete(companyId);
    for (const [id, project] of this.projects) if (project.companyId === companyId) this.projects.delete(id);
    for (const [id, agent] of this.companyAgents) if (agent.companyId === companyId) this.companyAgents.delete(id);
    for (const [id, edge] of this.companyEdges) if (edge.companyId === companyId) this.companyEdges.delete(id);
    return true;
  }

  async setCompanyMainAgent(context: AuthContext, companyId: string, agentId: string | null, expectedRevision: number) {
    const company = this.assertCompany(context, companyId);
    if (company.revision !== expectedRevision) throw new Error("Company was changed by another request. Reload and try again.");
    if (agentId) this.assertCompanyAgent(context, companyId, agentId);
    const updated = { ...company, mainAgentId: agentId ?? undefined, revision: company.revision + 1, updatedAt: now() };
    this.companies.set(companyId, updated);
    return updated;
  }

  private assertCompanyAgent(context: AuthContext, companyId: string, agentId: string) {
    this.assertCompany(context, companyId);
    const agent = this.companyAgents.get(agentId);
    if (!agent || agent.workspaceId !== context.workspaceId || agent.companyId !== companyId) {
      throw new WorkspaceNotFoundError("Agent was not found in this company");
    }
    return agent;
  }

  async listCompanyAgents(context: AuthContext, companyId: string) {
    this.assertCompany(context, companyId);
    return [...this.companyAgents.values()].filter((agent) => agent.workspaceId === context.workspaceId && agent.companyId === companyId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async listCompanyAgentsPage(context: AuthContext, companyId: string, requestedLimit = 50, cursor?: string) {
    const limit = companyPageLimit(requestedLimit), after = decodeBusinessCursor(cursor);
    const rows = (await this.listCompanyAgents(context, companyId))
      .slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .filter((agent) => !after || agent.createdAt > after.createdAt || (agent.createdAt === after.createdAt && agent.id > after.id));
    const items = rows.slice(0, limit), last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

    async createProject(context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string) {
    return createProject(this.projectState(), context, companyId, input, idempotencyKey);
  }

    async listProjects(context: AuthContext, companyId: string, includeArchived = false) {
    return listProjects(this.projectState(), context, companyId, includeArchived);
  }

    async getProject(context: AuthContext, companyId: string, projectId: string) {
    return getProject(this.projectState(), context, companyId, projectId);
  }

    async updateProject(context: AuthContext, companyId: string, projectId: string, input: { name?: string; expectedRevision: number; code?: ProjectCodeSettings }) {
    return updateProject(this.projectState(), context, companyId, projectId, input);
  }

  async createCodeSession(context: AuthContext, companyId: string, projectId: string, input: CodeSessionInput): Promise<CodeSession> {
    const project = await this.getProject(context, companyId, projectId);
    if (input.agentId && !this.companyAgents.has(input.agentId)) throw new WorkspaceAccessError("Agent does not belong to this company");
    if (input.parentSessionId) {
      const parent = await this.getCodeSession(context, companyId, input.parentSessionId);
      if (parent.projectId !== projectId) throw new WorkspaceAccessError("Parent session belongs to another project");
    }
    const requested = input.dataClassification ?? project.dataClassification;
    if (!isClassificationAtLeast(requested, project.dataClassification)) {
      throw new WorkspaceAccessError("Session data classification cannot be lower than the project classification");
    }
    const id = input.childKey && input.parentSessionId
      ? codeChildSessionId(context, companyId, projectId, input.parentSessionId, input.childKey) : randomUUID();
    if (this.codeSessions.has(id)) return this.getCodeSession(context, companyId, id);
    const timestamp = now();
    const session: CodeSession = {
      id, workspaceId: context.workspaceId, companyId, projectId, userId: context.userId,
      agentId: input.agentId ?? null, mode: input.mode ?? "edit", modelProfile: input.modelProfile ?? null,
      status: "active", parentSessionId: input.parentSessionId ?? null, runId: null,
      summary: input.summary ?? null, dataClassification: requested,
      retentionClass: input.retentionClass ?? project.retentionClass, toolManifestVersion: null,
      revision: 1,
      createdAt: timestamp, updatedAt: timestamp,
    };
    this.codeSessions.set(session.id, session);
    return structuredClone(session);
  }

  async getCodeSession(context: AuthContext, companyId: string, sessionId: string): Promise<CodeSession> {
    const session = this.codeSessions.get(sessionId);
    if (!session || session.workspaceId !== context.workspaceId || session.companyId !== companyId
      || session.userId !== context.userId) throw new WorkspaceNotFoundError("Code session not found");
    return structuredClone(session);
  }

  async listCodeSessions(context: AuthContext, companyId: string, projectId?: string, options: { includeArchived?: boolean; limit?: number } = {}): Promise<CodeSession[]> {
    this.assertCompany(context, companyId);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    return structuredClone([...this.codeSessions.values()]
      .filter((session) => session.workspaceId === context.workspaceId && session.companyId === companyId
        && session.userId === context.userId
        && (!projectId || session.projectId === projectId)
        && (options.includeArchived === true || session.status !== "archived"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .slice(0, limit));
  }

  async appendAuditEntry(context: AuthContext, companyId: string, input: AuditEntryInput): Promise<AuditEntry> {
    this.assertCompany(context, companyId);
    const chain = this.auditLog.get(companyId) ?? [];
    const prevHash = chain.length ? chain[chain.length - 1]!.entryHash : null;
    const sequence = chain.length + 1;
    const createdAt = now();
    const metadata = input.metadata ?? {};
    const id = randomUUID();
    const entry: AuditEntry = {
      id, workspaceId: context.workspaceId, companyId, sequence, createdAt,
      actor: input.actor, actorRole: input.actorRole, action: input.action,
      resourceType: input.resourceType, resourceId: input.resourceId ?? null,
      projectId: input.projectId ?? null, decision: input.decision, payloadHash: input.payloadHash,
      requestId: input.requestId ?? null, correlationId: input.correlationId ?? null,
      snapshotId: input.snapshotId ?? null, metadata, prevHash,
      entryHash: auditEntryHash(prevHash, {
        id, companyId, sequence, createdAt, actor: input.actor, actorRole: input.actorRole,
        requestId: input.requestId ?? null, correlationId: input.correlationId ?? null, snapshotId: input.snapshotId ?? null,
        action: input.action, resourceType: input.resourceType, resourceId: input.resourceId ?? null,
        projectId: input.projectId ?? null, decision: input.decision, payloadHash: input.payloadHash, metadata,
      }),
    };
    chain.push(entry);
    this.auditLog.set(companyId, chain);
    return structuredClone(entry);
  }

  async listAuditEntries(context: AuthContext, companyId: string, filters: { actor?: string; requestId?: string; correlationId?: string; action?: string; limit?: number; fromSequence?: number } = {}): Promise<AuditEntry[]> {
    this.assertCompany(context, companyId);
    const limit = Math.max(1, Math.min(filters.limit ?? 200, 1000));
    return structuredClone((this.auditLog.get(companyId) ?? [])
      .filter((entry) => (!filters.actor || entry.actor === filters.actor)
        && (!filters.requestId || entry.requestId === filters.requestId)
        && (!filters.correlationId || entry.correlationId === filters.correlationId)
        && (!filters.action || entry.action === filters.action)
        && (filters.fromSequence === undefined || entry.sequence >= filters.fromSequence))
      .slice(0, limit));
  }

  async verifyAuditChain(context: AuthContext, companyId: string, range: { fromSequence?: number; toSequence?: number } = {}): Promise<AuditChainVerification> {
    this.assertCompany(context, companyId);
    const entries = (this.auditLog.get(companyId) ?? []).filter((entry) =>
      (range.fromSequence === undefined || entry.sequence >= range.fromSequence)
      && (range.toSequence === undefined || entry.sequence <= range.toSequence));
    const verification = verifyAuditEntries(entries);
    return { ...verification, companyId };
  }

  async auditChainState(context: AuthContext, companyId: string): Promise<AuditChainState> {
    this.assertCompany(context, companyId);
    const chain = this.auditLog.get(companyId) ?? [];
    return { companyId, entryCount: chain.length, headSequence: chain.length, headHash: chain.length ? chain[chain.length - 1]!.entryHash : null };
  }

  async recordAuditAnchor(context: AuthContext, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor> {
    this.assertCompany(context, companyId);
    const record: AuditAnchor = {
      id: randomUUID(), workspaceId: context.workspaceId, companyId, day: anchor.day, sequence: anchor.sequence,
      entryCount: anchor.entryCount, headHash: anchor.headHash, anchorPath: anchor.anchorPath ?? null,
      signature: anchor.signature ?? null, createdAt: now(),
    };
    const existing = this.auditAnchors.get(companyId) ?? [];
    this.auditAnchors.set(companyId, [...existing.filter((item) => item.day !== anchor.day), record]);
    return structuredClone(record);
  }

  async listAuditAnchors(context: AuthContext, companyId: string, limit = 90): Promise<AuditAnchor[]> {
    this.assertCompany(context, companyId);
    return structuredClone((this.auditAnchors.get(companyId) ?? [])
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, Math.max(1, Math.min(limit, 365))));
  }

  async latestAuditAnchor(context: AuthContext, companyId: string): Promise<AuditAnchor | null> {
    return (await this.listAuditAnchors(context, companyId, 1))[0] ?? null;
  }

  async auditCompanies(context: AuthContext): Promise<string[]> {
    return [...this.auditLog.entries()]
      .filter(([, entries]) => entries.length > 0 && entries[0]!.workspaceId === context.workspaceId)
      .map(([companyId]) => companyId)
      .sort();
  }

  async systemAuditChains(workspaceId: string) {
    return [...this.auditLog.entries()]
      .filter(([, entries]) => entries.length > 0 && entries[0]!.workspaceId === workspaceId)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([companyId, entries]) => ({
        companyId,
        state: { companyId, entryCount: entries.length, headSequence: entries.length, headHash: entries[entries.length - 1]!.entryHash },
        verification: { ...verifyAuditEntries(entries), companyId },
      }));
  }

  async systemRecordAuditAnchor(workspaceId: string, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor> {
    const record: AuditAnchor = {
      id: randomUUID(), workspaceId, companyId, day: anchor.day, sequence: anchor.sequence,
      entryCount: anchor.entryCount, headHash: anchor.headHash, anchorPath: anchor.anchorPath ?? null,
      signature: anchor.signature ?? null, createdAt: now(),
    };
    const existing = this.auditAnchors.get(companyId) ?? [];
    this.auditAnchors.set(companyId, [...existing.filter((item) => item.day !== anchor.day), record]);
    return structuredClone(record);
  }

  async setFeatureFlag(context: AuthContext, input: FeatureFlagInput): Promise<FeatureFlag> {
    return this.platformOps.setFeatureFlag(context, input);
  }

  async listFeatureFlags(context: AuthContext): Promise<FeatureFlag[]> {
    return this.platformOps.listFeatureFlags(context);
  }

  async listFeatureFlagHistory(context: AuthContext, flagKey?: string, limit = 100): Promise<FeatureFlagHistoryEntry[]> {
    return this.platformOps.listFeatureFlagHistory(context, flagKey, limit);
  }

  async publishCodeToolManifest(context: AuthContext, manifest: { version: number; tools: CodeToolManifest["tools"]; checksum: string }): Promise<CodeToolManifest> {
    return this.platformOps.publishCodeToolManifest(context, manifest);
  }

  async latestCodeToolManifest(): Promise<CodeToolManifest | null> {
    return this.platformOps.latestCodeToolManifest();
  }

  async createCodeApprovalRule(context: AuthContext, companyId: string, input: CodeApprovalRuleInput): Promise<CodeApprovalRule> {
    this.assertCompany(context, companyId);
    if (input.scope === "session" && !input.sessionId) {
      throw new WorkspaceAccessError("A session-scoped approval rule must name its session");
    }
    if (!input.projectId) throw new WorkspaceAccessError("An approval rule must name its project");
    const key = `${context.workspaceId}|${companyId}|${input.projectId}|${input.sessionId ?? ""}|${input.scope}|${input.action}`;
    const existing = this.codeApprovalRules.get(key);
    const record: CodeApprovalRule = {
      id: existing?.id ?? randomUUID(), workspaceId: context.workspaceId, companyId,
      projectId: input.projectId, sessionId: input.sessionId ?? null, createdBy: context.userId,
      scope: input.scope, action: input.action, decision: "allow",
      reason: input.reason ?? null, expiresAt: input.expiresAt ?? null,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now(), updatedAt: now(),
    };
    this.codeApprovalRules.set(key, record);
    return structuredClone(record);
  }

  async listCodeApprovalRules(context: AuthContext, companyId: string, filters: { projectId?: string; sessionId?: string; scope?: CodeApprovalRuleScope } = {}): Promise<CodeApprovalRule[]> {
    return structuredClone([...this.codeApprovalRules.values()]
      .filter((rule) => rule.workspaceId === context.workspaceId && rule.companyId === companyId)
      .filter((rule) => (filters.projectId ? rule.projectId === filters.projectId : true))
      .filter((rule) => (filters.sessionId ? rule.sessionId === filters.sessionId : true))
      .filter((rule) => (filters.scope ? rule.scope === filters.scope : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  async deleteCodeApprovalRule(context: AuthContext, companyId: string, ruleId: string): Promise<void> {
    this.assertCompany(context, companyId);
    for (const [key, rule] of this.codeApprovalRules) {
      if (rule.id === ruleId && rule.workspaceId === context.workspaceId && rule.companyId === companyId) {
        this.codeApprovalRules.delete(key);
      }
    }
  }

  async findMatchingCodeApprovalRule(context: AuthContext, query: { companyId: string; projectId?: string | null; sessionId?: string | null; action: string }): Promise<CodeApprovalRule | null> {
    this.assertCompany(context, query.companyId);
    const at = now();
    const matches = [...this.codeApprovalRules.values()].filter((rule) => {
      if (rule.workspaceId !== context.workspaceId || rule.companyId !== query.companyId) return false;
      if (rule.action !== query.action || rule.decision !== "allow") return false;
      if (rule.expiresAt && rule.expiresAt <= at) return false;

      if (rule.scope === "session") {
        return Boolean(query.sessionId) && rule.sessionId === query.sessionId
          && Boolean(query.projectId) && rule.projectId === query.projectId;
      }
      return Boolean(query.projectId) && rule.projectId === query.projectId;
    });
    matches.sort((a, b) => (a.scope === b.scope ? b.createdAt.localeCompare(a.createdAt) : a.scope === "session" ? -1 : 1));
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  async listSandboxImages(context: AuthContext): Promise<SandboxImage[]> {
    return this.platformOps.listSandboxImages(context);
  }

  async getSandboxImage(context: AuthContext, reference: string): Promise<SandboxImage | null> {
    return this.platformOps.getSandboxImage(context, reference);
  }

  async upsertSandboxImage(context: AuthContext, input: SandboxImageInput): Promise<SandboxImage> {
    return this.platformOps.upsertSandboxImage(context, input);
  }

  async revokeSandboxImage(context: AuthContext, reference: string, input: { actor: string; reason: string }): Promise<SandboxImage> {
    return this.platformOps.revokeSandboxImage(context, reference, input);
  }

  async latestVerifiedSandboxImage(context: AuthContext, variant: SandboxImageVariant): Promise<SandboxImage | null> {
    return this.platformOps.latestVerifiedSandboxImage(context, variant);
  }

  async updateCodeSession(context: AuthContext, companyId: string, sessionId: string, patch: { status?: CodeSessionStatus; summary?: string; runId?: string | null; modelProfile?: string; dataClassification?: DataClassification; retentionClass?: RetentionClass; toolManifestVersion?: number | null; mode?: CodeSessionMode; expectedRevision?: number }): Promise<CodeSession> {    const session = await this.getCodeSession(context, companyId, sessionId);
    if (patch.dataClassification && !isClassificationAtLeast(patch.dataClassification, session.dataClassification)) {
      throw new WorkspaceAccessError("Session data classification cannot be lowered through this endpoint");
    }
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== session.revision) {
      throw new WorkspaceAccessError("Code session changed by another request. Reload and try again.");
    }
    const next: CodeSession = {
      ...session,
      status: patch.status ?? session.status,
      summary: patch.summary ?? session.summary,
      runId: patch.runId === undefined ? session.runId : patch.runId,
      modelProfile: patch.modelProfile ?? session.modelProfile,
      dataClassification: patch.dataClassification ?? session.dataClassification,
      retentionClass: patch.retentionClass ?? session.retentionClass,
      toolManifestVersion: patch.toolManifestVersion === undefined ? session.toolManifestVersion : patch.toolManifestVersion,
      mode: patch.mode ?? session.mode,
      revision: session.revision + 1,
      updatedAt: now(),
    };
    this.codeSessions.set(sessionId, next);
    return structuredClone(next);
  }

    async getProjectCodeTrust(context: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null> {
    return getProjectCodeTrust(this.projectState(), context, companyId, projectId);
  }

  async setProjectCodeTrust(context: AuthContext, companyId: string, projectId: string, input: ProjectCodeTrustInput): Promise<ProjectCodeTrust> {
    this.assertCompany(context, companyId);
    const key = `${companyId}:${projectId}`;
    const existing = this.projectCodeTrust.get(key);
    if (input.expectedRevision !== (existing?.revision ?? 0)) {
      throw new WorkspaceAccessError("Project trust changed by another request. Reload and try again.");
    }
    const timestamp = now();
    const next: ProjectCodeTrust = {
      id: existing?.id ?? randomUUID(),
      workspaceId: context.workspaceId,
      companyId,
      projectId,
      trusted: input.trusted,
      trustedBy: input.trusted ? input.actor : (existing?.trustedBy ?? null),
      trustedAt: input.trusted ? timestamp : (existing?.trustedAt ?? null),
      revokedBy: input.trusted ? (existing?.revokedBy ?? null) : input.actor,
      revokedAt: input.trusted ? (existing?.revokedAt ?? null) : timestamp,
      reason: input.reason ?? null,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: timestamp,
    };
    this.projectCodeTrust.set(key, next);
    return structuredClone(next);
  }

    async getProjectMountedFolder(context: AuthContext, companyId: string, projectId: string): Promise<ProjectMountedFolder | null> {
    return getProjectMountedFolder(this.projectState(), context, companyId, projectId);
  }

    async getProjectMountedFolderForSystem(companyId: string, projectId: string): Promise<ProjectMountedFolder | null> {
    return getProjectMountedFolderForSystem(this.projectState(), companyId, projectId);
  }

  async setProjectMountedFolder(context: AuthContext, companyId: string, projectId: string, input: ProjectMountedFolderInput): Promise<ProjectMountedFolder> {
    this.assertCompany(context, companyId);
    const key = `${companyId}:${projectId}`;
    const existing = this.projectMountedFolders.get(key);
    if (input.expectedRevision !== (existing?.revision ?? 0)) {
      throw new WorkspaceAccessError("Mounted folder changed by another request. Reload and try again.");
    }
    const timestamp = now();
    const next: ProjectMountedFolder = {
      id: existing?.id ?? randomUUID(),
      workspaceId: context.workspaceId,
      companyId,
      projectId,
      path: input.path,
      mode: input.mode,
      confirmedBy: input.confirmed ? input.actor : (existing?.confirmedBy ?? null),
      confirmedAt: input.confirmed ? timestamp : (existing?.confirmedAt ?? null),
      revokedBy: input.confirmed ? (existing?.revokedBy ?? null) : input.actor,
      revokedAt: input.confirmed ? (existing?.revokedAt ?? null) : timestamp,
      reason: input.reason ?? null,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: timestamp,
    };
    this.projectMountedFolders.set(key, next);
    return structuredClone(next);
  }

  async setProjectSandbox(context: AuthContext, companyId: string, projectId: string, sandboxId: string | null, expectedSandboxId: string | null) {
    const project = await this.getProject(context, companyId, projectId);
    if ((project.sandboxId ?? null) !== expectedSandboxId || project.status === "archived") throw new Error("Project sandbox changed by another request or is archived");
    const next: Project = { ...project, sandboxId: sandboxId ?? undefined, revision: project.revision + 1, updatedAt: now() };
    this.projects.set(projectId, next);
    return structuredClone(next);
  }
    async updateProjectRepository(context: AuthContext, companyId: string, projectId: string, input: { provider: string; url: string; branch: string }): Promise<Project> {
    return updateProjectRepository(this.projectState(), context, companyId, projectId, input);
  }
    async updateProjectPreview(context: AuthContext, companyId: string, projectId: string, patch: { status?: ProjectStatus; previewUrl?: string | null; previewPort?: number | null; framework?: string | null; runtime?: string | null; lastBuildStatus?: string | null; deploymentUrl?: string | null; deploymentStatus?: string | null; lastDeploymentStatus?: string | null; lastDeployedAt?: string | null }) {
    return updateProjectPreview(this.projectState(), context, companyId, projectId, patch);
  }
    async archiveProject(context: AuthContext, companyId: string, projectId: string, expectedRevision: number) {
    return archiveProject(this.projectState(), context, companyId, projectId, expectedRevision);
  }

    async deleteProject(context: AuthContext, companyId: string, projectId: string) {
    return deleteProject(this.projectState(), context, companyId, projectId);
  }

    async createProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, input: CreateCheckpointInput): Promise<ProjectCheckpoint> {
    return createProjectCheckpoint(this.projectState(), context, companyId, projectId, input);
  }

  async listProjectCheckpoints(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectCheckpoint[]> {
    await this.getProject(context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    return structuredClone([...this.projectCheckpoints.values()]
      .filter((c) => c.workspaceId === context.workspaceId && c.companyId === companyId && c.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, safeLimit));
  }

    async getProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<ProjectCheckpoint> {
    return getProjectCheckpoint(this.projectState(), context, companyId, projectId, checkpointId);
  }

    async deleteProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<boolean> {
    return deleteProjectCheckpoint(this.projectState(), context, companyId, projectId, checkpointId);
  }

    async createProjectDeployment(context: AuthContext, companyId: string, projectId: string, input: CreateDeploymentInput): Promise<ProjectDeployment> {
    return createProjectDeployment(this.projectState(), context, companyId, projectId, input);
  }

  async listProjectDeployments(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectDeployment[]> {
    await this.getProject(context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    return structuredClone([...this.projectDeployments.values()]
      .filter((d) => d.workspaceId === context.workspaceId && d.companyId === companyId && d.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, safeLimit));
  }

    async getProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string): Promise<ProjectDeployment | null> {
    return getProjectDeployment(this.projectState(), context, companyId, projectId, deploymentId);
  }

    async updateProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string, patch: Partial<ProjectDeployment>): Promise<ProjectDeployment> {
    return updateProjectDeployment(this.projectState(), context, companyId, projectId, deploymentId, patch);
  }

    async createProjectQaReport(context: AuthContext, companyId: string, projectId: string, input: CreateProjectQaReportInput): Promise<ProjectQaReport> {
    return createProjectQaReport(this.projectState(), context, companyId, projectId, input);
  }

  async listProjectQaReports(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectQaReport[]> {
    await this.getProject(context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    return structuredClone([...this.projectQaReports.values()]
      .filter((r) => r.workspaceId === context.workspaceId && r.companyId === companyId && r.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, safeLimit));
  }

    async getProjectQaReport(context: AuthContext, companyId: string, projectId: string, reportId: string): Promise<ProjectQaReport | null> {
    return getProjectQaReport(this.projectState(), context, companyId, projectId, reportId);
  }

  async getLatestProjectQaReport(context: AuthContext, companyId: string, projectId: string): Promise<ProjectQaReport | null> {
    const list = await this.listProjectQaReports(context, companyId, projectId, 1);
    return list[0] ?? null;
  }

  async getCompanyAgent(context: AuthContext, companyId: string, agentId: string) {
    return this.assertCompanyAgent(context, companyId, agentId);
  }

  async createCompanyAgent(context: AuthContext, companyId: string, input: CompanyAgentInput, idempotencyKey: string) {
    this.assertCompany(context, companyId);
    const requestKey = `${context.workspaceId}:${companyId}:${idempotencyKey}`;
    const existingId = this.companyAgentCreateRequests.get(requestKey);
    if (existingId) return this.assertCompanyAgent(context, companyId, existingId);
    if (!input.name?.trim() || !input.role?.trim()) throw new Error("Agent name and role are required");
    const timestamp = now();
    const agent: CompanyAgent = {
      id: randomUUID(), workspaceId: context.workspaceId, companyId, name: input.name.trim(), role: input.role.trim(),
      description: input.description, systemInstruction: input.systemInstruction, promptGuidelines: input.promptGuidelines,
      recommendedPrompts: input.recommendedPrompts ?? [], modelId: input.modelId, fallbackModelId: input.fallbackModelId,
      tools: input.tools ?? [], isActive: input.isActive ?? true, positionX: input.positionX, positionY: input.positionY,
      sortOrder: input.sortOrder ?? 0, revision: 1, createdAt: timestamp, updatedAt: timestamp,
    };
    this.companyAgents.set(agent.id, agent);
    this.companyAgentCreateRequests.set(requestKey, agent.id);
    return agent;
  }

  async updateCompanyAgent(context: AuthContext, companyId: string, agentId: string, input: Partial<CompanyAgentInput>, expectedRevision: number) {
    const current = this.assertCompanyAgent(context, companyId, agentId);
    if (current.revision !== expectedRevision) throw new Error("Agent was changed by another request. Reload and try again.");
    const updated = { ...current, ...input, name: input.name?.trim() ?? current.name, role: input.role?.trim() ?? current.role,
      revision: current.revision + 1, updatedAt: now() };
    if (!updated.name || !updated.role) throw new Error("Agent name and role are required");
    this.companyAgents.set(agentId, updated);
    return updated;
  }

  async deleteCompanyAgent(context: AuthContext, companyId: string, agentId: string, expectedRevision: number) {
    const company = this.assertCompany(context, companyId);
    const agent = this.companyAgents.get(agentId);
    if (!agent || agent.workspaceId !== context.workspaceId || agent.companyId !== companyId) return false;
    if (agent.revision !== expectedRevision) throw new Error("Agent was changed by another request. Reload and try again.");
    this.companyAgents.delete(agentId);
    for (const [id, edge] of this.companyEdges) if (edge.parentAgentId === agentId || edge.childAgentId === agentId) this.companyEdges.delete(id);
    if (company.mainAgentId === agentId) this.companies.set(companyId, { ...company, mainAgentId: undefined, revision: company.revision + 1, updatedAt: now() });
    return true;
  }

  async listCompanyAgentEdges(context: AuthContext, companyId: string, agentIds?: string[]) {
    this.assertCompany(context, companyId);
    const filter = agentIds?.length ? new Set(agentIds) : null;
    return [...this.companyEdges.values()].filter((edge) => edge.workspaceId === context.workspaceId && edge.companyId === companyId
      && (!filter || filter.has(edge.parentAgentId) || filter.has(edge.childAgentId)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

    async setCompanyAgentParent(context: AuthContext, companyId: string, childAgentId: string, parentAgentId: string | null) {
    return setCompanyAgentParent(this.goalState(), context, companyId, childAgentId, parentAgentId);
  }

  async createCompanyAgentRun(context: AuthContext, companyId: string, input: { task: string; requestedMode: "auto" | "single" | "pipeline" | "fusion"; projectId?: string }, idempotencyKey: string) {
    const company = this.assertCompany(context, companyId);
    if (!company.mainAgentId) throw new Error("Select an active Main Agent before running the company");
    const mainAgent = this.assertCompanyAgent(context, companyId, company.mainAgentId);
    if (!mainAgent.isActive) throw new Error("The Main Agent is inactive");
    const task = input.task?.trim();
    if (!task) throw new Error("Company task is required");
    const requestKey = `${context.workspaceId}:${companyId}:${context.userId}:${idempotencyKey}`;
    const existingId = this.companyRunRequests.get(requestKey);
    if (existingId) return { run: structuredClone(this.companyRuns.get(existingId)!), created: false };
    const timestamp = now();
    const run: CompanyAgentRun = {
      id: randomUUID(), workspaceId: context.workspaceId, companyId, projectId: input.projectId, userId: context.userId,
      mainAgentId: mainAgent.id, idempotencyKey, task, requestedMode: input.requestedMode,
      status: "queued", selectedAgentIds: [], cancelRequested: false, attemptCount: 0, maxAttempts: 3,
      contextSnapshot: {
        contextType: "company",
        workspaceId: context.workspaceId,
        userId: context.userId,
        companyId,
        businessId: null,
        agentId: mainAgent.id,
        companyRevision: company.revision,
        capturedAt: timestamp,
      },
      nextAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
    };
    this.companyRuns.set(run.id, run);
    this.companyRunRequests.set(requestKey, run.id);
    return { run: structuredClone(run), created: true };
  }

  async listCompanyAgentRuns(context: AuthContext, companyId: string, limit = 50, filter?: { projectId?: string }) {
    this.assertCompany(context, companyId);
    return Array.from(this.companyRuns.values())
      .filter((r) => r.workspaceId === context.workspaceId && r.companyId === companyId && (!filter?.projectId || r.projectId === filter.projectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map((r) => structuredClone(r));
  }

  async listProjectRuns(context: AuthContext, companyId: string, projectId: string, limit = 50) {
    return this.listCompanyAgentRuns(context, companyId, limit, { projectId });
  }

  async getCompanyAgentRun(context: AuthContext, companyId: string, runId: string) {
    this.assertCompany(context, companyId);
    const run = this.companyRuns.get(runId);
    if (!run || run.workspaceId !== context.workspaceId || run.companyId !== companyId || run.userId !== context.userId) {
      throw new WorkspaceAccessError("Agent run is not available in this company");
    }
    const completionStatus = run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? run.status : undefined;
    return {
      run: structuredClone(run),
      steps: [...this.companyRunSteps.values()].filter((step) => step.runId === runId).sort((a, b) => a.stepOrder - b.stepOrder || a.lane - b.lane),
      toolAudit: [...this.companyToolAudit.values()].filter((entry) => entry.runId === runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),

      backgroundEvents: [...this.companyRunEvents.values()].filter((entry) => entry.runId === runId),
      completionReport: completionStatus && run.completedAt ? { runId: run.id, companyId: run.companyId, status: completionStatus,
        result: run.result, errorCode: run.errorCode, errorMessage: run.errorMessage, workerId: run.workerId,
        attemptCount: run.attemptCount, totalCost: run.totalCost ?? 0, totalTokens: run.totalTokens ?? 0,
        totalDurationMs: run.totalDurationMs ?? 0, completedAt: run.completedAt } : undefined,
    };
  }

  async getCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string): Promise<unknown | null> {
    await this.getCompanyAgentRun(context, companyId, runId);
    const plan = this.companyRunPendingPlans.get(runId);
    return plan === undefined ? null : structuredClone(plan);
  }
  async setCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string, plan: unknown | null): Promise<void> {
    await this.getCompanyAgentRun(context, companyId, runId);
    if (plan === null) this.companyRunPendingPlans.delete(runId);
    else this.companyRunPendingPlans.set(runId, structuredClone(plan));
  }
  async updateCompanyAgentRun(context: AuthContext, companyId: string, runId: string, patch: Partial<CompanyAgentRun>) {
    const { run } = await this.getCompanyAgentRun(context, companyId, runId);
    const timestamp = now();
    const terminal = patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled";
    const started = patch.status === "planning" || patch.status === "running";
    const updated: CompanyAgentRun = {
      ...run, ...patch,
      startedAt: started ? run.startedAt ?? timestamp : run.startedAt,
      completedAt: terminal ? timestamp : started || patch.status === "awaiting_approval" ? undefined : run.completedAt,
      updatedAt: timestamp,
    };
    this.companyRuns.set(runId, updated);
    return structuredClone(updated);
  }

  async replaceCompanyAgentRunSteps(context: AuthContext, companyId: string, runId: string, steps: Array<Pick<CompanyAgentRunStep, "agentId" | "stepOrder" | "lane" | "role" | "status" | "modelId">>) {
    await this.getCompanyAgentRun(context, companyId, runId);
    const unique = new Set(steps.map((step) => step.agentId));
    if (unique.size !== steps.length) throw new Error("A run cannot contain the same agent twice");
    for (const agentId of unique) this.assertCompanyAgent(context, companyId, agentId);
    for (const [id, step] of this.companyRunSteps) if (step.runId === runId) this.companyRunSteps.delete(id);
    const timestamp = now();
    return steps.map((step) => {
      const row: CompanyAgentRunStep = { id: randomUUID(), workspaceId: context.workspaceId, companyId, runId,
        ...step, createdAt: timestamp, updatedAt: timestamp };
      this.companyRunSteps.set(row.id, row);
      return structuredClone(row);
    });
  }

  async appendCompanyAgentToolAudit(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentToolAudit, "agentId" | "toolName" | "decision" | "status" | "inputSummary" | "errorMessage"> & Partial<Pick<CompanyAgentToolAudit, "latencyMs" | "cost" | "tokens" | "reasonCode" | "sequenceNumber">>) {
    await this.getCompanyAgentRun(context, companyId, runId);
    this.assertCompanyAgent(context, companyId, entry.agentId);
    const terminal = entry.status === "succeeded" || entry.status === "failed" || entry.status === "blocked";
    const timestamp = now();
    const row: CompanyAgentToolAudit = { id: randomUUID(), workspaceId: context.workspaceId, companyId, runId,
      ...entry, createdAt: timestamp, completedAt: terminal ? timestamp : undefined };
    this.companyToolAudit.set(row.id, row);
    return structuredClone(row);
  }

  async appendCompanyAgentRunEvent(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentRunEvent, "eventKey" | "eventType" | "runStatus" | "message"> & Partial<Pick<CompanyAgentRunEvent, "workerId" | "attemptCount" | "details">>) {
    const { run } = await this.getCompanyAgentRun(context, companyId, runId);
    const existing = [...this.companyRunEvents.values()].find((item) => item.runId === runId && item.eventKey === entry.eventKey);
    if (existing) return structuredClone(existing);
    const row: CompanyAgentRunEvent = { id: randomUUID(), workspaceId: context.workspaceId, companyId, runId,
      eventKey: entry.eventKey, eventType: entry.eventType, runStatus: entry.runStatus, workerId: entry.workerId,
      attemptCount: entry.attemptCount ?? run.attemptCount, message: entry.message.slice(0, 1000),
      details: structuredClone(entry.details ?? {}), createdAt: now() };
    this.companyRunEvents.set(row.id, row);
    return structuredClone(row);
  }

  async claimCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) {
    const { run } = await this.getCompanyAgentRun(context, companyId, runId);
    const stale = run.leaseExpiresAt != null && Date.parse(run.leaseExpiresAt) < Date.now();
    if (run.cancelRequested || run.attemptCount >= run.maxAttempts || Date.parse(run.nextAttemptAt) > Date.now()
      || (run.status !== "queued" && !(["planning","running"].includes(run.status) && stale))) return false;
    await this.updateCompanyAgentRun(context, companyId, runId, { status: "planning", workerId,
      attemptCount: run.attemptCount + 1, lastHeartbeatAt: now(), leaseExpiresAt: new Date(Date.now()+leaseMs).toISOString() });
    return true;
  }
  async heartbeatCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) {
    const { run } = await this.getCompanyAgentRun(context, companyId, runId);
    if (run.workerId !== workerId || run.cancelRequested || !["planning","running"].includes(run.status)) return false;
    await this.updateCompanyAgentRun(context, companyId, runId, { lastHeartbeatAt: now(), leaseExpiresAt: new Date(Date.now()+leaseMs).toISOString() });
    return true;
  }
  async requeueCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, delayMs: number) {
    const { run } = await this.getCompanyAgentRun(context, companyId, runId);
    if (run.workerId !== workerId || run.cancelRequested || run.attemptCount >= run.maxAttempts) return false;
    await this.updateCompanyAgentRun(context, companyId, runId, { status: "queued", workerId: undefined,
      leaseExpiresAt: undefined, nextAttemptAt: new Date(Date.now()+delayMs).toISOString() });
    return true;
  }
  async listRecoverableCompanyAgentRuns(limit = 200) {
    return [...this.companyRuns.values()].filter((run) => !run.cancelRequested && run.attemptCount < run.maxAttempts
      && Date.parse(run.nextAttemptAt) <= Date.now() && (run.status === "queued"
        || (["planning","running"].includes(run.status) && run.leaseExpiresAt != null && Date.parse(run.leaseExpiresAt) < Date.now())))
      .slice(0,limit).map((run) => ({ context: { workspaceId: run.workspaceId,userId: run.userId,
        permissions: ["workspace:read","business:manage"] }, companyId: run.companyId, runId: run.id }));
  }

    async listGoals(context: AuthContext, businessId: string) {
    return listGoals(this.goalState(), context, businessId);
  }

  async listUserGoals(context: AuthContext) {
    await this.ensure(context);
    const userBusinessIds = new Set(
      [...this.businesses.values()]
        .filter((b) => b.workspaceId === context.workspaceId && b.ownerUserId === context.userId)
        .map((b) => b.id)
    );
    return [...this.goals.values()]
      .filter((goal) => goal.workspaceId === context.workspaceId && (goal.createdByUserId === context.userId || userBusinessIds.has(goal.businessId)))
      .sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt));
  }

    async createGoal(context: AuthContext, businessId: string, input: GoalInput) {
    return createGoal(this.goalState(), context, businessId, input);
  }

  async linkGoal(context: AuthContext, businessId: string, goalId: string) {
    this.assertBusiness(context, businessId);
    const goal = this.goals.get(goalId);
    if (!goal || goal.workspaceId !== context.workspaceId) throw new WorkspaceAccessError("Goal not found");
    const updated = { ...goal, businessId, updatedAt: now() };
    this.goals.set(goalId, updated);
    return updated;
  }

    async updateGoal(context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>) {
    return updateGoal(this.goalState(), context, businessId, goalId, input);
  }

    async deleteGoal(context: AuthContext, businessId: string, goalId: string) {
    return deleteGoal(this.goalState(), context, businessId, goalId);
  }

    async listMemory(context: AuthContext, businessId: string, query = "", limit = 100) {
    return listMemory(this.goalState(), context, businessId, query, limit);
  }

  async listUserMemories(context: AuthContext, query = "", limit = 100) {
    await this.ensure(context);
    const userBusinessIds = new Set(
      [...this.businesses.values()]
        .filter((b) => b.workspaceId === context.workspaceId && b.ownerUserId === context.userId)
        .map((b) => b.id)
    );
    const needle = query.trim().toLowerCase();
    return [...this.memories.values()]
      .filter((item) => item.workspaceId === context.workspaceId && (item.userId === context.userId || userBusinessIds.has(item.businessId)) && (!needle || `${item.type} ${item.title} ${item.content}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

    async createMemory(context: AuthContext, businessId: string, input: MemoryInput) {
    return createMemory(this.goalState(), context, businessId, input);
  }

  async linkMemory(context: AuthContext, businessId: string, memoryId: string) {
    this.assertBusiness(context, businessId);
    const memory = this.memories.get(memoryId);
    if (!memory || memory.workspaceId !== context.workspaceId) throw new WorkspaceAccessError("Memory not found");
    const updated = { ...memory, businessId, updatedAt: now() };
    this.memories.set(memoryId, updated);
    return updated;
  }

    async updateMemory(context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>) {
    return updateMemory(this.goalState(), context, businessId, memoryId, input);
  }

  async deleteMemory(context: AuthContext, businessId: string, memoryId: string) {
    await this.updateMemory(context, businessId, memoryId, {});
    return this.memories.delete(memoryId);
  }

  async listConversations(context: AuthContext, businessId: string) {
    this.assertBusiness(context, businessId);
    return [...this.conversations.values()].filter((item) => item.workspaceId === context.workspaceId && item.businessId === businessId && item.userId === context.userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createConversation(context: AuthContext, businessId: string, title: string) {
    this.assertBusiness(context, businessId);
    const timestamp = now();
    const conversation: Conversation = { id: randomUUID(), workspaceId: context.workspaceId, businessId, userId: context.userId, title: title.trim().slice(0, 120) || "New conversation", createdAt: timestamp, updatedAt: timestamp };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async getConversation(context: AuthContext, businessId: string, conversationId: string) {
    this.assertBusiness(context, businessId);
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.workspaceId !== context.workspaceId || conversation.businessId !== businessId || conversation.userId !== context.userId) throw new WorkspaceAccessError("Conversation is not available for this business");
    const messages = [...this.messages.values()].filter((item) => item.conversationId === conversationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { conversation, messages };
  }

  async updateConversation(context: AuthContext, businessId: string, conversationId: string, title: string) {
    const { conversation } = await this.getConversation(context, businessId, conversationId);
    const updated = { ...conversation, title: title.trim().slice(0, 120) || "New conversation", updatedAt: now() };
    this.conversations.set(conversationId, updated);
    return updated;
  }

  async deleteConversation(context: AuthContext, businessId: string, conversationId: string) {
    await this.getConversation(context, businessId, conversationId);
    for (const [messageId, message] of this.messages) {
      if (message.conversationId === conversationId) this.messages.delete(messageId);
    }
    return this.conversations.delete(conversationId);
  }

  async appendMessage(context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string) {
    const { conversation } = await this.getConversation(context, businessId, conversationId);
    const message: ConversationMessage = { id: randomUUID(), conversationId, role, content, createdAt: now() };
    this.messages.set(message.id, message);
    this.conversations.set(conversationId, { ...conversation, updatedAt: message.createdAt });
    return message;
  }

  async listNeutralConversations(context: AuthContext) {
    await this.ensure(context);
    return [...this.conversations.values()].filter((item) => item.workspaceId === context.workspaceId && item.businessId === null && item.userId === context.userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createNeutralConversation(context: AuthContext, title: string) {
    await this.ensure(context);
    const timestamp = now();
    const conversation: Conversation = { id: randomUUID(), workspaceId: context.workspaceId, businessId: null, userId: context.userId, title: title.trim().slice(0, 120) || "New conversation", createdAt: timestamp, updatedAt: timestamp };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async getNeutralConversation(context: AuthContext, conversationId: string) {
    await this.ensure(context);
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.workspaceId !== context.workspaceId || conversation.businessId !== null || conversation.userId !== context.userId) throw new WorkspaceAccessError("Conversation is not available to this user");
    const messages = [...this.messages.values()].filter((item) => item.conversationId === conversationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { conversation, messages };
  }

  async updateNeutralConversation(context: AuthContext, conversationId: string, title: string) {
    const { conversation } = await this.getNeutralConversation(context, conversationId);
    const updated = { ...conversation, title: title.trim().slice(0, 120) || "New conversation", updatedAt: now() };
    this.conversations.set(conversationId, updated);
    return updated;
  }

  async deleteNeutralConversation(context: AuthContext, conversationId: string) {
    await this.getNeutralConversation(context, conversationId);
    for (const [messageId, message] of this.messages) if (message.conversationId === conversationId) this.messages.delete(messageId);
    return this.conversations.delete(conversationId);
  }

  async appendNeutralMessage(context: AuthContext, conversationId: string, role: ConversationMessage["role"], content: string) {
    const { conversation } = await this.getNeutralConversation(context, conversationId);
    const message: ConversationMessage = { id: randomUUID(), conversationId, role, content, createdAt: now() };
    this.messages.set(message.id, message);
    this.conversations.set(conversationId, { ...conversation, updatedAt: message.createdAt });
    return message;
  }

  private hydrateOnboarding(row: Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">): BusinessOnboardingSession {
    const flow = ONBOARDING_FLOWS[row.scenario];
    const legacy = row.currentStep > 0 && !row.completedFields.some((field) => field === "businessSnapshot" || field === "businessGoal");
    const currentStep = legacy && row.status === "active" ? 1 : row.currentStep;
    const completedFields = legacy && row.status === "active" ? ["businessSnapshot"] : row.completedFields;
    return { ...row, currentStep, completedFields, business: this.businesses.get(row.businessId)!, totalFields: flow.length, currentField: flow[currentStep]?.field };
  }

  async listOnboardings(context: AuthContext) {
    await this.ensure(context);
    return [...this.onboardings.values()]
      .filter((item) => item.workspaceId === context.workspaceId && item.userId === context.userId && item.status !== "completed")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((row) => this.hydrateOnboarding(row));
  }

  async getOnboarding(context: AuthContext, businessId?: string) {
    const rows = await this.listOnboardings(context);
    return rows.find((row) => !businessId || row.businessId === businessId) ?? null;
  }

  private async getOnboardingSession(context: AuthContext, sessionId: string) {
    const rows = await this.listOnboardings(context);
    return rows.find((row) => row.id === sessionId) ?? null;
  }

  async startOnboarding(context: AuthContext, scenario: OnboardingScenario, options?: { forceNew?: boolean }) {
    const existing = options?.forceNew ? null : await this.getOnboarding(context);
    if (existing) return this.setOnboardingStatus(context, existing.id, "active");
    const timestamp = now();
    const placeholder = onboardingPlaceholder(scenario);
    const business: Business = {
      id: randomUUID(), workspaceId: context.workspaceId, ownerUserId: context.userId,
      ...placeholder, activationStatus: "draft", createdAt: timestamp, updatedAt: timestamp,
    };
    this.businesses.set(business.id, business);
    const conversation: Conversation = {
      id: randomUUID(), workspaceId: context.workspaceId, businessId: business.id, userId: context.userId,
      title: "Business setup", createdAt: timestamp, updatedAt: timestamp,
    };
    this.conversations.set(conversation.id, conversation);
    const row: Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField"> = {
      id: randomUUID(), workspaceId: context.workspaceId, userId: context.userId, businessId: business.id,
      conversationId: conversation.id, scenario, status: "active", currentStep: 0,
      completedFields: [], skippedFields: [], createdAt: timestamp, updatedAt: timestamp,
    };
    this.onboardings.set(row.id, row);
    return this.hydrateOnboarding(row);
  }

  async advanceOnboarding(context: AuthContext, sessionId: string, input: { value?: string; skip?: boolean; businessPatch?: Partial<BusinessInput> }) {
    const current = await this.getOnboardingSession(context, sessionId);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    const step = ONBOARDING_FLOWS[current.scenario][current.currentStep];
    if (!step) return current;
    if (!input.skip) {
      const value = input.value?.trim();
      if (!value) throw new Error("An answer is required or this step can be skipped");
      const stepPatch = step.field === "businessSnapshot" ? input.businessPatch ?? {} : step.field === "businessGoal" ? {} : onboardingBusinessPatch(step.field, value);
      const business = { ...current.business, ...stepPatch, updatedAt: now() };
      this.businesses.set(business.id, business);
    }
    const nextStep = current.currentStep + 1;
    const row = this.onboardings.get(sessionId)!;
    const updated = {
      ...row, currentStep: nextStep,
      completedFields: input.skip ? current.completedFields : [...current.completedFields, step.field],
      skippedFields: input.skip ? [...current.skippedFields, step.field] : current.skippedFields,
      status: nextStep >= ONBOARDING_FLOWS[current.scenario].length ? "awaiting_confirmation" as const : "active" as const,
      updatedAt: now(),
    };
    this.onboardings.set(sessionId, updated);
    return this.hydrateOnboarding(updated);
  }

  async setOnboardingStatus(context: AuthContext, sessionId: string, status: "active" | "paused") {
    const current = await this.getOnboardingSession(context, sessionId);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    const row = { ...this.onboardings.get(sessionId)!, status, updatedAt: now() };
    this.onboardings.set(sessionId, row);
    return this.hydrateOnboarding(row);
  }

  async completeOnboarding(context: AuthContext, sessionId: string) {
    const current = await this.getOnboardingSession(context, sessionId);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    const business = { ...current.business, activationStatus: "active" as const, updatedAt: now() };
    this.businesses.set(business.id, business);
    const row = { ...this.onboardings.get(sessionId)!, status: "completed" as const, updatedAt: now() };
    this.onboardings.set(sessionId, row);
    this.current.set(`${context.workspaceId}:${context.userId}`, business.id);
    return this.hydrateOnboarding(row);
  }

  async getCompanyMembership(companyId: string, userId: string): Promise<CompanyMember | null> {
    return this.companyMembershipOps.getCompanyMembership(companyId, userId);
  }

  async listCompanyMembers(companyId: string): Promise<CompanyMember[]> {
    return this.companyMembershipOps.listCompanyMembers(companyId);
  }

  async countCompanyOwners(companyId: string): Promise<number> {
    return this.companyMembershipOps.countCompanyOwners(companyId);
  }

  async createCompanyInvite(input: CompanyInviteInput): Promise<CompanyInvite> {
    return this.companyMembershipOps.createCompanyInvite(input);
  }

  async findCompanyInviteByTokenHash(tokenHash: string): Promise<CompanyInvite | null> {
    return this.companyMembershipOps.findCompanyInviteByTokenHash(tokenHash);
  }

  async acceptCompanyInvite(input: AcceptCompanyInviteInput): Promise<CompanyMember> {
    return this.companyMembershipOps.acceptCompanyInvite(input);
  }

  async updateCompanyMemberRole(input: UpdateCompanyMemberRoleInput): Promise<CompanyMember> {
    return this.companyMembershipOps.updateCompanyMemberRole(input);
  }

  async removeCompanyMember(input: RemoveCompanyMemberInput): Promise<void> {
    return this.companyMembershipOps.removeCompanyMember(input);
  }

  private providerPolicyKey(companyId: string | null, providerId: string, modelPattern: string | null): string {
    return ruleProviderPolicyKey(companyId, providerId, modelPattern);
  }

  private assertValidProviderPolicy(input: UpsertProviderDataPolicyStoreInput): void {
    return ruleAssertValidProviderPolicy(input);
  }

  async getProviderDataPolicy(input: {
    companyId: string | null;
    providerId: string;
    modelPattern: string | null;
  }): Promise<ProviderDataPolicyRecord | null> {
    return structuredClone(
      this.providerDataPolicies.get(ruleProviderPolicyKey(input.companyId, input.providerId, input.modelPattern)) ?? null,
    );
  }

  async listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]> {
    return this.dataPolicyOps.listProviderDataPolicies(companyId);
  }

  async upsertProviderDataPolicy(input: UpsertProviderDataPolicyStoreInput): Promise<ProviderDataPolicyRecord> {
    return this.dataPolicyOps.upsertProviderDataPolicy(input);
  }

  async listProviderDataPolicyVersions(
    companyId: string | null,
    providerId?: string,
  ): Promise<ProviderDataPolicyVersionRecord[]> {
    return this.dataPolicyOps.listProviderDataPolicyVersions(companyId, providerId);
  }

    async getProjectDataPolicy(companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null> {
    return getProjectDataPolicy(this.projectState(), companyId, projectId);
  }

  async upsertProjectDataPolicy(input: UpsertProjectDataPolicyStoreInput): Promise<ProjectDataPolicyRecord> {
    return this.dataPolicyOps.upsertProjectDataPolicy(input);
  }

  private assertValidPathRule(rule: ProjectDataPolicyPathRule): ProjectDataPolicyPathRule {
    return ruleAssertValidPathRule(rule);
  }

  async grantHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    grantedBy: string;
    grantedAt: Date;
  }): Promise<ProviderHostedConsentRecord> {
    const record: ProviderHostedConsentRecord = {
      companyId: input.companyId,
      projectId: input.projectId,
      providerId: input.providerId,
      grantedBy: input.grantedBy,
      grantedAt: input.grantedAt,

      revokedAt: null,
    };
    this.hostedProviderConsent.set(`${input.companyId}\u0000${input.projectId}\u0000${input.providerId}`, record);
    return structuredClone(record);
  }

  async revokeHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    revokedAt: Date;
  }): Promise<ProviderHostedConsentRecord> {
    const key = `${input.companyId}\u0000${input.projectId}\u0000${input.providerId}`;
    const existing = this.hostedProviderConsent.get(key);
    if (!existing) {
      throw new ProviderDataPolicyStoreError("data_policy_not_found", "No hosted provider consent to revoke", {
        httpStatus: 404, details: { providerId: input.providerId },
      });
    }
    const record: ProviderHostedConsentRecord = { ...existing, revokedAt: input.revokedAt };
    this.hostedProviderConsent.set(key, record);
    return structuredClone(record);
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

  private findInviteByTokenHash(tokenHash: string): CompanyInvite | undefined {
    return this.companyMembershipOps.findInviteByTokenHash(tokenHash);
  }

  async createCodeRunState(input: CreateCodeRunStateInput): Promise<CodeRunStateRecord> {
    return this.codeRunOps.createCodeRunState(input);
  }

  async getCodeRunRequest(companyId: string, runId: string): Promise<CodeRunRequestRecord | null> {
    return this.codeRunOps.getCodeRunRequest(companyId, runId);
  }

  async applyCodeRunStateEvent(input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord> {
    return this.codeRunOps.applyCodeRunStateEvent(input);
  }

  async getCodeRunState(companyId: string, runId: string): Promise<CodeRunStateRecord | null> {
    return this.codeRunOps.getCodeRunState(companyId, runId);
  }

  async listStaleCodeRunStates(input: { now: Date; limit: number }): Promise<CodeRunStateRecord[]> {
    return this.codeRunOps.listStaleCodeRunStates(input);
  }

  async upsertCodeRunTurn(input: UpsertCodeRunTurnInput): Promise<CodeRunTurnRecord> {
    return this.codeRunOps.upsertCodeRunTurn(input);
  }

  async getCodeRunTurn(companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null> {
    return this.codeRunOps.getCodeRunTurn(companyId, runId, turnIndex);
  }

  async listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]> {
    return this.codeRunOps.listCodeRunTurns(companyId, runId);
  }

  async listCodeRunStates(input: ListCodeRunStatesInput): Promise<CodeRunStateRecord[]> {
    return this.codeRunOps.listCodeRunStates(input);
  }

  async listCodeRunStatesForScan(input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>> {
    return this.codeRunOps.listCodeRunStatesForScan(input);
  }

  async listCodeProjectRefs(input: CodeProjectRefScanInput): Promise<CodeProjectRefScanPage> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const newest = new Map<string, { companyId: string; projectId: string; lastSessionAt: string }>();
    for (const session of this.codeSessions.values()) {
      if (input.companyId !== null && session.companyId !== input.companyId) continue;
      const createdAt = typeof session.createdAt === "string" ? session.createdAt : new Date(String(session.createdAt)).toISOString();
      const key = `${session.companyId}:${session.projectId}`;
      const existing = newest.get(key);
      if (!existing || existing.lastSessionAt < createdAt) {
        newest.set(key, { companyId: session.companyId, projectId: session.projectId, lastSessionAt: createdAt });
      }
    }
    const ordered = [...newest.values()].sort((a, b) =>
      b.lastSessionAt.localeCompare(a.lastSessionAt) || a.projectId.localeCompare(b.projectId));
    const afterCursor = cursor
      ? ordered.filter((ref) => ref.lastSessionAt < cursor.startedAt
        || (ref.lastSessionAt === cursor.startedAt && ref.projectId > cursor.runId))
      : ordered;
    const page = afterCursor.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page as CodeProjectRef[],
      nextCursor: afterCursor.length > limit && last
        ? encodeCodeRunScanCursor({ startedAt: last.lastSessionAt, runId: last.projectId, turnIndex: 0 })
        : null,
    };
  }

    async getProjectForSystem(companyId: string, projectId: string): Promise<Project | null> {
    return getProjectForSystem(this.projectState(), companyId, projectId);
  }

  async listCodeRunTurnsForScan(input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>> {
    return this.codeRunOps.listCodeRunTurnsForScan(input);
  }

  private activeOwnerCount(companyId: string): number {
    return this.companyMembershipOps.activeOwnerCount(companyId);
  }

  private isLastActiveOwnerDemotion(member: CompanyMember, nextRole: string): boolean {
    return this.companyMembershipOps.isLastActiveOwnerDemotion(member, nextRole);
  }

  private isLastActiveOwner(member: CompanyMember): boolean {
    return this.companyMembershipOps.isLastActiveOwner(member);
  }

  async createExecutionSnapshot(input: CreateExecutionSnapshotInput): Promise<ExecutionSnapshotRecord> {
    return this.codeRunOps.createExecutionSnapshot(input);
  }

  async getExecutionSnapshot(companyId: string, snapshotId: string): Promise<ExecutionSnapshotRecord | null> {
    return this.codeRunOps.getExecutionSnapshot(companyId, snapshotId);
  }

  async getLatestSnapshotForSession(companyId: string, sessionId: string): Promise<ExecutionSnapshotRecord | null> {
    return this.codeRunOps.getLatestSnapshotForSession(companyId, sessionId);
  }

  async getSnapshotForRun(companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null> {
    return this.codeRunOps.getSnapshotForRun(companyId, runId);
  }

  async listExecutionSnapshots(input: ListExecutionSnapshotsInput): Promise<ExecutionSnapshotRecord[]> {
    return this.codeRunOps.listExecutionSnapshots(input);
  }

  diffExecutionSnapshots(a: ExecutionSnapshotRecord, b: ExecutionSnapshotRecord): ExecutionSnapshotDiff {
    const { changes, unchanged } = diffSnapshotPayloads(a.payload, b.payload);
    return {
      fromSnapshotId: a.id, toSnapshotId: b.id,
      fromVersion: a.snapshotVersion, toVersion: b.snapshotVersion,
      changes, unchanged,
    };
  }

  async createSnapshotConfigVersion(input: CreateSnapshotConfigVersionInput): Promise<SnapshotConfigVersionRecord> {
    return this.codeRunOps.createSnapshotConfigVersion(input);
  }

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

  async listSnapshotConfigVersions(companyId: string, kind: SnapshotConfigKind): Promise<SnapshotConfigVersionRecord[]> {
    return this.codeRunOps.listSnapshotConfigVersions(companyId, kind);
  }

  async createCodeUserQuestion(input: CreateCodeUserQuestionInput): Promise<CodeUserQuestionRecord> {
    return this.codeUserQuestionState.createQuestion(input);
  }

  async getCodeUserQuestion(companyId: string, questionId: string): Promise<CodeUserQuestionRecord | null> {
    return this.codeUserQuestionState.getQuestion(companyId, questionId);
  }

  async getPendingCodeUserQuestionForRun(companyId: string, runId: string): Promise<CodeUserQuestionRecord | null> {
    return this.codeUserQuestionState.getPendingQuestionForRun(companyId, runId);
  }

  async answerCodeUserQuestion(input: AnswerCodeUserQuestionInput): Promise<CodeUserQuestionRecord> {
    return this.codeUserQuestionState.answerQuestion(input);
  }

  async expireCodeUserQuestions(input: { now?: Date; companyId?: string; runId?: string } = {}): Promise<number> {
    return this.codeUserQuestionState.expireQuestions(input);
  }

  async listExpiredCodeUserQuestions(input: { now?: Date; limit?: number } = {}): Promise<CodeUserQuestionRecord[]> {
    return this.codeUserQuestionState.listExpiredQuestions(input);
  }

  async cancelPendingCodeUserQuestions(input: { companyId: string; runId: string; now?: Date }): Promise<number> {
    return this.codeUserQuestionState.cancelPendingQuestions(input);
  }

  async getCodeSessionHead(companyId: string, sessionId: string): Promise<CodeSessionHeadRecord | null> {
    return this.codeSessionDurabilityState.getHead(companyId, sessionId);
  }

  async setCodeSessionHead(input: SetCodeSessionHeadInput): Promise<CodeSessionHeadRecord> {
    return this.codeSessionDurabilityState.setHead(input);
  }

  async createCodeRunRecoveryNotice(input: CreateCodeRunRecoveryNoticeInput): Promise<CodeRunRecoveryNoticeRecord> {
    return this.codeSessionDurabilityState.createNotice(input);
  }

  async getLatestCodeRunRecoveryNotice(companyId: string, runId: string): Promise<CodeRunRecoveryNoticeRecord | null> {
    return this.codeSessionDurabilityState.getLatestNotice(companyId, runId);
  }

  async listCodeRunRecoveryNotices(input: { companyId: string; runId: string; limit?: number }): Promise<CodeRunRecoveryNoticeRecord[]> {
    return this.codeSessionDurabilityState.listNotices(input);
  }

  async createCodeSessionRewind(input: CreateCodeSessionRewindInput): Promise<{ record: CodeSessionRewindRecord; replayed: boolean }> {
    return this.codeSessionDurabilityState.createRewind(input);
  }

  async getCodeSessionRewind(companyId: string, operationId: string): Promise<CodeSessionRewindRecord | null> {
    return this.codeSessionDurabilityState.getRewind(companyId, operationId);
  }

  async reopenCodeSessionRewind(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionRewindRecord | null; reopened: boolean }> {
    return this.codeSessionDurabilityState.reopenRewind(input);
  }

  async completeCodeSessionRewind(input: CompleteCodeSessionRewindInput): Promise<CodeSessionRewindRecord> {
    return this.codeSessionDurabilityState.completeRewind(input);
  }

  async listCodeSessionRewinds(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionRewindRecord[]> {
    return this.codeSessionDurabilityState.listRewinds(input);
  }

  async createCodeSessionFork(input: CreateCodeSessionForkInput): Promise<{ record: CodeSessionForkRecord; replayed: boolean }> {
    return this.codeSessionDurabilityState.createFork(input);
  }

  async getCodeSessionFork(companyId: string, operationId: string): Promise<CodeSessionForkRecord | null> {
    return this.codeSessionDurabilityState.getFork(companyId, operationId);
  }

  async completeCodeSessionFork(input: CompleteCodeSessionForkInput): Promise<CodeSessionForkRecord> {
    return this.codeSessionDurabilityState.completeFork(input);
  }

  async listCodeSessionForks(input: { companyId: string; parentSessionId: string; limit?: number }): Promise<CodeSessionForkRecord[]> {
    return this.codeSessionDurabilityState.listForks(input);
  }

  async reopenCodeSessionFork(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionForkRecord | null; reopened: boolean }> {
    return this.codeSessionDurabilityState.reopenFork(input);
  }

  async createCodeGoal(input: CreateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    return this.codeGoalState.createGoal(input);
  }

  async getCodeGoal(companyId: string, goalId: string): Promise<CodeGoalWithCriteria | null> {
    return this.codeGoalState.getGoal(companyId, goalId);
  }

  async listCodeGoals(input: { companyId: string; sessionId?: string; projectId?: string; limit?: number }): Promise<CodeGoalRecord[]> {
    return this.codeGoalState.listGoals(input);
  }

  async updateCodeGoal(input: UpdateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    return this.codeGoalState.updateGoal(input);
  }

  async setCodeGoalCriterionStatus(input: SetCodeGoalCriterionStatusInput): Promise<CodeGoalWithCriteria> {
    return this.codeGoalState.setCriterionStatus(input);
  }

  async createCodeSessionPlan(input: CreateCodeSessionPlanInput): Promise<CodeSessionPlanRecord> {
    return this.codeGoalState.createPlan(input);
  }

  async getLatestCodeSessionPlan(companyId: string, sessionId: string): Promise<CodeSessionPlanRecord | null> {
    return this.codeGoalState.getLatestPlan(companyId, sessionId);
  }

  async listCodeSessionPlans(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionPlanRecord[]> {
    return this.codeGoalState.listPlans(input);
  }

  async decideCodeSessionPlan(input: DecideCodeSessionPlanInput): Promise<CodeSessionPlanRecord> {
    return this.codeGoalState.decidePlan(input);
  }

  async replaceCodeSessionTodos(input: ReplaceCodeSessionTodosInput): Promise<CodeSessionTodoRecord[]> {
    return this.codeGoalState.replaceTodos(input);
  }

  async listCodeSessionTodos(input: { companyId: string; sessionId: string }): Promise<CodeSessionTodoRecord[]> {
    return this.codeGoalState.listTodos(input.companyId, input.sessionId);
  }

  async createCodeContextSummary(input: CreateCodeContextSummaryInput): Promise<CodeContextSummaryRecord> {
    return this.codeRunOps.createCodeContextSummary(input);
  }

  async listCodeContextSummaries(input: ListCodeContextSummariesInput): Promise<CodeContextSummaryRecord[]> {
    return this.codeRunOps.listCodeContextSummaries(input);
  }

  async createCodeActivityEvent(input: CreateCodeActivityEventInput): Promise<CodeActivityEventRecord> {
    return this.codeRunOps.createCodeActivityEvent(input);
  }

  async listCodeActivityEvents(input: ListCodeActivityEventsInput): Promise<CodeActivityEventRecord[]> {
    return this.codeRunOps.listCodeActivityEvents(input);
  }

  async createReplayBundle(input: CreateReplayBundleInput): Promise<ReplayBundleRecord> {
    return this.codeRunOps.createReplayBundle(input);
  }

  async getReplayBundle(companyId: string, runId: string, bundleVersion?: number): Promise<ReplayBundleRecord | null> {
    return this.codeRunOps.getReplayBundle(companyId, runId, bundleVersion);
  }

  async getReplayBundleById(companyId: string, bundleId: string): Promise<ReplayBundleRecord | null> {
    return this.codeRunOps.getReplayBundleById(companyId, bundleId);
  }

  async listReplayBundles(input: ListReplayBundlesInput): Promise<ReplayBundleRecord[]> {
    return this.codeRunOps.listReplayBundles(input);
  }

  async listReplayBundleSteps(companyId: string, bundleId: string): Promise<ReplayBundleStepRecord[]> {
    return this.codeRunOps.listReplayBundleSteps(companyId, bundleId);
  }
}
