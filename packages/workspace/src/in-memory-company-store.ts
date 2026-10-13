import { randomUUID } from "node:crypto";
import type { AuthContext, Business, BusinessInput, Company, CompanyAgent, CompanyAgentInput, CompanyAgentRun, CompanyInput, CompanyMember, CompanyInvite, CompanyInviteInput, UpdateCompanyMemberRoleInput, ProviderHostedConsentRecord } from "./types";
import { WorkspaceAccessError, WorkspaceNotFoundError, ProviderDataPolicyStoreError } from "./types";
import { companyPageLimit, decodeBusinessCursor, encodeBusinessCursor } from "./pagination";
import { now } from "./in-memory-clock";
import type { StoredUserSetting } from "./in-memory-store";

export interface InMemoryCompanyState {
  businesses: any
  companies: any
  companyAgentCreateRequests: any
  companyAgents: any
  companyCreateRequests: any
  companyEdges: any
  companyMembershipOps: any
  companyRunEvents: any
  companyRunPendingPlans: any
  companyRunRequests: any
  companyRunSteps: any
  companyRuns: Map<string, CompanyAgentRun>
  companyToolAudit: any
  goals: any
  hostedProviderConsent: any
  memories: any
  projects: any
  userSettings: Map<string, StoredUserSetting>
  assertBusiness: (...args: any[]) => any
  assertUserBusiness: (...args: any[]) => any
  ensure: (...args: any[]) => any
}

export async function getUserSetting(host: InMemoryCompanyState, context: AuthContext, key: string) {
    await host.ensure(context);
    return structuredClone(host.userSettings.get(`${context.workspaceId}:${context.userId}:${key}`) ?? null);
  }

export async function setUserSetting(host: InMemoryCompanyState, context: AuthContext, key: string, value: unknown, expectedRevision: number) {
    await host.ensure(context);
    const storageKey = `${context.workspaceId}:${context.userId}:${key}`;
    const current = host.userSettings.get(storageKey);
    if ((current?.revision ?? 0) !== expectedRevision) return null;
    const next: StoredUserSetting = { key, value: structuredClone(value), revision: expectedRevision + 1, updatedAt: now() };
    host.userSettings.set(storageKey, next);
    return structuredClone(next);
  }

export async function listUserBusinesses(host: InMemoryCompanyState, context: AuthContext) {
    return [...host.businesses.values()]
      .filter((business) => business.workspaceId === context.workspaceId && business.ownerUserId === context.userId && business.activationStatus === "active")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
  }

export async function getUserBusiness(host: InMemoryCompanyState, context: AuthContext, businessId: string) { return host.assertUserBusiness(context, businessId); }

export async function updateUserBusiness(host: InMemoryCompanyState, context: AuthContext, businessId: string, input: Partial<BusinessInput>) {
    const current = host.assertUserBusiness(context, businessId);
    const updated = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), updatedAt: now() };
    if (!updated.name.trim()) throw new Error("Business name is required");
    host.businesses.set(businessId, updated);
    return updated;
  }

export function assertCompany(host: InMemoryCompanyState, context: AuthContext, companyId: string) {
    if (context.companyId && context.companyId !== companyId) throw new WorkspaceAccessError("API key is not valid for this company");
    const company = host.companies.get(companyId);
    if (!company || company.workspaceId !== context.workspaceId || company.userId !== context.userId) {
      throw new WorkspaceAccessError("Company is not available to this user");
    }
    return company;
  }

