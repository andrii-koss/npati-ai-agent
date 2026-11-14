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
  /** Bounded same-company read/preview batch; never an ambiguous source-write target. */
  projects?: Project[];
  /** The user named these projects together ("в обох", "both"): a change applies to each of them in turn. */
  pluralReference?: boolean;
  snapshot: RunContextSnapshot;
}

/** A clause that keeps a project unchanged ("не змінюй", "preserve", "keep", "no cambies") names it as context, not as the target. */
const preservingClause = /(?:не\s+(?:змінюй|чіпай|редагуй|меняй|трогай)|збережи|залиш|сохрани|оставь|don'?t\s+(?:change|touch|edit|modify)|do\s+not\s+(?:change|touch|edit|modify)|\bkeep\b|\bpreserve\b|\bleave\b|nicht\s+ändern|no\s+(?:cambies|toques)|não\s+(?:altere|mude|toque)|mantén|mantenha|conserva|preserva)/iu;
const nameWords = (value: string) => value.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? [];
const GENERIC_NAME_WORDS = new Set(["company", "companies", "business", "businesses", "group", "компанія", "компанії", "компанію", "компанией", "компания", "компании", "бізнес", "бизнес", "unternehmen", "firma", "empresa", "société", "societe", "azienda"]);
/** A proper name as written (case-sensitive) and as whole words: "add" or "new" in ordinary text never names "Add" or "New". */
/** "this empty test project": the words describe the open project, even when another project is called Test. */
const refersToCurrentProject = (lowerMessage: string, lowerName: string) => {
  const escaped = lowerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:this|current|цей|цьому|цього|поточн\\p{L}*|этот|этом|этого|текущ\\p{L}*)\\s+(?:\\p{L}+\\s+){0,3}${escaped}\\s+(?:project|website|site|app|проєкт\\p{L}*|сайт\\p{L}*|проект\\p{L}*)`, "u").test(lowerMessage);
};

/** "Change the title to My Tasks": the words are the new value, even when another project is called My Tasks. */
const namesNewValue = (lowerMessage: string, lowerName: string) => {
  const escaped = lowerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}])(?:change|rename|set|update|replace|make|зміни\\p{L}*|поміняй|заміни\\p{L}*|перейменуй|встанови|зроби|измени\\p{L}*|поменяй|замени\\p{L}*|переименуй|сделай)(?![\\p{L}]).*(?<![\\p{L}])(?:to|as|into|на|в|во)\\s+["'«“]?${escaped}(?![\\p{L}\\p{N}])`, "u").test(lowerMessage);
};

