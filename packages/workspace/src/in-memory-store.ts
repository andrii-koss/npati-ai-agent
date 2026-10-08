import { randomUUID } from "node:crypto";
import { assertNoSecrets } from "@npati/memory";
import type { AuthContext, Business, BusinessInput, BusinessOnboardingSession, BusinessToCompanyInput, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentInput, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, CompanyInput, Project, ProjectCheckpoint, CreateCheckpointInput, ProjectDeployment, CreateDeploymentInput, ProjectQaReport, CreateProjectQaReportInput, ProjectInput, ProjectStatus, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview, WorkspaceStore, CodeSession, CodeSessionInput, CodeSessionStatus, ProjectCodeSettings, DataClassification, RetentionClass, AuditEntry, AuditEntryInput, AuditAnchor, AuditChainState, AuditChainVerification, FeatureFlag, FeatureFlagInput, FeatureFlagHistoryEntry, CodeToolManifest, SandboxImage, SandboxImageInput, SandboxImageVariant, CodeSessionMode, ProjectCodeTrust, ProjectCodeTrustInput, CodeApprovalRule, CodeApprovalRuleInput, CodeApprovalRuleScope,
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
// C9: goals, plan revisions and session todos — shared rule implementation for both backends.
import { InMemoryCodeGoalStore } from "./code-goal-store";
import {
  InMemoryCodeUserQuestionStore,
  type AnswerCodeUserQuestionInput,
  type CodeUserQuestionRecord,
  type CreateCodeUserQuestionInput,
} from "./code-question-store";
// C10: session durability — shared rule implementation for both backends.
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

const now = () => new Date().toISOString();
type StoredUserSetting = import('./types').UserSetting;
export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly identities = new Map<string, { displayName: string; workspaceName: string; role: string }>();
  private readonly businesses = new Map<string, Business>();
  private readonly companies = new Map<string, Company>();
  private readonly companyAgents = new Map<string, CompanyAgent>();
  private readonly projects = new Map<string, Project>();
  private readonly codeSessions = new Map<string, CodeSession>();
  private readonly projectCodeTrust = new Map<string, ProjectCodeTrust>();
  private readonly auditLog = new Map<string, AuditEntry[]>();
  private readonly auditAnchors = new Map<string, AuditAnchor[]>();
  private readonly featureFlags = new Map<string, FeatureFlag>();
  private readonly featureFlagHistory: FeatureFlagHistoryEntry[] = [];
  private readonly codeToolManifests = new Map<number, CodeToolManifest>();
  private readonly sandboxImages = new Map<string, SandboxImage>();
  private readonly codeApprovalRules = new Map<string, CodeApprovalRule>();
  // C5b: ProviderDataPolicy. Keys are tenant-scoped, and the empty-tenant marker keeps a platform default
  // (`companyId === null`) from ever colliding with a real company id, mirroring the SQL `COALESCE` index.
  private readonly providerDataPolicies = new Map<string, ProviderDataPolicyRecord>();
  private readonly providerDataPolicyVersions: ProviderDataPolicyVersionRecord[] = [];
  private readonly projectDataPolicies = new Map<string, ProjectDataPolicyRecord>();
  private readonly hostedProviderConsent = new Map<string, ProviderHostedConsentRecord>();
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
  // C5a: company membership. Members are keyed by (company, user) like the unique index in migration 072;
  // invites by id, with the token hash acting as the second unique key.
  private readonly companyMembers = new Map<string, CompanyMember>();
  private readonly companyInvites = new Map<string, CompanyInvite>();
  // C6a: run state. Runs are keyed by id (a run id is globally unique in the postgres table too); turns are
  // keyed by (run, turnIndex) exactly like the primary key of `code_run_turns`.
  private readonly codeRunStates = new Map<string, CodeRunStateRecord>();
  private readonly codeRunTurns = new Map<string, CodeRunTurnRecord>();
  // C10: the run's original request, keyed by run id like the row it belongs to. It is a separate map so the
  // lease/status reads (the reaper's scans) never carry prompt content, exactly as the Postgres backend keeps
  // the request columns out of its shared select list.
  private readonly codeRunRequests = new Map<string, CodeRunRequestRecord>();
  // C6b: append-only snapshots and config versions. Keyed by id; the session chain is derived on read.
  private readonly executionSnapshots = new Map<string, ExecutionSnapshotRecord>();
  private readonly snapshotConfigVersions = new Map<string, SnapshotConfigVersionRecord>();
  // C6b: durable Activity events. Append-only, keyed by id; reads sort newest first like the postgres index.
  private readonly codeActivityEvents = new Map<string, CodeActivityEventRecord>();
  // C8: durable context summaries. Append-only, keyed by id; reads sort newest first like the postgres index.
  private readonly codeContextSummaries = new Map<string, CodeContextSummaryRecord>();
  private readonly replayBundles = new Map<string, ReplayBundleRecord>();
  private readonly replayBundleSteps = new Map<string, ReplayBundleStepRecord[]>();
  // C9: goals, plan revisions and session todos. The rules live in `code-goal-store.ts` and are shared with the
  // Postgres backend, so "the database enforces it" cannot become "nothing enforces it" on this path.
  private readonly codeGoalState = new InMemoryCodeGoalStore();
  // C9: `code.ask_user`. Same rules as the Postgres backend — the answer validation lives in the shared module.
  private readonly codeUserQuestionState = new InMemoryCodeUserQuestionStore();
  // C10: the conversation cursor, the recovery notice and the two operation ledgers. Same rules as the Postgres
  // backend (claim-before-perform, one head per session, revision-checked), because a rule that holds only in
  // SQL stops holding on this path.
  private readonly codeSessionDurabilityState = new InMemoryCodeSessionDurabilityStore();

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
    this.assertCompany(context, companyId);
    const requestKey = [context.workspaceId, context.userId, companyId, idempotencyKey].join(":");
    const previous = this.projectCreateRequests.get(requestKey);
    if (previous) return { project: await this.getProject(context, companyId, previous), created: false };
    const timestamp = now();
    const project: Project = {
      id: randomUUID(), workspaceId: context.workspaceId, companyId, createdBy: context.userId,
      name: input.name, description: input.description, type: input.type ?? "website", status: "ready",
      dataBackendId: input.dataBackendId, appScheme: input.appScheme,
      toolchain: input.toolchain ?? null, defaultBranch: input.defaultBranch ?? null,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
      revision: 1, createdAt: timestamp, updatedAt: timestamp,
    };
    this.projects.set(project.id, project);
    this.projectCreateRequests.set(requestKey, project.id);
    return { project: structuredClone(project), created: true };
  }

  async listProjects(context: AuthContext, companyId: string, includeArchived = false) {
    this.assertCompany(context, companyId);
    return structuredClone([...this.projects.values()]
      .filter((project) => project.workspaceId === context.workspaceId && project.companyId === companyId
        && project.createdBy === context.userId && (includeArchived || project.status !== "archived"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
  }

  async getProject(context: AuthContext, companyId: string, projectId: string) {
    this.assertCompany(context, companyId);
    const project = this.projects.get(projectId);
    if (!project || project.workspaceId !== context.workspaceId || project.companyId !== companyId
      || project.createdBy !== context.userId) throw new WorkspaceNotFoundError("Project not found");
    return structuredClone(project);
  }

  async updateProject(context: AuthContext, companyId: string, projectId: string, input: { name?: string; expectedRevision: number; code?: ProjectCodeSettings }) {
    const project = await this.getProject(context, companyId, projectId);
    if (project.revision !== input.expectedRevision || project.status === "archived") throw new Error("Project changed by another request or is archived");
    const code = input.code ?? {};
    const next: Project = {
      ...project,
      name: input.name ?? project.name,
      toolchain: code.toolchain ?? project.toolchain ?? null,
      defaultBranch: code.defaultBranch ?? project.defaultBranch ?? null,
      dataClassification: code.dataClassification ?? project.dataClassification,
      retentionClass: code.retentionClass ?? project.retentionClass,
      revision: project.revision + 1, updatedAt: now(),
    };
    this.projects.set(projectId, next);
    return structuredClone(next);
  }

  // --- C1: code sessions -------------------------------------------------------------------

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
    const timestamp = now();
    const session: CodeSession = {
      id: randomUUID(), workspaceId: context.workspaceId, companyId, projectId, userId: context.userId,
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

  // --- C1c: append-only audit log ----------------------------------------------------------

  /**
   * Appends an audit entry, chaining it to the company's previous entry. Entries are stored frozen
   * and returned as clones: there is no update or delete path anywhere in the store, which is the
   * in-memory equivalent of the DB trigger used in PostgreSQL.
   */
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

  /** Background verifier path: no user context, workspace-scoped, hashes and counts only. */
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

  // --- C1a: feature flags and tool manifests ------------------------------------------------

  /**
   * Sets or updates a flag row and always appends a history entry, mirroring the SQL store. The
   * in-memory store is used by tests and local development, so it keeps identical semantics
   * (revision conflict -> WorkspaceAccessError, one row per scope + scopeId + flagKey).
   */
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

  // --- C5: scoped approval rules ------------------------------------------------------------

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
      // A session rule additionally requires its project to match: a session belongs to exactly one
      // project, so a session-scoped allowance must never leak into another project's requests.
      if (rule.scope === "session") {
        return Boolean(query.sessionId) && rule.sessionId === query.sessionId
          && Boolean(query.projectId) && rule.projectId === query.projectId;
      }
      return Boolean(query.projectId) && rule.projectId === query.projectId;
    });
    matches.sort((a, b) => (a.scope === b.scope ? b.createdAt.localeCompare(a.createdAt) : a.scope === "session" ? -1 : 1));
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  // --- C1b: sandbox image supply chain ------------------------------------------------------

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

  // --- C5: project trust ---------------------------------------------------------------------

  async getProjectCodeTrust(context: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null> {
    this.assertCompany(context, companyId);
    return structuredClone(this.projectCodeTrust.get(`${companyId}:${projectId}`) ?? null);
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

  async setProjectSandbox(context: AuthContext, companyId: string, projectId: string, sandboxId: string | null, expectedSandboxId: string | null) {
    const project = await this.getProject(context, companyId, projectId);
    if ((project.sandboxId ?? null) !== expectedSandboxId || project.status === "archived") throw new Error("Project sandbox changed by another request or is archived");
    const next: Project = { ...project, sandboxId: sandboxId ?? undefined, revision: project.revision + 1, updatedAt: now() };
    this.projects.set(projectId, next);
    return structuredClone(next);
  }
  async updateProjectRepository(context: AuthContext, companyId: string, projectId: string, input: { provider: string; url: string; branch: string }): Promise<Project> {
    const project = await this.getProject(context, companyId, projectId);
    if (project.status === "archived") throw new Error("Project is archived");
    const next = { ...project, repositoryProvider: input.provider, repositoryUrl: input.url, repositoryBranch: input.branch, revision: project.revision + 1, updatedAt: now() };
    this.projects.set(projectId, next);
    return structuredClone(next);
  }
  async updateProjectPreview(context: AuthContext, companyId: string, projectId: string, patch: { status?: ProjectStatus; previewUrl?: string | null; previewPort?: number | null; framework?: string | null; runtime?: string | null; lastBuildStatus?: string | null; deploymentUrl?: string | null; deploymentStatus?: string | null; lastDeploymentStatus?: string | null; lastDeployedAt?: string | null }) {
    const project = await this.getProject(context, companyId, projectId);
    if (project.status === "archived") throw new Error("Project is archived");
    const next: Project = {
      ...project,
      status: patch.status ?? project.status,
      previewUrl: patch.previewUrl !== undefined ? (patch.previewUrl ?? undefined) : project.previewUrl,
      previewPort: patch.previewPort !== undefined ? (patch.previewPort ?? undefined) : project.previewPort,
      framework: patch.framework !== undefined ? (patch.framework ?? undefined) : project.framework,
      runtime: patch.runtime !== undefined ? (patch.runtime ?? undefined) : project.runtime,
      lastBuildStatus: patch.lastBuildStatus !== undefined ? (patch.lastBuildStatus ?? undefined) : project.lastBuildStatus,
      deploymentUrl: patch.deploymentUrl !== undefined ? (patch.deploymentUrl ?? undefined) : project.deploymentUrl,
      deploymentStatus: patch.deploymentStatus !== undefined ? (patch.deploymentStatus ?? undefined) : (patch.lastDeploymentStatus !== undefined ? (patch.lastDeploymentStatus ?? undefined) : project.deploymentStatus),
      lastDeployedAt: patch.lastDeployedAt !== undefined ? (patch.lastDeployedAt ?? undefined) : (patch.deploymentUrl ? now() : project.lastDeployedAt),
      revision: project.revision + 1,
      updatedAt: now(),
    };
    this.projects.set(projectId, next);
    return structuredClone(next);
  }
  async archiveProject(context: AuthContext, companyId: string, projectId: string, expectedRevision: number) {
    const project = await this.getProject(context, companyId, projectId);
    if (project.revision !== expectedRevision || project.status === "archived") throw new Error("Project changed by another request or is archived");
    const next: Project = { ...project, status: "archived", revision: project.revision + 1, updatedAt: now() };
    this.projects.set(projectId, next);
    return structuredClone(next);
  }

  async deleteProject(context: AuthContext, companyId: string, projectId: string) {
    await this.getProject(context, companyId, projectId);
    for (const [key, id] of this.projectCreateRequests) if (id === projectId) this.projectCreateRequests.delete(key);
    for (const [id, chk] of this.projectCheckpoints) {
      if (chk.projectId === projectId && chk.companyId === companyId && chk.workspaceId === context.workspaceId) {
        this.projectCheckpoints.delete(id);
      }
    }
    for (const [id, dep] of this.projectDeployments) {
      if (dep.projectId === projectId && dep.companyId === companyId && dep.workspaceId === context.workspaceId) {
        this.projectDeployments.delete(id);
      }
    }
    for (const [id, rep] of this.projectQaReports) {
      if (rep.projectId === projectId && rep.companyId === companyId && rep.workspaceId === context.workspaceId) {
        this.projectQaReports.delete(id);
      }
    }
    return this.projects.delete(projectId);
  }

  async createProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, input: CreateCheckpointInput): Promise<ProjectCheckpoint> {
    await this.getProject(context, companyId, projectId);
    const checkpoint: ProjectCheckpoint = {
      id: `chk_${randomUUID()}`,
      workspaceId: context.workspaceId,
      companyId,
      projectId,
      userId: context.userId,
      name: input.name.trim(),
      description: input.description,
      commitHash: input.commitHash,
      trigger: input.trigger,
      runId: input.runId,
      fileCount: input.fileCount ?? 0,
      createdAt: now(),
    };
    this.projectCheckpoints.set(checkpoint.id, checkpoint);
    return structuredClone(checkpoint);
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
    await this.getProject(context, companyId, projectId);
    const checkpoint = this.projectCheckpoints.get(checkpointId);
    if (!checkpoint || checkpoint.workspaceId !== context.workspaceId || checkpoint.companyId !== companyId || checkpoint.projectId !== projectId) {
      throw new WorkspaceNotFoundError("Project checkpoint not found");
    }
    return structuredClone(checkpoint);
  }

  async deleteProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<boolean> {
    await this.getProject(context, companyId, projectId);
    const checkpoint = this.projectCheckpoints.get(checkpointId);
    if (!checkpoint || checkpoint.workspaceId !== context.workspaceId || checkpoint.companyId !== companyId || checkpoint.projectId !== projectId) {
      return false;
    }
    return this.projectCheckpoints.delete(checkpointId);
  }

  async createProjectDeployment(context: AuthContext, companyId: string, projectId: string, input: CreateDeploymentInput): Promise<ProjectDeployment> {
    await this.getProject(context, companyId, projectId);
    const deployment: ProjectDeployment = {
      id: `dep_${randomUUID()}`,
      workspaceId: context.workspaceId,
      companyId,
      projectId,
      userId: context.userId,
      provider: input.provider,
      environment: input.environment ?? "production",
      branch: input.branch ?? "project/main",
      commitHash: input.commitHash,
      status: input.status ?? "queued",
      targetUrl: input.targetUrl,
      externalDeploymentId: input.externalDeploymentId,
      preflightSummary: input.preflightSummary,
      errorMessage: input.errorMessage,
      runId: input.runId,
      createdAt: now(),
      updatedAt: now(),
    };
    this.projectDeployments.set(deployment.id, deployment);
    return structuredClone(deployment);
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
    await this.getProject(context, companyId, projectId);
    const deployment = this.projectDeployments.get(deploymentId);
    if (!deployment || deployment.workspaceId !== context.workspaceId || deployment.companyId !== companyId || deployment.projectId !== projectId) {
      return null;
    }
    return structuredClone(deployment);
  }

  async updateProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string, patch: Partial<ProjectDeployment>): Promise<ProjectDeployment> {
    await this.getProject(context, companyId, projectId);
    const current = this.projectDeployments.get(deploymentId);
    if (!current || current.workspaceId !== context.workspaceId || current.companyId !== companyId || current.projectId !== projectId) {
      throw new WorkspaceNotFoundError("Project deployment not found");
    }
    const updated: ProjectDeployment = {
      ...current,
      ...patch,
      id: current.id,
      workspaceId: current.workspaceId,
      companyId: current.companyId,
      projectId: current.projectId,
      updatedAt: now(),
    };
    this.projectDeployments.set(deploymentId, updated);
    return structuredClone(updated);
  }

  async createProjectQaReport(context: AuthContext, companyId: string, projectId: string, input: CreateProjectQaReportInput): Promise<ProjectQaReport> {
    await this.getProject(context, companyId, projectId);
    const report: ProjectQaReport = {
      id: `qa_${randomUUID()}`,
      workspaceId: context.workspaceId,
      companyId,
      projectId,
      userId: context.userId,
      status: input.status,
      targetUrl: input.targetUrl,
      summary: input.summary,
      issues: structuredClone(input.issues),
      metrics: structuredClone(input.metrics),
      screenshots: structuredClone(input.screenshots ?? []),
      runId: input.runId,
      createdAt: now(),
    };
    this.projectQaReports.set(report.id, report);
    return structuredClone(report);
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
    await this.getProject(context, companyId, projectId);
    const report = this.projectQaReports.get(reportId);
    if (!report || report.workspaceId !== context.workspaceId || report.companyId !== companyId || report.projectId !== projectId) {
      return null;
    }
    return structuredClone(report);
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
    this.assertCompanyAgent(context, companyId, childAgentId);
    if (parentAgentId === childAgentId) throw new Error("An agent cannot be its own parent");
    if (parentAgentId) this.assertCompanyAgent(context, companyId, parentAgentId);
    const old = [...this.companyEdges.entries()].find(([, edge]) => edge.companyId === companyId && edge.childAgentId === childAgentId);
    if (old) this.companyEdges.delete(old[0]);
    if (!parentAgentId) return null;
    const children = (id: string) => [...this.companyEdges.values()].filter((edge) => edge.companyId === companyId && edge.parentAgentId === id).map((edge) => edge.childAgentId);
    const pending = [childAgentId], visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === parentAgentId) {
        if (old) this.companyEdges.set(old[0], old[1]);
        throw new Error("Circular agent relationships are not allowed");
      }
      if (!visited.has(id)) { visited.add(id); pending.push(...children(id)); }
    }
    const edge: CompanyAgentEdge = { id: randomUUID(), workspaceId: context.workspaceId, companyId,
      parentAgentId, childAgentId, relationType: "reports_to", createdAt: now() };
    this.companyEdges.set(edge.id, edge);
    return edge;
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
      // Map iteration preserves append order. Do not use the random UUID as a
      // tie-breaker: multiple lifecycle events can share the same millisecond.
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
    this.assertBusiness(context, businessId);
    return [...this.goals.values()].filter((goal) => goal.workspaceId === context.workspaceId && goal.businessId === businessId).sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt));
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
    this.assertBusiness(context, businessId);
    const timestamp = now();
    const goal: Goal = { id: randomUUID(), workspaceId: context.workspaceId, businessId, createdByUserId: context.userId, status: input.status ?? "active", priority: input.priority ?? 3, createdAt: timestamp, updatedAt: timestamp, ...input, title: input.title.trim() };
    if (!goal.title) throw new Error("Goal title is required");
    this.goals.set(goal.id, goal);
    return goal;
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
    this.assertBusiness(context, businessId);
    const goal = this.goals.get(goalId);
    if (!goal || goal.workspaceId !== context.workspaceId || goal.businessId !== businessId) throw new WorkspaceAccessError("Goal is not available for this business");
    const updated = { ...goal, ...input, updatedAt: now() };
    this.goals.set(goalId, updated);
    return updated;
  }

  async deleteGoal(context: AuthContext, businessId: string, goalId: string) {
    await this.updateGoal(context, businessId, goalId, {});
    return this.goals.delete(goalId);
  }

  async listMemory(context: AuthContext, businessId: string, query = "", limit = 100) {
    this.assertBusiness(context, businessId);
    const needle = query.trim().toLowerCase();
    return [...this.memories.values()]
      .filter((item) => item.workspaceId === context.workspaceId && item.businessId === businessId && (!needle || `${item.type} ${item.title} ${item.content}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
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
    this.assertBusiness(context, businessId); assertNoSecrets(input);
    const timestamp = now();
    const item: MemoryItem = { id: randomUUID(), workspaceId: context.workspaceId, businessId, userId: context.userId, source: input.source ?? "user", ...input, createdAt: timestamp, updatedAt: timestamp };
    this.memories.set(item.id, item);
    return item;
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
    this.assertBusiness(context, businessId); assertNoSecrets(input);
    const item = this.memories.get(memoryId);
    if (!item || item.workspaceId !== context.workspaceId || item.businessId !== businessId) throw new WorkspaceAccessError("Memory is not available for this business");
    const updated = { ...item, ...input, updatedAt: now() };
    this.memories.set(memoryId, updated);
    return updated;
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

  // --- C5a: company membership and invites ---------------------------------------------------
  // The same semantics as the postgres store (and the `CodeMembershipStore` port in
  // apps/agent-api/src/code-membership.ts): company-scoped, no `AuthContext`, no default role.

  /** No row is `null`: membership is never assumed, and there is no "owner by default" fallback. */
  async getCompanyMembership(companyId: string, userId: string): Promise<CompanyMember | null> {
    return structuredClone(this.companyMembers.get(`${companyId}:${userId}`) ?? null);
  }

  /** The actual stored role and status of every member; nothing is inferred. */
  async listCompanyMembers(companyId: string): Promise<CompanyMember[]> {
    return structuredClone([...this.companyMembers.values()]
      .filter((member) => member.companyId === companyId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)));
  }

  /** Active owners only — a suspended owner cannot administer anything, so it is not a protection. */
  async countCompanyOwners(companyId: string): Promise<number> {
    return this.activeOwnerCount(companyId);
  }

  async createCompanyInvite(input: CompanyInviteInput): Promise<CompanyInvite> {
    if (!isCompanyRole(input.role)) {
      throw new CompanyMembershipError("invalid_company_role", `Unknown company role: ${String(input.role)}`, { httpStatus: 400 });
    }
    // Mirrors the unique indexes on company_invites: one id, one token hash — one live secret.
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

  /** Returns the invite in every state (expired and already accepted included) so callers can tell them apart. */
  async findCompanyInviteByTokenHash(tokenHash: string): Promise<CompanyInvite | null> {
    const invite = this.findInviteByTokenHash(tokenHash);
    return invite ? structuredClone(invite) : null;
  }

  /**
   * The invite is re-read from the store, never trusted from the caller's copy: a token is single-use
   * (`acceptedAt`) and dies at `expiresAt`. The invite is marked accepted only after the membership guard
   * passed, so a refused acceptance does not burn the token — matching the postgres transaction.
   */
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
    // Accepting an invite must not demote the only active owner (the update path refuses it too).
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
      // The invited role, verbatim: never a default and never derived from the previous row.
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

  /**
   * Revision-checked role change: a stale `expectedRevision` is refused as the port's
   * `membership_revision_conflict` (409, both revisions in `details`) with the tree-wide "changed by
   * another request" message. The last-owner check comes after it, the same order the postgres store
   * diagnoses, and both run before anything is written.
   */
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
      // The port contract: a stale revision is a conflict that writes nothing, and the caller can see
      // both revisions.
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

  /**
   * Removing the last active owner is refused for the same reason as demoting it. Like the port's own
   * implementation this is otherwise a delete: a user who is not a member is already refused with
   * `membership_not_found` (404) by `CodeMembershipService` before the store is called.
   */
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

  // --- C5b: ProviderDataPolicy ------------------------------------------------------------------
  // The in-memory mirror of the postgres implementation: same validation, same monotonic versioning,
  // same history snapshot, same tenant scoping. A platform default (`companyId === null`) never shares a
  // key with a company row, which is what the SQL `COALESCE(company_id,'')` unique index enforces.

  private providerPolicyKey(companyId: string | null, providerId: string, modelPattern: string | null): string {
    return `${companyId ?? "\u0000platform"}\u0000${providerId}\u0000${modelPattern ?? "\u0000provider"}`;
  }

  /**
   * Validation is duplicated here on purpose: a direct store call (bypassing the app-side service) must be
   * as safe as one that went through it. The codes match `ProviderDataPolicyError` so one route mapper
   * can handle both.
   */
  private assertValidProviderPolicy(input: UpsertProviderDataPolicyStoreInput): void {
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
    // Mandatory redaction is not configurable, for any provider kind.
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

  async getProviderDataPolicy(input: {
    companyId: string | null;
    providerId: string;
    modelPattern: string | null;
  }): Promise<ProviderDataPolicyRecord | null> {
    return structuredClone(
      this.providerDataPolicies.get(this.providerPolicyKey(input.companyId, input.providerId, input.modelPattern)) ?? null,
    );
  }

  async listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]> {
    return structuredClone([...this.providerDataPolicies.values()]
      .filter((policy) => policy.companyId === companyId)
      .sort((a, b) => a.providerId.localeCompare(b.providerId) || (a.modelPattern ?? "").localeCompare(b.modelPattern ?? "")));
  }

  /**
   * Versioning: a new row starts at 1, an existing one is bumped by exactly one, and the accepted policy is
   * snapshotted into the history with the acting `actor`. A stale `expectedPolicyVersion` is refused before
   * anything is written, so two writers cannot silently overwrite each other.
   */
  async upsertProviderDataPolicy(input: UpsertProviderDataPolicyStoreInput): Promise<ProviderDataPolicyRecord> {
    this.assertValidProviderPolicy(input);
    const key = this.providerPolicyKey(input.companyId, input.providerId, input.modelPattern);
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
      // The mandatory redactions are always present in what is stored, whatever the caller listed.
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

  /** An unconfigured project is `confidential`, never `public`: the default lives here, not in the caller. */
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
      .map((rule) => this.assertValidPathRule(rule));
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

  /** A rule that could point outside the project is refused, never normalised into something safe-looking. */
  private assertValidPathRule(rule: ProjectDataPolicyPathRule): ProjectDataPolicyPathRule {
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
      // A fresh grant clears any previous revocation: consent is explicit, and re-granting is the only way
      // back from a revocation.
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

  /** The row is returned whatever its state; a caller must treat `revokedAt !== null` as no consent. */
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
    for (const invite of this.companyInvites.values()) {
      if (invite.tokenHash === tokenHash) return invite;
    }
    return undefined;
  }

  // --- C6a: durable Coding Agent run state --------------------------------------------------
  // The same semantics as the postgres store, including the sequence guard, the atomic lease transition and
  // the tool-call merge, so the reconciler behaves identically with and without a database.

  async createCodeRunState(input: CreateCodeRunStateInput): Promise<CodeRunStateRecord> {
    const existing = await this.getCodeRunState(input.companyId, input.runId);
    // Idempotent by run: a retried create never rewinds the cursor, never steals the lease and — C10 — never
    // rewrites the original request. A resume re-runs this call with the continuation prompt, and the original
    // text must survive it.
    if (existing) return existing;
    const record: CodeRunStateRecord = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      status: "running",
      turnIndex: 0,
      lastEventSeq: 1,
      leaseOwner: input.owner,
      leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
      heartbeatAt: input.now,
      startedAt: input.now,
      updatedAt: input.now,
      finishedAt: null,
      details: { ...(input.details ?? {}) },
      revision: 1,
    };
    this.codeRunStates.set(input.runId, record);
    const request = input.request ?? { status: "not_recorded" as const, text: null, sha256: null, truncated: false, recordedAt: null };
    this.codeRunRequests.set(input.runId, {
      runId: input.runId,
      companyId: input.companyId,
      status: codeRunRequestStatus(request.status),
      text: request.text,
      sha256: request.sha256,
      truncated: request.truncated === true,
      recordedAt: request.recordedAt,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
    });
    return structuredClone(record);
  }

  /** C10: the run's original request. A run of another company is indistinguishable from a missing one. */
  async getCodeRunRequest(companyId: string, runId: string): Promise<CodeRunRequestRecord | null> {
    const record = this.codeRunRequests.get(runId);
    if (!record || record.companyId !== companyId) return null;
    return structuredClone(record);
  }

  async applyCodeRunStateEvent(input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord> {
    const current = this.codeRunStates.get(input.runId);
    if (!current || current.companyId !== input.companyId) {
      throw new CodeRunStateStoreError("code_run_state_not_found", "No such run state", {
        httpStatus: 404, details: { runId: input.runId },
      });
    }
    // The sequence guard: a retried write (same or older seq) changes nothing at all.
    if (current.lastEventSeq >= input.seq) return structuredClone(current);

    const now = input.lease?.now ?? new Date();
    const leaseTransitionAllowed = (() => {
      if (!input.lease) return false;
      if (input.lease.mode === "acquire") {
        return current.leaseOwner === null || current.leaseOwner === input.lease.owner
          || current.leaseExpiresAt === null || current.leaseExpiresAt.getTime() < input.lease.now.getTime();
      }
      return current.leaseOwner === input.lease.owner;
    })();

    const next: CodeRunStateRecord = {
      ...current,
      status: input.status ?? current.status,
      turnIndex: input.turnIndex ?? current.turnIndex,
      heartbeatAt: input.heartbeatAt ?? current.heartbeatAt,
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : current.finishedAt,
      details: input.details !== undefined ? { ...input.details } : current.details,
      lastEventSeq: input.seq,
      revision: current.revision + 1,
      updatedAt: now,
    };
    if (input.lease && leaseTransitionAllowed) {
      next.leaseOwner = input.lease.mode === "release" ? null : input.lease.owner;
      next.leaseExpiresAt = input.lease.mode === "release"
        ? null
        : new Date(input.lease.now.getTime() + (input.lease.leaseMs ?? 0));
    }
    this.codeRunStates.set(input.runId, next);
    return structuredClone(next);
  }

  async getCodeRunState(companyId: string, runId: string): Promise<CodeRunStateRecord | null> {
    const record = this.codeRunStates.get(runId);
    // A run of another company is indistinguishable from a missing one.
    if (!record || record.companyId !== companyId) return null;
    return structuredClone(record);
  }

  async listStaleCodeRunStates(input: { now: Date; limit: number }): Promise<CodeRunStateRecord[]> {
    return structuredClone([...this.codeRunStates.values()]
      .filter((record) => record.status === "running"
        && (record.leaseExpiresAt === null || record.leaseExpiresAt.getTime() < input.now.getTime()))
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .slice(0, Math.max(1, input.limit)));
  }

  async upsertCodeRunTurn(input: UpsertCodeRunTurnInput): Promise<CodeRunTurnRecord> {
    const key = `${input.runId}\u0000${input.turnIndex}`;
    const existing = this.codeRunTurns.get(key) ?? null;
    if (existing && existing.companyId !== input.companyId) {
      throw new CodeRunStateStoreError("code_run_state_not_found", "No such run turn", {
        httpStatus: 404, details: { runId: input.runId, turnIndex: input.turnIndex },
      });
    }
    const record: CodeRunTurnRecord = {
      runId: input.runId,
      companyId: input.companyId,
      turnIndex: input.turnIndex,
      // A turn that already finished is never reopened by a late write.
      status: input.status === "running" && existing && existing.status !== "running" ? existing.status : input.status,
      outcome: mergeCodeRunTurnOutcome(existing?.outcome ?? null, input.outcome ?? null),
      toolCalls: mergeCodeRunToolCalls(existing?.toolCalls ?? [], input.toolCalls ?? []),
      messages: structuredClone([...(input.messages ?? existing?.messages ?? [])]),
      results: structuredClone([...(input.results ?? existing?.results ?? [])]),
      checkpointId: input.checkpointId ?? existing?.checkpointId ?? null,
      startedAt: input.startedAt ?? existing?.startedAt ?? new Date(),
      finishedAt: input.finishedAt ?? existing?.finishedAt ?? null,
    };
    this.codeRunTurns.set(key, record);
    return structuredClone(record);
  }

  async getCodeRunTurn(companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null> {
    const record = this.codeRunTurns.get(`${runId}\u0000${turnIndex}`);
    if (!record || record.companyId !== companyId) return null;
    return structuredClone(record);
  }

  async listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]> {
    return structuredClone([...this.codeRunTurns.values()]
      .filter((record) => record.runId === runId && record.companyId === companyId)
      .sort((a, b) => a.turnIndex - b.turnIndex));
  }

  /**
   * C14: mirrors the postgres semantics of the same read — tenant predicate first, then the optional status and
   * window filters, newest first, bounded by `limit`. A run of another company is never visible, and there is no
   * system scope on this read (unlike `listCodeRunStatesForScan`), so a metrics caller cannot widen it.
   */
  async listCodeRunStates(input: ListCodeRunStatesInput): Promise<CodeRunStateRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
    const statuses = input.statuses ? new Set(input.statuses) : null;
    return structuredClone([...this.codeRunStates.values()]
      .filter((record) => record.companyId === input.companyId)
      .filter((record) => !statuses || statuses.has(record.status))
      .filter((record) => !input.startedAfter || record.startedAt.getTime() >= input.startedAfter.getTime())
      .filter((record) => !input.startedBefore || record.startedAt.getTime() < input.startedBefore.getTime())
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || a.runId.localeCompare(b.runId))
      .slice(0, limit));
  }

  /**
   * Keyset scan over running runs. The ordering is (startedAt, runId) and the cursor is the position of the
   * last row of the previous page, so a row inserted while the reaper pages through cannot cause a row to be
   * skipped or repeated.
   */
  async listCodeRunStatesForScan(input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const matching = [...this.codeRunStates.values()]
      .filter((record) => record.status === "running"
        && (input.companyId === null || record.companyId === input.companyId)
        && record.startedAt.getTime() < input.startedBefore.getTime())
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.runId.localeCompare(b.runId));
    const afterCursor = cursor
      ? matching.filter((record) => record.startedAt.getTime() > Date.parse(cursor.startedAt)
        || (record.startedAt.getTime() === Date.parse(cursor.startedAt) && record.runId > cursor.runId))
      : matching;
    const page = afterCursor.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: structuredClone(page),
      nextCursor: afterCursor.length > limit && last
        ? encodeCodeRunScanCursor({ startedAt: last.startedAt.toISOString(), runId: last.runId, turnIndex: 0 })
        : null,
    };
  }

  /**
   * C10 (ТЗ item 7): the projects that own a code session, newest session first. Used by the sandbox-retention
   * sweep to find a sandbox whose project the process no longer remembers. Two ids and a timestamp — no name,
   * path or content leaves the store through this read.
   */
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

  /**
   * C10 (ТЗ item 7): one project by ids, without a user context. The retention sweep runs as the deployment's
   * system identity, which owns no projects, so the tenant-scoped `getProject` cannot address them. `null` for an
   * unknown or foreign id — the caller is the reaper, and there is no caller-supplied id to leak here.
   */
  async getProjectForSystem(companyId: string, projectId: string): Promise<Project | null> {
    const project = this.projects.get(projectId);
    if (!project || project.companyId !== companyId) return null;
    return structuredClone(project);
  }

  /** Keyset scan over the open turns, ordered by (startedAt, runId, turnIndex). */
  async listCodeRunTurnsForScan(input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const statuses = input.statuses ?? ["running"];
    const matching = [...this.codeRunTurns.values()]
      .filter((record) => statuses.includes(record.status)
        && (input.companyId === null || record.companyId === input.companyId)
        && record.startedAt.getTime() < input.startedBefore.getTime())
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()
        || a.runId.localeCompare(b.runId) || a.turnIndex - b.turnIndex);
    const afterCursor = cursor
      ? matching.filter((record) => {
        const at = record.startedAt.getTime();
        const cursorAt = Date.parse(cursor.startedAt);
        if (at !== cursorAt) return at > cursorAt;
        if (record.runId !== cursor.runId) return record.runId > cursor.runId;
        return record.turnIndex > cursor.turnIndex;
      })
      : matching;
    const page = afterCursor.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: structuredClone(page),
      nextCursor: afterCursor.length > limit && last
        ? encodeCodeRunScanCursor({
          startedAt: last.startedAt.toISOString(), runId: last.runId, turnIndex: last.turnIndex,
        })
        : null,
    };
  }

  private activeOwnerCount(companyId: string): number {
    let owners = 0;
    for (const member of this.companyMembers.values()) {
      if (member.companyId === companyId && member.role === "owner" && member.status === "active") owners += 1;
    }
    return owners;
  }

  /** True for the write that would leave the company without a usable owner (postgres: lastActiveOwnerPredicate). */
  private isLastActiveOwnerDemotion(member: CompanyMember, nextRole: string): boolean {
    return member.status === "active" && member.role === "owner" && nextRole !== "owner"
      && this.activeOwnerCount(member.companyId) <= 1;
  }

  /** Same predicate for a removal: the row itself must be the company's only active owner. */
  private isLastActiveOwner(member: CompanyMember): boolean {
    return member.status === "active" && member.role === "owner" && this.activeOwnerCount(member.companyId) <= 1;
  }

  // --- C6b: immutable execution snapshots and versioned configuration -------------------------------

  async createExecutionSnapshot(input: CreateExecutionSnapshotInput): Promise<ExecutionSnapshotRecord> {
    const id = input.id ?? randomUUID();
    // A snapshot is evidence: reusing an id would rewrite history, so this is a refusal, not an upsert.
    if (this.executionSnapshots.has(id)) throw new ExecutionSnapshotImmutableError(`create with existing id ${id}`);

    const previous = await this.getLatestSnapshotForSession(input.companyId, input.sessionId);
    const record: ExecutionSnapshotRecord = {
      id,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      snapshotVersion: (previous?.snapshotVersion ?? 0) + 1,
      payload: input.payload,
      payloadHash: snapshotPayloadHash(input.payload),
      prevSnapshotId: previous?.id ?? null,
      prevPayloadHash: previous?.payloadHash ?? null,
      trigger: input.trigger,
      legacy: input.legacy === true,
      createdAt: input.now ?? new Date(),
      createdBy: input.createdBy,
    };
    this.executionSnapshots.set(record.id, record);
    return record;
  }

  async getExecutionSnapshot(companyId: string, snapshotId: string): Promise<ExecutionSnapshotRecord | null> {
    const record = this.executionSnapshots.get(snapshotId);
    return record && record.companyId === companyId ? record : null;
  }

  async getLatestSnapshotForSession(companyId: string, sessionId: string): Promise<ExecutionSnapshotRecord | null> {
    const matching = [...this.executionSnapshots.values()]
      .filter((record) => record.companyId === companyId && record.sessionId === sessionId)
      .sort((a, b) => b.snapshotVersion - a.snapshotVersion);
    return matching[0] ?? null;
  }

  async getSnapshotForRun(companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null> {
    const matching = [...this.executionSnapshots.values()]
      .filter((record) => record.companyId === companyId && record.runId === runId)
      .sort((a, b) => b.snapshotVersion - a.snapshotVersion);
    return matching[0] ?? null;
  }

  async listExecutionSnapshots(input: ListExecutionSnapshotsInput): Promise<ExecutionSnapshotRecord[]> {
    const limit = Math.min(Math.max(input.limit, 1), 500);
    return [...this.executionSnapshots.values()]
      .filter((record) => record.companyId === input.companyId
        && (!input.sessionId || record.sessionId === input.sessionId)
        && (!input.projectId || record.projectId === input.projectId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
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
    const existing = await this.findSnapshotConfigVersionByHash(input.companyId, input.kind, input.contentHash);
    // Identical content must reuse its version: a new row per call would make every snapshot point at a
    // different "version" of the same text and destroy the meaning of the number.
    if (existing) return existing;
    const nextVersion = [...this.snapshotConfigVersions.values()]
      .filter((record) => record.companyId === input.companyId && record.kind === input.kind)
      .reduce((max, record) => Math.max(max, record.version), 0) + 1;
    const record: SnapshotConfigVersionRecord = {
      id: input.id ?? `scv_${randomUUID()}`,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      kind: input.kind,
      version: nextVersion,
      contentHash: input.contentHash,
      content: input.content,
      createdAt: input.now ?? new Date(),
      createdBy: input.createdBy,
    };
    this.snapshotConfigVersions.set(record.id, record);
    return record;
  }

  async getSnapshotConfigVersion(
    companyId: string, kind: SnapshotConfigKind, version: number,
  ): Promise<SnapshotConfigVersionRecord | null> {
    return [...this.snapshotConfigVersions.values()].find((record) => record.companyId === companyId
      && record.kind === kind && record.version === version) ?? null;
  }

  async findSnapshotConfigVersionByHash(
    companyId: string, kind: SnapshotConfigKind, contentHash: string,
  ): Promise<SnapshotConfigVersionRecord | null> {
    return [...this.snapshotConfigVersions.values()].find((record) => record.companyId === companyId
      && record.kind === kind && record.contentHash === contentHash) ?? null;
  }

  async listSnapshotConfigVersions(companyId: string, kind: SnapshotConfigKind): Promise<SnapshotConfigVersionRecord[]> {
    return [...this.snapshotConfigVersions.values()]
      .filter((record) => record.companyId === companyId && record.kind === kind)
      .sort((a, b) => b.version - a.version);
  }

  /**
   * C8: append-only context summaries. Mirrors the postgres ordering (`created_at DESC, id DESC`) so a read
   * written against one store behaves identically on the other; there is deliberately no update or delete.
   */
  // --- C9: goals, plan revisions and session todos --------------------------------------------------
  // Thin delegations: every rule (verified acceptance criteria before completion, revisioned plans, at most one
  // todo in progress) is implemented once in `code-goal-store.ts` and shared with the Postgres backend.

  // --- C9: `code.ask_user` — the persistent question ---------------------------------------------------

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

  // --- C10: session durability -------------------------------------------------------------------------

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
    const record: CodeContextSummaryRecord = {
      id: input.id ?? randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      snapshotId: input.snapshotId ?? null,
      turnIndex: input.turnIndex ?? 0,
      schemaVersion: input.schemaVersion,
      summary: input.summary,
      summaryText: input.summaryText,
      contentHash: input.contentHash,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? "short",
      createdAt: input.now ?? new Date(),
    };
    this.codeContextSummaries.set(record.id, record);
    return record;
  }

  async listCodeContextSummaries(input: ListCodeContextSummariesInput): Promise<CodeContextSummaryRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    return [...this.codeContextSummaries.values()]
      .filter((record) => record.companyId === input.companyId)
      .filter((record) => !input.sessionId || record.sessionId === input.sessionId)
      .filter((record) => !input.runId || record.runId === input.runId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, limit);
  }

  /**
   * C6b: append-only Activity events. Mirrors the postgres ordering (`created_at DESC, id DESC`) and the
   * keyset cursor, so a read written against one store behaves identically on the other.
   */
  async createCodeActivityEvent(input: CreateCodeActivityEventInput): Promise<CodeActivityEventRecord> {
    const record: CodeActivityEventRecord = {
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      snapshotId: input.snapshotId ?? null,
      parentRunId: input.parentRunId ?? null,
      parentToolCallId: input.parentToolCallId ?? null,
      parentEventId: input.parentEventId ?? null,
      kind: input.kind,
      payload: input.payload,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
      createdAt: input.now ?? new Date(),
    };
    this.codeActivityEvents.set(record.id, record);
    return record;
  }

  async listCodeActivityEvents(input: ListCodeActivityEventsInput): Promise<CodeActivityEventRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
    const cursor = input.cursor ? decodeCodeActivityCursor(input.cursor) : null;
    return [...this.codeActivityEvents.values()]
      .filter((record) => record.companyId === input.companyId)
      .filter((record) => !input.sessionId || record.sessionId === input.sessionId)
      .filter((record) => !input.runId || record.runId === input.runId)
      .filter((record) => !input.snapshotId || record.snapshotId === input.snapshotId)
      // C12: one level of the delegation tree — every event recorded under the run that delegated.
      .filter((record) => !input.parentRunId || record.parentRunId === input.parentRunId)
      .filter((record) => {
        if (!cursor) return true;
        // Keyset comparison over (createdAt, id), newest first.
        const at = record.createdAt.getTime();
        const cursorAt = Date.parse(cursor.createdAt);
        return at < cursorAt || (at === cursorAt && record.id < cursor.id);
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, limit);
  }

  /**
   * C6b: replay bundles. Mirrors the postgres semantics exactly: header plus ordered steps, idempotent by
   * `(runId, bundleVersion)`, append-only (no update or delete method exists on either store).
   */
  async createReplayBundle(input: CreateReplayBundleInput): Promise<ReplayBundleRecord> {
    const existing = await this.getReplayBundle(input.companyId, input.runId, input.bundleVersion);
    if (existing) return existing;
    const now = input.now ?? new Date();
    const record: ReplayBundleRecord = {
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId,
      executionSnapshotId: input.executionSnapshotId ?? null,
      bundleVersion: input.bundleVersion,
      runnerVersion: input.runnerVersion ?? null,
      systemPromptVersion: input.systemPromptVersion ?? null,
      systemPromptContentHash: input.systemPromptContentHash ?? null,
      modelProfileVersion: input.modelProfileVersion ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      replayMode: input.replayMode,
      sourceRunId: input.sourceRunId ?? null,
      sourceSnapshotId: input.sourceSnapshotId ?? null,
      terminalStatus: input.terminalStatus ?? null,
      terminalReason: input.terminalReason ?? null,
      payload: input.payload,
      payloadHash: input.payloadHash,
      replayInputHash: input.replayInputHash,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
      createdAt: now,
    };
    this.replayBundles.set(record.id, record);
    const steps: ReplayBundleStepRecord[] = [];
    let seq = 0;
    const seen = new Set<string>();
    for (const step of input.steps) {
      // Idempotency mirrors the unique index on (bundleId, kind, turnIndex, toolCallId): a repeated step is
      // dropped, never duplicated.
      const identity = `${step.kind}:${step.turnIndex}:${step.toolCallId ?? ""}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      seq += 1;
      steps.push({
        id: step.id ?? randomUUID(),
        bundleId: record.id,
        companyId: input.companyId,
        seq,
        kind: step.kind,
        turnIndex: step.turnIndex,
        toolCallId: step.toolCallId ?? null,
        payload: step.payload,
        payloadHash: step.payloadHash,
        createdAt: step.createdAt ?? now,
      });
    }
    this.replayBundleSteps.set(record.id, steps);
    return record;
  }

  async getReplayBundle(companyId: string, runId: string, bundleVersion?: number): Promise<ReplayBundleRecord | null> {
    const matches = [...this.replayBundles.values()]
      .filter((bundle) => bundle.companyId === companyId && bundle.runId === runId)
      .filter((bundle) => bundleVersion === undefined || bundle.bundleVersion === bundleVersion)
      .sort((a, b) => b.bundleVersion - a.bundleVersion);
    return matches[0] ?? null;
  }

  /** C6b: by-id read, tenant-scoped (mirrors the postgres query). */
  async getReplayBundleById(companyId: string, bundleId: string): Promise<ReplayBundleRecord | null> {
    const bundle = this.replayBundles.get(bundleId);
    return bundle && bundle.companyId === companyId ? bundle : null;
  }

  async listReplayBundles(input: ListReplayBundlesInput): Promise<ReplayBundleRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    return [...this.replayBundles.values()]
      .filter((bundle) => bundle.companyId === input.companyId)
      .filter((bundle) => !input.runId || bundle.runId === input.runId)
      .filter((bundle) => !input.sessionId || bundle.sessionId === input.sessionId)
      .filter((bundle) => !input.executionSnapshotId || bundle.executionSnapshotId === input.executionSnapshotId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, limit);
  }

  async listReplayBundleSteps(companyId: string, bundleId: string): Promise<ReplayBundleStepRecord[]> {
    const steps = this.replayBundleSteps.get(bundleId) ?? [];
    return steps.filter((step) => step.companyId === companyId).slice().sort((a, b) => a.seq - b.seq);
  }
}