export async function listCompanies(host: InMemoryCompanyState, context: AuthContext, requestedLimit = 20, cursor?: string) {
    await host.ensure(context);
    const limit = companyPageLimit(requestedLimit), after = decodeBusinessCursor(cursor);
    const rows = [...host.companies.values()]
      .filter((company) => company.workspaceId === context.workspaceId && company.userId === context.userId && (!context.companyId || company.id === context.companyId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .filter((company) => !after || company.createdAt > after.createdAt || (company.createdAt === after.createdAt && company.id > after.id));
    const items = rows.slice(0, limit), last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

export async function getCompany(host: InMemoryCompanyState, context: AuthContext, companyId: string) { return assertCompany(host, context, companyId); }

export async function createCompany(host: InMemoryCompanyState, context: AuthContext, input: CompanyInput, idempotencyKey: string) {
    if (context.companyId) throw new WorkspaceAccessError("Company-scoped API keys cannot create companies");
    await host.ensure(context);
    const requestKey = `${context.workspaceId}:${context.userId}:${idempotencyKey}`;
    const existingId = host.companyCreateRequests.get(requestKey);
    if (existingId) return assertCompany(host, context, existingId);
    if (!input.name?.trim()) throw new Error("Company name is required");
    if (input.businessId) host.assertBusiness(context, input.businessId);
    const timestamp = now();
    const company: Company = {
      id: randomUUID(), workspaceId: context.workspaceId, userId: context.userId, name: input.name.trim(),
      businessId: input.businessId, website: input.website, industry: input.industry, description: input.description,
      productsServices: input.productsServices, languages: input.languages ?? [], brandTone: input.brandTone,
      companyInstructions: input.companyInstructions, knowledge: input.knowledge ?? [], memory: input.memory ?? {},
      status: input.status ?? "active", revision: 1, createdAt: timestamp, updatedAt: timestamp,
    };
    host.companies.set(company.id, company);
    host.companyCreateRequests.set(requestKey, company.id);
    await host.companyMembershipOps.recordCompanyCreator(company.id, company.userId);
    return company;
  }

export async function updateCompany(host: InMemoryCompanyState, context: AuthContext, companyId: string, input: Partial<CompanyInput>, expectedRevision: number) {
    const current = assertCompany(host, context, companyId);
    if (current.revision !== expectedRevision) throw new Error("Company was changed by another request. Reload and try again.");
    if (input.businessId) host.assertBusiness(context, input.businessId);
    const updated = { ...current, ...input, name: input.name?.trim() ?? current.name, revision: current.revision + 1, updatedAt: now() };
    if (!updated.name) throw new Error("Company name is required");
    host.companies.set(companyId, updated);
    return updated;
  }

export async function deleteCompany(host: InMemoryCompanyState, context: AuthContext, companyId: string) {
    assertCompany(host, context, companyId);
    host.companies.delete(companyId);
    for (const [id, project] of host.projects) if (project.companyId === companyId) host.projects.delete(id);
    for (const [id, agent] of host.companyAgents) if (agent.companyId === companyId) host.companyAgents.delete(id);
    for (const [id, edge] of host.companyEdges) if (edge.companyId === companyId) host.companyEdges.delete(id);
    return true;
  }

export function assertCompanyAgent(host: InMemoryCompanyState, context: AuthContext, companyId: string, agentId: string) {
    assertCompany(host, context, companyId);
    const agent = host.companyAgents.get(agentId);
    if (!agent || agent.workspaceId !== context.workspaceId || agent.companyId !== companyId) {
      throw new WorkspaceNotFoundError("Agent was not found in this company");
    }
    return agent;
  }

export async function listCompanyAgents(host: InMemoryCompanyState, context: AuthContext, companyId: string) {
    assertCompany(host, context, companyId);
    return [...host.companyAgents.values()].filter((agent) => agent.workspaceId === context.workspaceId && agent.companyId === companyId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

export async function listCompanyAgentsPage(host: InMemoryCompanyState, context: AuthContext, companyId: string, requestedLimit = 50, cursor?: string) {
    const limit = companyPageLimit(requestedLimit), after = decodeBusinessCursor(cursor);
    const rows = (await listCompanyAgents(host, context, companyId))
      .slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .filter((agent) => !after || agent.createdAt > after.createdAt || (agent.createdAt === after.createdAt && agent.id > after.id));
    const items = rows.slice(0, limit), last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

export async function getCompanyAgent(host: InMemoryCompanyState, context: AuthContext, companyId: string, agentId: string) {
    return assertCompanyAgent(host, context, companyId, agentId);
  }

export async function createCompanyAgent(host: InMemoryCompanyState, context: AuthContext, companyId: string, input: CompanyAgentInput, idempotencyKey: string) {
    assertCompany(host, context, companyId);
    const requestKey = `${context.workspaceId}:${companyId}:${idempotencyKey}`;
    const existingId = host.companyAgentCreateRequests.get(requestKey);
    if (existingId) return assertCompanyAgent(host, context, companyId, existingId);
    if (!input.name?.trim() || !input.role?.trim()) throw new Error("Agent name and role are required");
    const timestamp = now();
    const agent: CompanyAgent = {
      id: randomUUID(), workspaceId: context.workspaceId, companyId, name: input.name.trim(), role: input.role.trim(),
      description: input.description, systemInstruction: input.systemInstruction, promptGuidelines: input.promptGuidelines,
      recommendedPrompts: input.recommendedPrompts ?? [], modelId: input.modelId, fallbackModelId: input.fallbackModelId,
      tools: input.tools ?? [], isActive: input.isActive ?? true, positionX: input.positionX, positionY: input.positionY,
      sortOrder: input.sortOrder ?? 0, revision: 1, createdAt: timestamp, updatedAt: timestamp,
    };
    host.companyAgents.set(agent.id, agent);
    host.companyAgentCreateRequests.set(requestKey, agent.id);
    return agent;
  }

export async function updateCompanyAgent(host: InMemoryCompanyState, context: AuthContext, companyId: string, agentId: string, input: Partial<CompanyAgentInput>, expectedRevision: number) {
    const current = assertCompanyAgent(host, context, companyId, agentId);
    if (current.revision !== expectedRevision) throw new Error("Agent was changed by another request. Reload and try again.");
    const updated = { ...current, ...input, name: input.name?.trim() ?? current.name, role: input.role?.trim() ?? current.role,
      revision: current.revision + 1, updatedAt: now() };
    if (!updated.name || !updated.role) throw new Error("Agent name and role are required");
    host.companyAgents.set(agentId, updated);
    return updated;
  }

export async function deleteCompanyAgent(host: InMemoryCompanyState, context: AuthContext, companyId: string, agentId: string, expectedRevision: number) {
    const company = assertCompany(host, context, companyId);
    const agent = host.companyAgents.get(agentId);
    if (!agent || agent.workspaceId !== context.workspaceId || agent.companyId !== companyId) return false;
    if (agent.revision !== expectedRevision) throw new Error("Agent was changed by another request. Reload and try again.");
    host.companyAgents.delete(agentId);
    for (const [id, edge] of host.companyEdges) if (edge.parentAgentId === agentId || edge.childAgentId === agentId) host.companyEdges.delete(id);
    if (company.mainAgentId === agentId) host.companies.set(companyId, { ...company, mainAgentId: undefined, revision: company.revision + 1, updatedAt: now() });
    return true;
  }

export async function listCompanyAgentEdges(host: InMemoryCompanyState, context: AuthContext, companyId: string, agentIds?: string[]) {
    assertCompany(host, context, companyId);
    const filter = agentIds?.length ? new Set(agentIds) : null;
    return [...host.companyEdges.values()].filter((edge) => edge.workspaceId === context.workspaceId && edge.companyId === companyId
      && (!filter || filter.has(edge.parentAgentId) || filter.has(edge.childAgentId)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

export async function createCompanyAgentRun(host: InMemoryCompanyState, context: AuthContext, companyId: string, input: { task: string; requestedMode: "auto" | "single" | "pipeline" | "fusion"; projectId?: string }, idempotencyKey: string) {
    const company = assertCompany(host, context, companyId);
    if (!company.mainAgentId) throw new Error("Select an active Main Agent before running the company");
    const mainAgent = assertCompanyAgent(host, context, companyId, company.mainAgentId);
    if (!mainAgent.isActive) throw new Error("The Main Agent is inactive");
    const task = input.task?.trim();
    if (!task) throw new Error("Company task is required");
    const requestKey = `${context.workspaceId}:${companyId}:${context.userId}:${idempotencyKey}`;
    const existingId = host.companyRunRequests.get(requestKey);
    if (existingId) return { run: structuredClone(host.companyRuns.get(existingId)!), created: false };
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
    host.companyRuns.set(run.id, run);
    host.companyRunRequests.set(requestKey, run.id);
    return { run: structuredClone(run), created: true };
  }

export async function listCompanyAgentRuns(host: InMemoryCompanyState, context: AuthContext, companyId: string, limit = 50, filter?: { projectId?: string }) {
    assertCompany(host, context, companyId);
    return Array.from(host.companyRuns.values())
      .filter((r) => r.workspaceId === context.workspaceId && r.companyId === companyId && (!filter?.projectId || r.projectId === filter.projectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map((r) => structuredClone(r));
  }

export async function getCompanyAgentRun(host: InMemoryCompanyState, context: AuthContext, companyId: string, runId: string) {
    assertCompany(host, context, companyId);
    const run = host.companyRuns.get(runId);
    if (!run || run.workspaceId !== context.workspaceId || run.companyId !== companyId || run.userId !== context.userId) {
      throw new WorkspaceAccessError("Agent run is not available in this company");
    }
    const completionStatus = run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? run.status : undefined;
    return {
      run: structuredClone(run),
      steps: [...host.companyRunSteps.values()].filter((step) => step.runId === runId).sort((a, b) => a.stepOrder - b.stepOrder || a.lane - b.lane),
      toolAudit: [...host.companyToolAudit.values()].filter((entry) => entry.runId === runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),

      backgroundEvents: [...host.companyRunEvents.values()].filter((entry) => entry.runId === runId),
      completionReport: completionStatus && run.completedAt ? { runId: run.id, companyId: run.companyId, status: completionStatus,
        result: run.result, errorCode: run.errorCode, errorMessage: run.errorMessage, workerId: run.workerId,
        attemptCount: run.attemptCount, totalCost: run.totalCost ?? 0, totalTokens: run.totalTokens ?? 0,
        totalDurationMs: run.totalDurationMs ?? 0, completedAt: run.completedAt } : undefined,
    };
  }

export async function getCompanyRunPendingPlan(host: InMemoryCompanyState, context: AuthContext, companyId: string, runId: string): Promise<unknown | null> {
    await getCompanyAgentRun(host, context, companyId, runId);
    const plan = host.companyRunPendingPlans.get(runId);
    return plan === undefined ? null : structuredClone(plan);
  }

export async function updateCompanyAgentRun(host: InMemoryCompanyState, context: AuthContext, companyId: string, runId: string, patch: Partial<CompanyAgentRun>) {
    const { run } = await getCompanyAgentRun(host, context, companyId, runId);
    const timestamp = now();
    const terminal = patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled";
    const started = patch.status === "planning" || patch.status === "running";
    const updated: CompanyAgentRun = {
      ...run, ...patch,
      startedAt: started ? run.startedAt ?? timestamp : run.startedAt,
      completedAt: terminal ? timestamp : started || patch.status === "awaiting_approval" ? undefined : run.completedAt,
      updatedAt: timestamp,
    };
    host.companyRuns.set(runId, updated);
    return structuredClone(updated);
  }

export async function listUserGoals(host: InMemoryCompanyState, context: AuthContext) {
    await host.ensure(context);
    const userBusinessIds = new Set(
      [...host.businesses.values()]
        .filter((b) => b.workspaceId === context.workspaceId && b.ownerUserId === context.userId)
        .map((b) => b.id)
    );
    return [...host.goals.values()]
      .filter((goal) => goal.workspaceId === context.workspaceId && (goal.createdByUserId === context.userId || userBusinessIds.has(goal.businessId)))
      .sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt));
  }

export async function listUserMemories(host: InMemoryCompanyState, context: AuthContext, query = "", limit = 100) {
    await host.ensure(context);
    const userBusinessIds = new Set(
      [...host.businesses.values()]
        .filter((b) => b.workspaceId === context.workspaceId && b.ownerUserId === context.userId)
        .map((b) => b.id)
    );
    const needle = query.trim().toLowerCase();
    return [...host.memories.values()]
      .filter((item) => item.workspaceId === context.workspaceId && (item.userId === context.userId || userBusinessIds.has(item.businessId)) && (!needle || `${item.type} ${item.title} ${item.content}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

export async function getCompanyMembership(host: InMemoryCompanyState, companyId: string, userId: string): Promise<CompanyMember | null> {
    return host.companyMembershipOps.getCompanyMembership(companyId, userId);
  }

export async function listCompanyMembers(host: InMemoryCompanyState, companyId: string): Promise<CompanyMember[]> {
    return host.companyMembershipOps.listCompanyMembers(companyId);
  }

export async function createCompanyInvite(host: InMemoryCompanyState, input: CompanyInviteInput): Promise<CompanyInvite> {
    return host.companyMembershipOps.createCompanyInvite(input);
  }

export async function updateCompanyMemberRole(host: InMemoryCompanyState, input: UpdateCompanyMemberRoleInput): Promise<CompanyMember> {
    return host.companyMembershipOps.updateCompanyMemberRole(input);
  }

export async function grantHostedProviderConsent(host: InMemoryCompanyState, input: {
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
    host.hostedProviderConsent.set(`${input.companyId}\u0000${input.projectId}\u0000${input.providerId}`, record);
    return structuredClone(record);
  }

export async function revokeHostedProviderConsent(host: InMemoryCompanyState, input: {
    companyId: string;
    projectId: string;
    providerId: string;
    revokedAt: Date;
  }): Promise<ProviderHostedConsentRecord> {
    const key = `${input.companyId}\u0000${input.projectId}\u0000${input.providerId}`;
    const existing = host.hostedProviderConsent.get(key);
    if (!existing) {
      throw new ProviderDataPolicyStoreError("data_policy_not_found", "No hosted provider consent to revoke", {
        httpStatus: 404, details: { providerId: input.providerId },
      });
    }
    const record: ProviderHostedConsentRecord = { ...existing, revokedAt: input.revokedAt };
    host.hostedProviderConsent.set(key, record);
    return structuredClone(record);
  }