const mentions = (text: string, name: string) => {
  const trimmed = name.trim();
  return trimmed.length > 2 && new RegExp(`(?<![\\p{L}\\p{N}])${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(text);
};

/**
 * The one owned company a message names, when it is not the active one: "build a landing page for Nordic Fit" while
 * the bakery's site is open. A name word matches an inflected message word by its stem (Ukrainian "пекарні" names
 * "Пекарня"); only words of five or more letters count, so short generic words ("New", "Fit") never switch context.
 * Returns undefined when no company or more than one company scores best, or when the active company scores as well.
 */
/** New projects are often just called "Сайт" or "App": in a message such a word means the thing, unless the name is quoted. */
export const GENERIC_PROJECT_NAME = /^(?:блог|blog|магазин|shop|store|лендинг|landing|crm|срм|гра|game|мобільний додаток|mobile app|сайт|веб-?сайт|додаток|застосунок|проєкт|проект|приложение|site|website|web ?site|app|application|project|webseite|sitio|aplicación|proyecto|aplicativo|projeto|strona|aplikacja|projekt|anwendung|application|projet|sito|applicazione|progetto|サイト|アプリ|网站|应用|项目|site web|uygulama|proje|web sitesi)$/iu;
export const quotesName = (message: string, name: string) => ["«»", '""', "“”", "''", "``"].some(([open, close]) => message.toLocaleLowerCase().includes(open! + name.toLocaleLowerCase() + close!));

export function companyNamedInMessage<T extends { id: string; name: string }>(companies: T[], message: string, activeCompanyId?: string | null): T | undefined {
  const words = nameWords(message);
  // Generic words in a company name are not its name: "the company inbox" picked "V6TEST_Company_…" (V6 step 12).
  const score = (company: T) => nameWords(company.name).filter((word) => word.length >= 5 && !GENERIC_NAME_WORDS.has(word))
    .filter((word) => { const stem = word.slice(0, Math.max(4, word.length - 2)); return words.some((candidate) => candidate.startsWith(stem)); }).length;
  const scored = companies.map((company) => ({ company, score: score(company) })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || scored[1]?.score === best.score) return undefined;
  const active = activeCompanyId ? scored.find((entry) => entry.company.id === activeCompanyId) : undefined;
  if (best.company.id === activeCompanyId || (active && active.score >= best.score)) return undefined;
  return best.company;
}

/** The question for a name several projects share: which one, with the company and last change that tell them apart. */
function sameNameQuestion(message: string, projects: Project[], companies: Company[]): string {
  const uk = /[Ѐ-ӿ]/u.test(message);
  // The dates come as Date objects: String(date).slice(0, 10) gave "Fri Nov 13" for both projects, so the person could not
  // tell them apart (V6 D08-04). Minutes, the stack and a short id do.
  const when = (value: unknown) => { const date = value instanceof Date ? value : new Date(String(value ?? "")); return Number.isNaN(date.getTime()) ? "?" : date.toISOString().slice(0, 16).replace("T", " ") + " UTC"; };
  const list = projects.slice(0, 6).map(p => `«${p.name}» — ${companies.find(c => c.id === p.companyId)?.name ?? p.companyId}, ${p.framework ? p.framework + ", " : ""}${uk ? "створено" : "created"} ${when(p.createdAt)}, ${uk ? "змінено" : "changed"} ${when(p.updatedAt)}, id ${p.id.slice(0, 8)}`).join("; ");
  return uk ? `Знайдено кілька проєктів із назвою «${projects[0]!.name}»: ${list}. Відкрийте чат потрібного проєкту або назвіть його однозначно.`
    : `More than one owned project is named “${projects[0]!.name}”: ${list}. Open the chat of the project you mean or name it unambiguously.`;
}

export class ActiveContextResolver {
  constructor(private readonly store: WorkspaceStore) {}

  /**
   * Switches the chat context to another owned company the message names (see companyNamedInMessage): that company's
   * most recently updated project for follow-up work, or the company itself for a new project.
   */
  async ownedCompanies(auth: AuthContext): Promise<Company[]> {
    const owned: Company[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.listCompanies(auth, 100, cursor);
      owned.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && owned.length < 500);
    return owned;
  }

  /** Owned companies whose exact name the message contains (case-sensitive whole words). */
  async companiesNamedIn(auth: AuthContext, message: string): Promise<Company[]> {
    return (await this.ownedCompanies(auth)).filter((company) => mentions(message, company.name));
  }

  async businessesNamedIn(auth: AuthContext, message: string): Promise<Business[]> {
    return (await this.store.listUserBusinesses(auth)).filter((business) => mentions(message, business.name));
  }

  async agentsNamedIn(auth: AuthContext, companyId: string, message: string) {
    return (await this.store.listCompanyAgentsPage(auth, companyId, 50)).items.filter(agent => mentions(message, agent.name));
  }

  async resolveNamedCompany(auth: AuthContext, current: ResolvedActiveContext, message: string, decision?: import("@npati/shared").ProjectIntentDecision, conversationText = "", options?: { deferProjectAmbiguity?: boolean; conversationProjectIds?: () => Promise<string[]> }): Promise<ResolvedActiveContext | undefined> {
    const owned: Company[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.listCompanies(auth, 100, cursor);
      owned.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && owned.length < 500);
    // A loose (stem or agent-name) match may only select a company this conversation has already dealt with; any other
    // company needs its full name in the message. "Delete the bakery webhook" must not jump to another "… Bakery".
    const lowerMessage = message.toLocaleLowerCase();
    const companies = owned.filter((company) => company.id === (current.company?.id ?? current.project?.companyId)
      || mentions(message, company.name) || mentions(conversationText, company.name));
    const creating = decision?.intent === "CREATE_WEBSITE" || decision?.intent === "CREATE_PROJECT";
    // "Create X" names X as the thing to create, not as the place to work ("create NovaScale" when it exists is a
    // duplicate request for the company actions); only a new project for a named company switches.
    if (!creating && /^\s*(?:please\s+)?(?:create|створи|створіть|создай|crie|cria|crea|erstelle|crée|maak)(?![\p{L}])/iu.test(message)) return undefined;
    // Deleting a company names its target, not a place to continue working (the chat would be left inside it).
    // Removing data inside a named project ("Remove only field test_note from Next Shop") still targets that project.
    const removesProjectData = /(?<![\p{L}])(?:field|column|table|row|record|поле|колонк\p{L}*|таблиц\p{L}*|рядок|запис\p{L}*|campo|columna|coluna|tabla|tabela|fila|linha|feld|spalte|tabelle|zeile)(?![\p{L}])/iu.test(message);
    if (!removesProjectData && /^\s*(?:please\s+)?(?:delete|remove|видали|видаліть|удали|exclua|elimina|lösche|supprime)(?![\p{L}])/iu.test(message)) return undefined;
    // An exact owned project named by a code task takes precedence over the previous chat card.
    // Search only authorized companies already selected or named in this conversation.
    // A question or record task can name the project too ("delete row X in Next Shop"), so CHAT does not skip it.
    if (!creating) {
      const ownedProjects = (await Promise.all(companies.map(company => this.store.listProjects(auth, company.id)))).flat();
      // An explicit location is authoritative even if the named project has been deleted. Never fall back to
      // the active sibling. Quoted replacement text (e.g. change heading to "Welcome") is not a location.
      if (["EDIT_WEBSITE", "EDIT_PROJECT", "ADD_FEATURE", "FIX_BUG", "ADD_DATA_MODEL", "EDIT_DATA_MODEL", "PREVIEW_PROJECT", "REVIEW_PROJECT", "TEST_PROJECT"].includes(decision?.intent ?? "")) {
        const references = [...message.matchAll(/(?:^\s*in\s+|\b(?:project|website|site)\s+|(?:проєкт[іу]?|сайт[іу]?)\s+)[«"“]([^»"”\n]+)[»"”]/giu)].map(match => match[1]!.trim());
        for (const name of references) {
          if (owned.some(company => company.name.toLocaleLowerCase() === name.toLocaleLowerCase())) continue;
          if (!ownedProjects.some(project => project.name.toLocaleLowerCase() === name.toLocaleLowerCase()
            && !["archived", "soft_deleted", "purging", "deleted"].includes(project.status))) {
            throw new ContextValidationError("Explicitly named project not found or unavailable: " + name + ". Select an existing project before continuing.");
          }
        }
      }
      let candidates = ownedProjects
        .filter(project => !["archived", "soft_deleted", "purging", "deleted"].includes(project.status)
          && project.name.trim().length >= 3 && mentions(lowerMessage, project.name.trim().toLocaleLowerCase())
          && !(GENERIC_PROJECT_NAME.test(project.name.trim()) && !quotesName(message, project.name.trim()))
          // "this empty test project" points at the open project; it does not name a project called Test.
          && !(current.project && current.project.id !== project.id
            && (refersToCurrentProject(lowerMessage, project.name.trim().toLocaleLowerCase()) || namesNewValue(lowerMessage, project.name.trim().toLocaleLowerCase()))));
      // "Add a bonus to «Game»; do not change «Site»": a project named only where the request preserves it is not the target (P037).
      const clauses = lowerMessage.split(/[.;!?\n]+/u);
      const targets = candidates.filter(project => clauses.some(clause => clause.includes(project.name.trim().toLocaleLowerCase()) && !preservingClause.test(clause)));
      if (candidates.length > 1 && targets.length === 1) candidates = targets;
      // Several projects share the one name the request uses ("My Tasks"): the chat's own project is the one meant,
      // then a single same-named project this conversation worked in. Otherwise the user chooses; nothing is guessed.
      const sameName = candidates.length > 1 && new Set(candidates.map(p => p.name.trim().toLocaleLowerCase())).size === 1;
      if (sameName && current.project && candidates.some(p => p.id === current.project!.id)) return undefined;
      if (sameName && options?.conversationProjectIds) {
        const ids = new Set(await options.conversationProjectIds());
        const worked = candidates.filter(p => ids.has(p.id));
        if (worked.length === 1) return this.resolve(auth, { contextType: "project", companyId: worked[0]!.companyId, projectId: worked[0]!.id });
      }
      // "Connect the app to the site's database" names two projects; work continues in the open one when it is among them.
      if (candidates.length > 1 && current.project && candidates.some(p => p.id === current.project!.id)) return undefined;
      if (candidates.length > 1) {
        // The preliminary lookup only supplies a unique project to the semantic router.
        // Resolve ambiguity after that router has classified the complete request.
        if (options?.deferProjectAmbiguity) return undefined;
        if (["PREVIEW_PROJECT", "REVIEW_PROJECT", "TEST_PROJECT"].includes(decision?.intent ?? "") && candidates.length <= 4
          && new Set(candidates.map(p => p.companyId)).size === 1
          && new Set(candidates.map(p => p.name.trim().toLocaleLowerCase())).size === candidates.length) {
          return { ...await this.resolve(auth, { contextType: "company", companyId: candidates[0]!.companyId }), projects: candidates };
        }
        if (sameName) throw new ContextValidationError(sameNameQuestion(message, candidates, owned));
        throw new ContextValidationError("More than one owned project is named; specify a single project for this action");
      }
      const project = candidates[0];
      if (project) return this.resolve(auth, { contextType: "project", companyId: project.companyId, projectId: project.id });
    }
    const activeId = current.company?.id ?? current.project?.companyId ?? null;
    const exactCompanies = companies.filter(company => mentions(message, company.name));
    // An explicitly named current company must never be replaced by a coincidental agent-name match ("mark").
    if (exactCompanies.length > 1) return undefined;
    if (exactCompanies[0]?.id === activeId) {
      // A Company is a first-class selection. Naming it in a chat/read/management task must not retain an
      // unrelated historical Project merely because that Project belongs to the same Company.
      return decision?.intent === "CHAT" && current.project ? this.resolve(auth, { contextType: "company", companyId: activeId }) : undefined;
    }
    let named = exactCompanies[0] ?? companyNamedInMessage(companies, message, activeId);
    if (!named) {
      // No company name, but an agent's full name that belongs to exactly one company ("have Coach Ana delegate to Leo").
      // Bounded to the 20 most recently updated companies (the ones the user works with), read in parallel.
      const recent = [...companies].sort((a, b) => new Date(b.updatedAt as unknown as string).getTime() - new Date(a.updatedAt as unknown as string).getTime()).slice(0, 20);
      const owners = new Set<string>();
      await Promise.all(recent.map(async (company) => {
        const agents = (await this.store.listCompanyAgentsPage(auth, company.id, 50).catch(() => ({ items: [] }))).items;
        // Only a distinctive name (several words or 5+ letters) addresses an agent; "Add" or "Mark" are ordinary verbs.
        if (agents.some((agent) => (/\s/.test(agent.name.trim()) || agent.name.trim().length >= 5) && mentions(message, agent.name))) owners.add(company.id);
      }));
      const owner = owners.size === 1 ? [...owners][0] : undefined;
      if (owner && owner !== activeId) named = companies.find((company) => company.id === owner);
    }
    if (!named) return undefined;
    // Updated-at ordering is not evidence of the user's intended entity. A Project is selected only by its
    // explicit owned reference above or by this conversation's validated selection, never by Company recency.
    return this.resolve(auth, { contextType: "company", companyId: named.id });
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
          businessId: null,
        });
      }
      if (project.status === "archived") {
        if (validated.contextType === "project") {
          throw new ContextValidationError(`Cannot set active context to an archived project: ${validated.projectId}`);
        }
        return this.resolve(auth, {
          contextType: "company",
          companyId: company.id,
          businessId: null,
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
          businessId: null,
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
          businessId: null,
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
