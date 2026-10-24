import {
  type ActiveContext,
  type ContextType,
  type RunContextSnapshot,
  validateActiveContext,
  ContextValidationError,
  defaultHybridRouter,
} from "@npati/shared";
import {
  type AuthContext,
  type Business,
  type Company,
  type Project,
  type WorkspaceStore,
  WorkspaceAccessError,
} from "@npati/workspace";

export interface ResolvedActiveContext {
  context: ActiveContext;
  company?: Company;
  business?: Business;
  project?: Project;
  snapshot: RunContextSnapshot;
}

const nameWords = (value: string) => value.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? [];

/**
 * The one owned company a message names, when it is not the active one: "build a landing page for Nordic Fit" while
 * the bakery's site is open. A name word matches an inflected message word by its stem (Ukrainian "пекарні" names
 * "Пекарня"); only words of five or more letters count, so short generic words ("New", "Fit") never switch context.
 * Returns undefined when no company or more than one company scores best, or when the active company scores as well.
 */
export function companyNamedInMessage<T extends { id: string; name: string }>(companies: T[], message: string, activeCompanyId?: string | null): T | undefined {
  const words = nameWords(message);
  const score = (company: T) => nameWords(company.name).filter((word) => word.length >= 5)
    .filter((word) => { const stem = word.slice(0, Math.max(4, word.length - 2)); return words.some((candidate) => candidate.startsWith(stem)); }).length;
  const scored = companies.map((company) => ({ company, score: score(company) })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || scored[1]?.score === best.score) return undefined;
  const active = activeCompanyId ? scored.find((entry) => entry.company.id === activeCompanyId) : undefined;
  if (best.company.id === activeCompanyId || (active && active.score >= best.score)) return undefined;
  return best.company;
}

export class ActiveContextResolver {
  constructor(private readonly store: WorkspaceStore) {}

