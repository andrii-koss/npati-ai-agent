import { randomUUID } from "node:crypto";
import { assertNoSecrets } from "@npati/memory";
import type { AuthContext, Business, BusinessInput, BusinessOnboardingSession, BusinessToCompanyInput, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentInput, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, CompanyInput, Project, ProjectInput, ProjectStatus, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview, WorkspaceStore } from "./types";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "./types";
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
  private readonly projectCreateRequests = new Map<string, string>();
  private readonly companyEdges = new Map<string, CompanyAgentEdge>();
  private readonly companyRuns = new Map<string, CompanyAgentRun>();
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
      name: input.name, description: input.description, type: input.type, status: "ready",
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

  async updateProject(context: AuthContext, companyId: string, projectId: string, input: { name: string; expectedRevision: number }) {
    const project = await this.getProject(context, companyId, projectId);
    if (project.revision !== input.expectedRevision || project.status === "archived") throw new Error("Project changed by another request or is archived");
    const next = { ...project, name: input.name, revision: project.revision + 1, updatedAt: now() };
    this.projects.set(projectId, next);
    return structuredClone(next);
  }

  async setProjectSandbox(context: AuthContext, companyId: string, projectId: string, sandboxId: string | null, expectedSandboxId: string | null) {
    const project = await this.getProject(context, companyId, projectId);
    if ((project.sandboxId ?? null) !== expectedSandboxId || project.status === "archived") throw new Error("Project sandbox changed by another request or is archived");
    const next: Project = { ...project, sandboxId: sandboxId ?? undefined, revision: project.revision + 1, updatedAt: now() };
    this.projects.set(projectId, next);
    return structuredClone(next);
  }
  async updateProjectPreview(context: AuthContext, companyId: string, projectId: string, patch: { status?: ProjectStatus; previewUrl?: string | null; previewPort?: number | null; framework?: string | null; runtime?: string | null; lastBuildStatus?: string | null }) {
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
    return this.projects.delete(projectId);
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

  async updateCompanyAgentRun(context: AuthContext, companyId: string, runId: string, patch: Partial<CompanyAgentRun>) {
    const { run } = await this.getCompanyAgentRun(context, companyId, runId);
    const timestamp = now();
    const terminal = patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled";
    const started = patch.status === "planning" || patch.status === "running";
    const updated: CompanyAgentRun = {
      ...run, ...patch,
      startedAt: started ? run.startedAt ?? timestamp : run.startedAt,
      completedAt: terminal ? timestamp : run.completedAt,
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
}