  /**
   * Switches the chat context to another owned company the message names (see companyNamedInMessage): that company's
   * most recently updated project for follow-up work, or the company itself for a new project.
   */
  async resolveNamedCompany(auth: AuthContext, current: ResolvedActiveContext, message: string, decision?: import("@npati/shared").ProjectIntentDecision, conversationText = ""): Promise<ResolvedActiveContext | undefined> {
    const owned: Company[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.listCompanies(auth, 100, cursor);
      owned.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && owned.length < 500);
    // A loose (stem or agent-name) match may only select a company this conversation has already dealt with; any other
    // company needs its full name in the message. "Delete the bakery webhook" must not jump to another "… Bakery".
    const lowerMessage = message.toLocaleLowerCase(), lowerConversation = conversationText.toLocaleLowerCase();
    const companies = owned.filter((company) => {
      const name = company.name.trim().toLocaleLowerCase();
      return company.id === (current.company?.id ?? current.project?.companyId) || (name.length > 2 && (lowerMessage.includes(name) || lowerConversation.includes(name)));
    });
    const creating = decision?.intent === "CREATE_WEBSITE" || decision?.intent === "CREATE_PROJECT";
    // "Create X" names X as the thing to create, not as the place to work ("create NovaScale" when it exists is a
    // duplicate request for the company actions); only a new project for a named company switches.
    if (!creating && /^\s*(?:please\s+)?(?:create|створи|створіть|создай|crie|cria|crea|erstelle|crée|maak)(?![\p{L}])/iu.test(message)) return undefined;
    // Deleting a company names its target, not a place to continue working (the chat would be left inside it).
    if (/^\s*(?:please\s+)?(?:delete|remove|видали|видаліть|удали|exclua|elimina|lösche|supprime)(?![\p{L}])/iu.test(message)) return undefined;
    // An exact owned project named by a code task takes precedence over the previous chat card.
    // Search only authorized companies already selected or named in this conversation.
    if (decision && decision.intent !== "CHAT" && !creating) {
      const candidates = (await Promise.all(companies.map(company => this.store.listProjects(auth, company.id)))).flat()
        .filter(project => !["archived", "soft_deleted", "purging", "deleted"].includes(project.status)
          && project.name.trim().length >= 3 && lowerMessage.includes(project.name.trim().toLocaleLowerCase()));
      if (candidates.length > 1) throw new ContextValidationError("More than one owned project is named; specify a single project for this action");
      const project = candidates[0];
      if (project) return this.resolve(auth, { contextType: "project", companyId: project.companyId, projectId: project.id });
    }
    const activeId = current.company?.id ?? current.project?.companyId ?? null;
    const exactCompanies = companies.filter(company => company.name.trim().length > 2 && lowerMessage.includes(company.name.trim().toLocaleLowerCase()));
    // An explicitly named current company must never be replaced by a coincidental agent-name match ("mark").
    if (exactCompanies.length > 1 || exactCompanies[0]?.id === activeId) return undefined;
    let named = exactCompanies[0] ?? companyNamedInMessage(companies, message, activeId);
    if (!named) {
      // No company name, but an agent's full name that belongs to exactly one company ("have Coach Ana delegate to Leo").
      const lower = message.toLocaleLowerCase();
      // Bounded to the 20 most recently updated companies (the ones the user works with), read in parallel.
      const recent = [...companies].sort((a, b) => new Date(b.updatedAt as unknown as string).getTime() - new Date(a.updatedAt as unknown as string).getTime()).slice(0, 20);
      const owners = new Set<string>();
      await Promise.all(recent.map(async (company) => {
        const agents = (await this.store.listCompanyAgentsPage(auth, company.id, 50).catch(() => ({ items: [] }))).items;
        if (agents.some((agent) => agent.name.trim().length >= 3 && lower.includes(agent.name.trim().toLocaleLowerCase()))) owners.add(company.id);
      }));
      const owner = owners.size === 1 ? [...owners][0] : undefined;
      if (owner && owner !== activeId) named = companies.find((company) => company.id === owner);
    }
    if (!named) return undefined;
    const projects = creating ? [] : (await this.store.listProjects(auth, named.id)).filter((project) => project.status !== "archived");
    const latest = projects.sort((a, b) => new Date(b.updatedAt as unknown as string).getTime() - new Date(a.updatedAt as unknown as string).getTime())[0];
    return latest
      ? this.resolve(auth, { contextType: "project", companyId: named.id, projectId: latest.id })
      : this.resolve(auth, { contextType: "company", companyId: named.id });
  }

  /** A new Project request must not validate or reuse the previous chat's Project. */
  async resolveChat(auth: AuthContext, requested: Parameters<ActiveContextResolver["resolve"]>[1], message: string, decision?: import("@npati/shared").ProjectIntentDecision): Promise<ResolvedActiveContext> {
    const validated = validateActiveContext(requested ?? {});
    const intent = decision ?? defaultHybridRouter.classifyProject({ message, activeCompanyId: validated.companyId, activeProjectId: validated.projectId });
    if (validated.projectId && (intent.intent === "CREATE_WEBSITE" || intent.intent === "CREATE_PROJECT")) {
      return this.resolve(auth, { contextType: "company", companyId: validated.companyId });
    }
    return this.resolve(auth, requested);
  }

  async resolve(
    auth: AuthContext,
    requested?: {
      contextType?: ContextType | string;
      businessId?: string | null;
      companyId?: string | null;
      projectId?: string | null;
    }
  ): Promise<ResolvedActiveContext> {
    const validated = validateActiveContext(requested ?? {});
    const timestamp = new Date().toISOString();

    if (validated.contextType === "project" || validated.projectId) {
      if (!validated.projectId) {
        throw new ContextValidationError("projectId is required for project context");
      }
      if (!validated.companyId) {
        throw new ContextValidationError("companyId is required for project context");
      }
      const company = await this.store.getCompany(auth, validated.companyId);
      if (!company) {
        throw new WorkspaceAccessError(`Company not found or access denied: ${validated.companyId}`);
      }
      let project: Project | undefined;
      try {
        project = await this.store.getProject(auth, validated.companyId, validated.projectId);
      } catch {
        project = undefined;
      }
      if (!project || project.companyId !== company.id) {
        if (validated.contextType === "project") {
          throw new WorkspaceAccessError(`Project not found or does not belong to company: ${validated.projectId}`);
        }
        return this.resolve(auth, {
          contextType: "company",
          companyId: company.id,
          businessId: company.businessId ?? null,
        });
      }
      if (project.status === "archived") {
        if (validated.contextType === "project") {
          throw new ContextValidationError(`Cannot set active context to an archived project: ${validated.projectId}`);
        }
        return this.resolve(auth, {
          contextType: "company",
          companyId: company.id,
          businessId: company.businessId ?? null,
        });
      }
      let business: Business | undefined;
      if (company.businessId) {
        try {
          business = await this.store.getBusiness(auth, company.businessId);
        } catch {
          // Business may not be accessible or deleted
        }
      }
      const snapshot: RunContextSnapshot = {
        contextType: "project",
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        companyId: company.id,
        businessId: company.businessId ?? null,
        projectId: project.id,
        agentId: company.mainAgentId ?? null,
        companyRevision: company.revision,
        capturedAt: timestamp,
      };
      return {
        context: {
          contextType: "project",
          companyId: company.id,
          businessId: company.businessId ?? null,
          projectId: project.id,
          workspaceId: auth.workspaceId,
        },
        company,
        business,
        project,
        snapshot,
      };
    }

    if (validated.contextType === "company") {
      if (!validated.companyId) {
        throw new ContextValidationError("companyId is required for company context");
      }
      // Assert company ownership and access within auth.workspaceId
      const company = await this.store.getCompany(auth, validated.companyId);
      if (!company) {
        throw new WorkspaceAccessError(`Company not found or access denied: ${validated.companyId}`);
      }

      let business: Business | undefined;
      if (company.businessId) {
        try {
          business = await this.store.getBusiness(auth, company.businessId);
        } catch {
          // Business may not be accessible or deleted
        }
      }

      const snapshot: RunContextSnapshot = {
        contextType: "company",
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        companyId: company.id,
        businessId: company.businessId ?? null,
        agentId: company.mainAgentId ?? null,
        companyRevision: company.revision,
        capturedAt: timestamp,
      };

      return {
        context: {
          contextType: "company",
          companyId: company.id,
          businessId: company.businessId ?? null,
        },
        company,
        business,
        snapshot,
      };
    }

    if (validated.contextType === "business") {
      if (validated.businessId) {
        // Assert business ownership and access within auth.workspaceId
        const business = await this.store.getBusiness(auth, validated.businessId);
        if (!business) {
          throw new WorkspaceAccessError(`Business not found or access denied: ${validated.businessId}`);
        }

        const snapshot: RunContextSnapshot = {
          contextType: "business",
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          companyId: null,
          businessId: business.id,
          capturedAt: timestamp,
        };

        return {
          context: {
            contextType: "business",
            companyId: null,
            businessId: business.id,
          },
          business,
          snapshot,
        };
      }

      // Business onboarding / creation phase before businessId is assigned
      const snapshot: RunContextSnapshot = {
        contextType: "business",
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        companyId: null,
        businessId: null,
        capturedAt: timestamp,
      };

      return {
        context: {
          contextType: "business",
          companyId: null,
          businessId: null,
        },
        snapshot,
      };
    }

    // Neutral context ('none')
    const snapshot: RunContextSnapshot = {
      contextType: "none",
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      companyId: null,
      businessId: null,
      capturedAt: timestamp,
    };

    return {
      context: {
        contextType: "none",
        companyId: null,
        businessId: null,
      },
      snapshot,
    };
  }
}
