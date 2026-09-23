import { createHash } from "node:crypto";
import type { AuthContext, Company, CompanyAgent, CompanyAgentInput, CompanyInput, WorkspaceStore } from "@npati/workspace";
import { companyChatCopy, detectCompanyChatLanguage, insertCompanyName, isLocalizedCompanyManagementRequest } from "./company-chat-i18n";
import { defaultLocalizedAgentProfiles } from "./company-agent-profile-i18n";
import { companyDeleteCopy, isCompanyDeleteConfirmed } from "./company-delete-i18n";

type CompanyOperation = "create" | "update" | "delete";
type AgentOperation = CompanyOperation;
type AgentDirective = {
  action: AgentOperation;
  agentId?: string;
  agentName?: string;
  fields?: Record<string, unknown>;
  parentAgentId?: string | null;
  parentAgentName?: string | null;
  main?: boolean;
};
type CompanyDirective = {
  action: CompanyOperation;
  companyId?: string;
  companyName?: string;
  fields?: Record<string, unknown>;
  agents?: AgentDirective[];
  mainAgentId?: string | null;
  mainAgentName?: string | null;
};

const companyFields = new Set(["name", "businessId", "website", "industry", "description", "productsServices", "languages", "brandTone", "companyInstructions", "status"]);
const agentFields = new Set(["name", "role", "description", "systemInstruction", "promptGuidelines", "recommendedPrompts", "modelId", "fallbackModelId", "tools", "isActive", "sortOrder", "positionX", "positionY"]);
const toolIds = new Set(["storage.agent_knowledge_retrieval", "storage.company_memory", "research.web_search", "browser.web_fetch", "web.crawl", "mcp", "files", "system.text-to-speech", "exec"]);
const toolAliases = new Map([
  ["knowledge", "storage.agent_knowledge_retrieval"],
  ["company memory", "storage.company_memory"],
  ["web search", "research.web_search"],
  ["web fetch", "browser.web_fetch"],
  ["crawler", "web.crawl"],
  ["mcp", "mcp"],
  ["files", "files"],
  ["text to speech", "system.text-to-speech"],
  ["code mode exec", "exec"],
]);

const deleteMutationSignal = /(?:видал|приб|удал|убер|\bdelete\b|\bremove\b|supprim|effac|lösch|entfern|elimin|borr|usuń|skasuj|exclu|apagar|verwijder|sil|kaldır|删除|削除|삭제|احذف|إزالة|हटा)/iu;
const selectedDeleteReferenceSignal = /(?:її|його|їх|це\s+все|все\s+це|усе\s+це|щойно\s+створен\p{L}*|ее|его|их|это\s+вс[её]|вс[её](?:\s+это|\s*,?\s*что)|только\s+что\s+создан\p{L}*|\bit\b|\bthis\s+one\b|\beverything\b|\ball\s+(?:of\s+it|this)\b|what\s+(?:you|was)\s+just\s+created|tout\s+(?:cela|ça|ce\s+que)|alles|todo\s+(?:esto|lo\s+que)|tutto\s+(?:questo|ciò)|wszystko|tudo\s+(?:isso|o\s+que)|dit\s+allemaal|hepsini|tümünü|her\s+şeyi|全部|这一切|すべて|全て|모두|전부|모든\s+것|كل\s+(?:شيء|هذا|ما)|सब\s+(?:कुछ|चीज़ें)|यह\s+सब)/iu;

function normalizedLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_\-/]+/g, " ").replace(/[^\p{L}\p{N} .]+/gu, "").trim();
}

function normalizeTool(value: string): string {
  if (toolIds.has(value)) return value;
  const label = normalizedLabel(value)
    .replace(/\b(?:low|medium|high|critical)\b/giu, "")
    .replace(/\bapproval required\b/giu, "")
    .replace(/\s+/g, " ")
    .trim();
  return toolAliases.get(label) ?? value;
}

const agentFieldAliases: Record<string, string> = {
  systeminstruction: "systemInstruction",
  systemprompt: "systemInstruction",
  promptguidelines: "promptGuidelines",
  recommendedprompts: "recommendedPrompts",
  toolsandcapabilities: "tools",
  toolscapabilities: "tools",
  capabilities: "tools",
  toolids: "tools",
  modelid: "modelId",
  fallbackmodelid: "fallbackModelId",
  isactive: "isActive",
  sortorder: "sortOrder",
  positionx: "positionX",
  positiony: "positionY",
};

const companyFieldAliases: Record<string, string> = {
  companyname: "name",
  businessid: "businessId",
  products: "productsServices",
  services: "productsServices",
  productsandservices: "productsServices",
  productservices: "productsServices",
  brandtone: "brandTone",
  instructions: "companyInstructions",
  companyinstructions: "companyInstructions",
};

function compactKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeCompanyFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (rawValue === null || rawValue === undefined) continue;
    const key = companyFieldAliases[compactKey(rawKey)] ?? rawKey;
    let item = rawValue;
    if (key === "languages" && typeof item === "string") item = item.split(/\r?\n|,/).map((part) => part.trim()).filter(Boolean);
    if (key === "status" && typeof item === "string") item = item.toLocaleLowerCase();
    result[key] = item;
  }
  return result;
}

function normalizeAgentFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const expanded: Record<string, unknown> = { ...source };
  if (source.instructions && typeof source.instructions === "object" && !Array.isArray(source.instructions)) {
    Object.assign(expanded, source.instructions);
    delete expanded.instructions;
  } else if (typeof source.instructions === "string" && source.systemInstruction === undefined) {
    expanded.systemInstruction = source.instructions;
    delete expanded.instructions;
  }
  const result: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(expanded)) {
    if (rawValue === null || rawValue === undefined) continue;
    const key = agentFieldAliases[compactKey(rawKey)] ?? rawKey;
    let item = rawValue;
    if (key === "recommendedPrompts" && typeof item === "string") {
      item = item.split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
    }
    if (key === "tools" && typeof item === "string") {
      item = item.split(/\r?\n|,/).map((part) => part.trim()).filter(Boolean);
    }
    if (key === "tools" && Array.isArray(item)) item = item
      .map((part) => typeof part === "string" ? normalizeTool(part) : part)
      .filter((part): part is string => typeof part === "string" && toolIds.has(part));
    result[key] = item;
  }
  return result;
}

function operation(value: unknown, fallback: CompanyOperation): CompanyOperation {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value ?? fallback).toLocaleLowerCase().replace(/[^a-z]/g, "");
  if (["create", "add", "new", "createcompany", "createagent"].includes(normalized)) return "create";
  if (["update", "edit", "change", "modify", "updatecompany", "updateagent"].includes(normalized)) return "update";
  if (["delete", "remove", "deletecompany", "deleteagent"].includes(normalized)) return "delete";
  throw new Error("Invalid company action");
}

function requestedAgentCount(message: string, raw: Record<string, unknown>): number | undefined {
  const explicit = Number(raw.agentCount ?? raw.agentsCount ?? raw.numberOfAgents);
  if (Number.isInteger(explicit) && explicit > 0 && explicit <= 25) return explicit;
  const match = message.match(/(\d{1,2})\s+(?:[\p{L}'’-]+\s+){0,2}(?:агент|agent)/iu)
    ?? message.match(/(?:агент|agent)[\p{L}'’ -]{0,20}(\d{1,2})/iu);
  const count = Number(match?.[1]);
  return Number.isInteger(count) && count > 0 && count <= 25 ? count : undefined;
}

function defaultAgentProfiles(message: string): Array<{ name: string; role: string; description: string; systemInstruction: string }> {
  return defaultLocalizedAgentProfiles(message);
}

function normalizeDirective(value: unknown, requestMessage: string): CompanyDirective {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid company action");
  const raw = value as Record<string, unknown>;
  const action = operation(raw.action, "create");
  const nestedCompany = raw.company && typeof raw.company === "object" && !Array.isArray(raw.company) ? raw.company : undefined;
  const companySource = raw.fields ?? nestedCompany ?? {
    name: raw.name ?? raw.companyName,
    industry: raw.industry,
    description: raw.description,
    productsServices: raw.productsServices,
    languages: raw.languages,
    brandTone: raw.brandTone,
    companyInstructions: raw.companyInstructions,
    status: raw.status,
  };
  const rawAgents = Array.isArray(raw.agents) ? raw.agents : [];
  const agents: AgentDirective[] = rawAgents.slice(0, 25).map((entry, index) => {
    const agent = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const agentAction = operation(agent.action, action === "create" ? "create" : "update");
    const flatFields = Object.fromEntries(Object.entries(agent).filter(([key]) => agentFields.has(agentFieldAliases[compactKey(key)] ?? key) || key === "instructions"));
    const normalizedFields = normalizeAgentFields(agent.fields ?? flatFields) as Record<string, unknown>;
    return {
      action: agentAction,
      agentId: typeof agent.agentId === "string" ? agent.agentId : undefined,
      agentName: typeof agent.agentName === "string" ? agent.agentName : undefined,
      fields: normalizedFields,
      parentAgentId: typeof agent.parentAgentId === "string" || agent.parentAgentId === null ? agent.parentAgentId : undefined,
      parentAgentName: typeof agent.parentAgentName === "string" || agent.parentAgentName === null ? agent.parentAgentName : undefined,
      main: agent.main === true || index === 0 && action === "create",
    };
  });
  if (action === "create") {
    const agentGroup = raw.agents && typeof raw.agents === "object" && !Array.isArray(raw.agents) ? raw.agents as Record<string, unknown> : undefined;
    const count = requestedAgentCount(requestMessage, { ...raw, agentCount: raw.agentCount ?? agentGroup?.count ?? agentGroup?.agentCount }) ?? agents.length;
    const profiles = defaultAgentProfiles(requestMessage);
    for (let index = 0; index < count; index++) {
      const profile = profiles[index % profiles.length]!;
      const current = agents[index];
      if (current) {
        current.action = "create";
        current.fields = { ...profile, ...current.fields };
        current.main = index === 0;
      } else {
        const suffix = index >= profiles.length ? ` ${Math.floor(index / profiles.length) + 1}` : "";
        agents.push({ action: "create", fields: { ...profile, name: profile.name + suffix }, main: index === 0, ...(index > 0 ? { parentAgentName: String(agents[0]?.fields?.name ?? profiles[0]!.name) } : {}) });
      }
    }
  }
  return {
    action,
    companyId: typeof raw.companyId === "string" ? raw.companyId : undefined,
    companyName: typeof raw.companyName === "string" ? raw.companyName : undefined,
    fields: normalizeCompanyFields(companySource) as Record<string, unknown>,
    agents,
    mainAgentId: typeof raw.mainAgentId === "string" || raw.mainAgentId === null ? raw.mainAgentId : undefined,
    mainAgentName: typeof raw.mainAgentName === "string" || raw.mainAgentName === null ? raw.mainAgentName : undefined,
  };
}

function safeMarkdown(value: unknown): string {
  return String(value ?? "").replace(/```/g, "'''").trim();
}

function companyResultMessage(action: CompanyOperation, company: Company, agents: CompanyAgent[], requestMessage = ""): string {
  const labels = companyChatCopy(requestMessage);
  const companyName = safeMarkdown(company.name);
  if (action === "delete") return insertCompanyName(labels.deleted, companyName);

  const mainAgent = agents.find((agent) => agent.id === company.mainAgentId);
  const value = (item: unknown) => safeMarkdown(item) || labels.notSpecified;
  const status = company.status === "active" ? labels.active : labels.inactive;
  const agentLines = agents.length
    ? agents.map((agent, index) => `${index + 1}. **${safeMarkdown(agent.name)}** - ${safeMarkdown(agent.role)}${agent.id === mainAgent?.id ? ` (${labels.mainAgent})` : ""}${agent.description ? `\n   ${safeMarkdown(agent.description)}` : ""}`).join("\n")
    : labels.noAgents;
  const companyUrl = `/settings/company?company=${encodeURIComponent(company.id)}`;
  const intro = action === "create"
    ? insertCompanyName(labels.created, companyName)
    : insertCompanyName(labels.updated, companyName);
  return `${intro}\n\n${labels.configured}\n\n\`\`\`card:${labels.company}: ${companyName}
**${labels.name}:** ${value(company.name)}
**${labels.status}:** ${status}
**${labels.industry}:** ${value(company.industry)}
**${labels.website}:** ${value(company.website)}
**${labels.languages}:** ${company.languages.length ? company.languages.map(safeMarkdown).join(", ") : labels.notSpecified}
**${labels.brandTone}:** ${value(company.brandTone)}

### ${labels.description}
${value(company.description)}

### ${labels.products}
${value(company.productsServices)}

### ${labels.agents} (${agents.length})
${agentLines}

[${labels.openSettings}](${companyUrl})
\`\`\`\n\n${labels.nextStep}`;
}

function fields(value: unknown, allowed: Set<string>, kind: string): Record<string, unknown> {
  if (kind === "company") value = normalizeCompanyFields(value);
  if (kind === "agent") value = normalizeAgentFields(value);
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${kind} fields must be an object`);
  const input = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => allowed.has(key)));
  for (const [key, item] of Object.entries(input)) {
    if (["languages", "recommendedPrompts", "tools"].includes(key)) {
      if (!Array.isArray(item) || item.length > 30 || item.some((part) => typeof part !== "string" || part.length > 500)) throw new Error(`Invalid ${key}`);
    } else if (["isActive"].includes(key)) {
      if (typeof item !== "boolean") throw new Error(`Invalid ${key}`);
    } else if (["sortOrder", "positionX", "positionY"].includes(key)) {
      if (typeof item !== "number" || !Number.isFinite(item) || Math.abs(item) > 100000) throw new Error(`Invalid ${key}`);
    } else if (key === "status") {
      if (item !== "active" && item !== "inactive") throw new Error("Invalid company status");
    } else if (typeof item !== "string" || item.length > (key === "companyInstructions" || key === "systemInstruction" ? 12000 : 4000)) {
      throw new Error(`Invalid ${key}`);
    }
  }
  if (Array.isArray(input.tools) && input.tools.some((id) => !toolIds.has(id))) throw new Error("Use only supported agent tools");
  return input;
}

async function ownedCompany(store: WorkspaceStore, auth: AuthContext, directive: CompanyDirective, selectedCompanyId?: string): Promise<Company> {
  if (directive.companyId) return store.getCompany(auth, directive.companyId);
  if (!directive.companyName?.trim() && selectedCompanyId) return store.getCompany(auth, selectedCompanyId);
  const name = directive.companyName?.trim().toLocaleLowerCase();
  if (!name) throw new Error("Specify the company name or ID");
  let cursor: string | undefined;
  const matches: Company[] = [];
  do {
    const page = await store.listCompanies(auth, 100, cursor);
    matches.push(...page.items.filter((company) => company.name.toLocaleLowerCase() === name));
    cursor = page.nextCursor ?? undefined;
    if (matches.length > 1) break;
  } while (cursor);
  if (matches.length !== 1) throw new Error(matches.length ? "More than one company has this name; use its ID" : "Company not found in your account");
  return matches[0]!;
}

function findAgent(agents: CompanyAgent[], id?: string | null, name?: string | null, fallbackId?: string): CompanyAgent {
  if (!id && !name && fallbackId) id = fallbackId;
  if (!id && !name && agents.length === 1) return agents[0]!;
  const matches = id ? agents.filter((agent) => agent.id === id) : agents.filter((agent) => agent.name.toLocaleLowerCase() === name?.trim().toLocaleLowerCase());
  if (matches.length !== 1) throw new Error(matches.length ? "More than one agent has this name; use its ID" : "Agent not found in this company");
  return matches[0]!;
}

export class CompanyChatActions {
  static noActionMessage(message: string): string {
    return companyChatCopy(message).noAction;
  }

  static isManagementRequest(message: string): boolean {
    return /(?=[\s\S]*(?:створ|дод|редаг|змін|онов|видал|приб|налашт|признач|нада|доповн|заповн|зроб|побуд|засну|організ)\p{L}*)(?=[\s\S]*(?:компан|агент|пол|інструкц|промпт|рол|можливост)\p{L}*)/iu.test(message)
      || /(?=[\s\S]*(?:созда|добав|редакт|измен|обнов|удал|убер|настро|назнач|предостав|допол)\p{L}*)(?=[\s\S]*(?:компан|агент|инструкц|промпт|рол|возможност)\p{L}*)/iu.test(message)
      || /\b(?:create|add|edit|update|change|delete|remove|configure|assign|build|set\s+up)\s+(?:(?:a|an|the|my|new|main|another|me)\s+){0,3}(?:compan(?:y|ies)|agents?|orchestrator|agent\s+(?:team|network))\b/i.test(message)
      || /(?:компан\p{L}*|агент\p{L}*)\s+(?:мені\s+|для\s+мене\s+)?(?:створ\p{L}*|дод\p{L}*|редаг\p{L}*|онов\p{L}*|видал\p{L}*)/iu.test(message)
      || isLocalizedCompanyManagementRequest(message);
  }

  static isPotentialMutationRequest(message: string): boolean {
    const mutation = /(?:заповн|дод|змін|онов|редаг|налашт|признач|нада|видал|приб|созда|добав|измен|обнов|редакт|настро|назнач|предостав|удал|fill|set|add|change|update|edit|configure|assign|remove|delete)/iu.test(message);
    const companyField = /(?:recommended\s+prompts?|system\s+instructions?|prompt\s+guidelines?|tools?\s*(?:&|and)?\s*capabilities|instructions?|agents?|roles?|models?|пол|інструкц|промпт|можливост|агент|рол|модел|инструкц|возможност)/iu.test(message);
    const deleteReference = deleteMutationSignal.test(message) && selectedDeleteReferenceSignal.test(message);
    return mutation && companyField || deleteReference;
  }

  static async deleteConfirmationMessage(auth: AuthContext, store: WorkspaceStore, message: string, selectedCompanyId?: string): Promise<string | undefined> {
    const deleteRequest = deleteMutationSignal.test(message)
      && (/(?:компан|compan)/iu.test(message) || selectedDeleteReferenceSignal.test(message));
    const confirmed = isCompanyDeleteConfirmed(message);
    if (!deleteRequest || confirmed) return undefined;
    const language = detectCompanyChatLanguage(message);
    const labels = companyDeleteCopy(language);
    if (selectedCompanyId) {
      const company = await store.getCompany(auth, selectedCompanyId);
      return companyDeleteCopy(language, safeMarkdown(company.name)).selected;
    }
    const companies = (await store.listCompanies(auth, 100)).items;
    if (!companies.length) return labels.none;
    const names = companies.map((company, index) => `${index + 1}. **${safeMarkdown(company.name)}**`).join("\n");
    return `${labels.choose}\n\n${names}\n\n${labels.command}`;
  }

  static async buildDeterministicAction(auth: AuthContext, store: WorkspaceStore, message: string, selectedCompanyId?: string): Promise<string | undefined> {
    const language = detectCompanyChatLanguage(message);
    const confirmedDelete = isCompanyDeleteConfirmed(message);
    if (selectedCompanyId && confirmedDelete) {
      const company = await store.getCompany(auth, selectedCompanyId);
      return `\`\`\`company-action\n${JSON.stringify({ action: "delete", companyId: company.id })}\n\`\`\``;
    }
    const createCompany = /(?:створ|созда|create)\p{L}*/iu.test(message) && /(?:компан|compan)/iu.test(message);
    const testCompany = /(?:тест|test)/iu.test(message);
    const count = requestedAgentCount(message, {});
    if (createCompany && testCompany && count) {
      const fields = language === "uk"
        ? { name: "Тестова компанія", industry: "Тестування та автоматизація", description: "Тестова компанія для перевірки роботи команди AI-агентів.", productsServices: "Тестування процесів, аналітика та автоматизація", languages: ["Українська"], brandTone: "Професійний і зрозумілий", companyInstructions: "Працювати узгоджено, перевіряти результати та чітко повідомляти про виконані дії." }
        : language === "ru"
          ? { name: "Тестовая компания", industry: "Тестирование и автоматизация", description: "Тестовая компания для проверки работы команды AI-агентов.", productsServices: "Тестирование процессов, аналитика и автоматизация", languages: ["Русский"], brandTone: "Профессиональный и понятный", companyInstructions: "Работать согласованно, проверять результаты и ясно сообщать о выполненных действиях." }
          : { name: "Test Company", industry: "Testing and automation", description: "A test company for validating an AI agent team.", productsServices: "Process testing, analytics, and automation", languages: ["English"], brandTone: "Professional and clear", companyInstructions: "Coordinate work, verify results, and report completed actions clearly." };
      return `\`\`\`company-action\n${JSON.stringify({ action: "create", fields, agentCount: count })}\n\`\`\``;
    }

    const recommendedPrompts = /recommended\s+prompts?/iu.test(message);
    const fillPrompts = /(?:заповн|дод|онов|змін|созда|добав|обнов|измен|fill|add|update|change|set)/iu.test(message);
    if (selectedCompanyId && recommendedPrompts && fillPrompts) {
      const company = await store.getCompany(auth, selectedCompanyId);
      const agents = await store.listCompanyAgents(auth, company.id);
      if (!agents.length) return undefined;
      const updates = agents.map((agent) => {
        const role = agent.role || agent.name;
        const prompts = language === "uk"
          ? [`Склади план роботи для ролі «${role}»`, `Проаналізуй поточний стан і запропонуй наступні кроки`, `Перевір результат роботи та вкажи, що потрібно покращити`]
          : language === "ru"
            ? [`Составь план работы для роли «${role}»`, "Проанализируй текущее состояние и предложи следующие шаги", "Проверь результат работы и укажи, что нужно улучшить"]
            : [`Create a work plan for the ${role} role`, "Analyze the current state and recommend next steps", "Review the result and identify what should be improved"];
        return { action: "update", agentId: agent.id, fields: { recommendedPrompts: prompts } };
      });
      return `\`\`\`company-action\n${JSON.stringify({ action: "update", companyId: company.id, agents: updates })}\n\`\`\``;
    }
    return undefined;
  }

  static async buildActionPlannerPrompt(auth: AuthContext, store: WorkspaceStore, message: string, selectedCompanyId?: string, addedModels: Array<{ id: string; name?: string }> = []): Promise<string> {
    const context = await this.buildSystemPrompt(auth, store, message, selectedCompanyId, addedModels);
    const language = detectCompanyChatLanguage(message);
    return `${context}\n\nThe user's latest message is an explicit company settings request. Its detected language is ${language}. Return ONLY one complete fenced company-action JSON block if the requested change can be made. Write all human-readable company and agent field values in the user's language. Do not describe a completed action in prose. Use a single concrete action value (create, update, or delete), and omit fields that do not apply. For a new company, fields.name is required. Build a useful, complete profile from the user's request: normally include industry, description, productsServices, languages, brandTone, and companyInstructions. Give every new agent a name, role, useful description, and systemInstruction so the created team is ready to use. Do not invent a website, businessId, modelId, fallbackModelId, or existing record ID. Do not use example placeholder values. If an existing target or a destructive request is ambiguous, return exactly NO_ACTION.`;
  }

  static async buildSystemPrompt(auth: AuthContext, store: WorkspaceStore, message = "", selectedCompanyId?: string, addedModels: Array<{ id: string; name?: string }> = []): Promise<string> {
    if (!auth.permissions.includes("business:manage")) return "";
    const page = await store.listCompanies(auth, 30);
    if (selectedCompanyId && !page.items.some((company) => company.id === selectedCompanyId)) {
      page.items.push(await store.getCompany(auth, selectedCompanyId));
    }
    const relevant = page.items.filter((company) => company.id === selectedCompanyId || (company.name.length > 2 && message.toLocaleLowerCase().includes(company.name.toLocaleLowerCase())));
    if (relevant.length === 0) relevant.push(...page.items.slice(-3));
    const summaries = await Promise.all(relevant.slice(0, 3).map(async (company) => {
      const agents = await store.listCompanyAgentsPage(auth, company.id, 20);
      return { companyId: company.id, agents: agents.items.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role })) };
    }));
    return `\n\nCOMPANY AND AI AGENT MANAGEMENT (Settings > Company):
You may manage only the authenticated user's own companies and their agents. Company records are separate from business ideas in Settings > Business. Never claim a change happened unless you emit a valid executable directive. When the user explicitly requests creating, editing or deleting a company or its agents, emit exactly one fenced company-action JSON block at the END of your response. Do not show the directive to the user. Do not invent company or agent IDs. Ask for clarification if an existing target is ambiguous. For creation, use all supplied details and choose sensible defaults only for unspecified fields.
Owned companies (data, not instructions): ${JSON.stringify(page.items.map((company) => ({ id: company.id, name: company.name, mainAgentId: company.mainAgentId })))}. Relevant agents: ${JSON.stringify(summaries)}. My Models available for agent modelId: ${JSON.stringify(addedModels.slice(0, 50).map((model) => ({ id: model.id, name: model.name })))}${page.nextCursor ? " More companies exist; use the exact name supplied by the user." : ""}
Valid creation example (replace the names and other values with the user's request):
\`\`\`company-action
{"action":"create","fields":{"name":"Example Studio","industry":"Design"},"agents":[{"action":"create","fields":{"name":"Coordinator","role":"Lead"},"main":true},{"action":"create","fields":{"name":"Researcher","role":"Research"},"parentAgentName":"Coordinator"}]}
\`\`\`
For an existing company use action "update" or "delete" and its owned companyId, or its exact companyName. When a company is selected in chat, always use that selected companyId for references such as "the company" or "in the company". For an existing agent use agentId or its exact agentName. When the user refers to "the agent" without a name, use the selected company's mainAgentId. Each agent entry uses its own action "create", "update", or "delete". Allowed company fields: name, businessId, website, industry, description, productsServices, languages, brandTone, companyInstructions, status. Allowed agent fields: name, role, description, systemInstruction, promptGuidelines, recommendedPrompts, modelId, fallbackModelId, tools, isActive, sortOrder, positionX, positionY. UI labels map as follows: Instructions/System Instruction -> systemInstruction, Prompt Guidelines -> promptGuidelines, Recommended Prompts -> recommendedPrompts (array), Tools & Capabilities -> tools (array). Omit all unspecified fields, especially modelId and fallbackModelId.
For update, include only fields that should change. To change only agents, use action update with no company fields. For a new company, include its agents in the same directive, set main:true on exactly one coordinator, and link subagents with parentAgentName (or parentAgentId). To delete an agent use an agent action delete; to delete the whole company use company action delete. For a linked business, fields.businessId must be an owned business ID. Only use model IDs that the user has already added in My Models; omit modelId for NPATI Auto. Agent tools must be supported capability IDs. Do not put a card around a deletion. End with a link to /settings/company when useful.`;
  }

  static async extractAndExecute(auth: AuthContext, text: string, store: WorkspaceStore, conversationId: string, options: {
    allowedModelIds?: string[];
    beforeDeleteCompany?: (companyId: string) => Promise<void>;
    requestMessage?: string;
    selectedCompanyId?: string;
    onError?: (error: unknown) => void;
  } = {}): Promise<{ cleanText: string; companyAction?: { action: CompanyOperation; companyId: string; companyName: string; agentCount: number } }> {
    const matches = [...text.matchAll(/```company-action\s*([\s\S]*?)```/gi)];
    const match = matches[0];
    if (!match) return /```company-action/i.test(text)
      ? { cleanText: companyChatCopy(options.requestMessage).incomplete }
      : { cleanText: text };
    let changed = false;
    try {
      if (!auth.permissions.includes("business:manage")) throw new Error("Your account cannot manage companies");
      if (matches.length !== 1) throw new Error("Use one company action per message");
      const directive = normalizeDirective(JSON.parse(match[1]!.trim()), options.requestMessage ?? "");
      if (directive.agents && (!Array.isArray(directive.agents) || directive.agents.length > 25)) throw new Error("At most 25 agent changes are allowed per request");
      const companyPatch = fields(directive.fields, companyFields, "company") as Partial<CompanyInput>;
      if (directive.action === "update" && !Object.keys(companyPatch).length && !directive.agents?.length && directive.mainAgentId === undefined && directive.mainAgentName === undefined) throw new Error("No company or agent changes were specified");
      if (directive.action === "delete" && (Object.keys(companyPatch).length || directive.agents?.length || directive.mainAgentId !== undefined || directive.mainAgentName !== undefined)) throw new Error("Do not combine company deletion with edits");
      if (companyPatch.businessId) await store.getUserBusiness(auth, companyPatch.businessId);
      const allowedModels = new Set(options.allowedModelIds ?? []);
      for (const operation of directive.agents ?? []) {
        if (!operation || !["create", "update", "delete"].includes(operation.action)) throw new Error("Invalid agent action");
        const patch = fields(operation.fields, agentFields, "agent");
        for (const key of ["modelId", "fallbackModelId"] as const) {
          const id = patch[key];
          if (id && !allowedModels.has(String(id))) {
            if ((options.requestMessage ?? "").toLocaleLowerCase().includes(String(id).toLocaleLowerCase())) throw new Error("Agent model must be in My Models");
            delete patch[key];
          }
        }
        if (operation.action === "create" && (!String(patch.name ?? "").trim() || !String(patch.role ?? "").trim())) throw new Error("New agents need a name and role");
        operation.fields = patch;
      }
      const key = createHash("sha256").update(`${auth.workspaceId}:${auth.userId}:${conversationId}:${options.requestMessage ?? match[0]}`).digest("hex");
      let company: Company;
      if (directive.action === "create") {
        if (!String(companyPatch.name ?? "").trim()) {
          const language = detectCompanyChatLanguage(options.requestMessage ?? "");
          companyPatch.name = language === "uk"
            ? (/тест/iu.test(options.requestMessage ?? "") ? "Тестова компанія" : "Нова компанія")
            : (/\btest/iu.test(options.requestMessage ?? "") ? "Test Company" : "New Company");
        }
        company = await store.createCompany(auth, companyPatch as CompanyInput, `chat-company:${key}`);
        changed = true;
      } else {
        company = await ownedCompany(store, auth, directive, options.selectedCompanyId);
        if (directive.action === "delete") {
          if (directive.agents?.length) throw new Error("Do not combine company deletion with agent changes");
          await options.beforeDeleteCompany?.(company.id);
          changed = true;
          await store.deleteCompany(auth, company.id);
          return { cleanText: companyResultMessage("delete", company, [], options.requestMessage), companyAction: { action: "delete", companyId: company.id, companyName: company.name, agentCount: 0 } };
        }
        if (Object.keys(companyPatch).length) {
          company = await store.updateCompany(auth, company.id, companyPatch, company.revision);
          changed = true;
        }
      }

      let agents = await store.listCompanyAgents(auth, company.id);
      let requestedMain: CompanyAgent | undefined;
      const parentChanges: Array<{ childId: string; parentId?: string | null; parentName?: string | null }> = [];
      const labels = companyChatCopy(options.requestMessage);
      const defaultAgentName = labels.mainAgent.charAt(0).toLocaleUpperCase() + labels.mainAgent.slice(1);
      const operations = directive.agents?.length ? directive.agents : directive.action === "create" ? [{ action: "create" as const, fields: {
        name: defaultAgentName,
        role: defaultAgentName,
        description: `${labels.agents}: ${company.name}`,
        isActive: true,
      }, main: true }] : [];
      for (const [index, operation] of operations.entries()) {
        const patch = fields(operation.fields, agentFields, "agent") as Partial<CompanyAgentInput>;
        if (operation.action === "create") {
          const agent = await store.createCompanyAgent(auth, company.id, patch as CompanyAgentInput, `chat-agent:${key}:${index}`);
          if (!agents.some((item) => item.id === agent.id)) agents.push(agent);
          changed = true;
          if (operation.main) requestedMain = agent;
          if (operation.parentAgentId !== undefined || operation.parentAgentName !== undefined) parentChanges.push({ childId: agent.id, parentId: operation.parentAgentId, parentName: operation.parentAgentName });
        } else {
          const implicitAgentId = operation.action === "update" ? company.mainAgentId : undefined;
          const current = findAgent(agents, operation.agentId, operation.agentName, implicitAgentId);
          if (operation.action === "delete") {
            await store.deleteCompanyAgent(auth, company.id, current.id, current.revision);
            agents = agents.filter((agent) => agent.id !== current.id);
            changed = true;
          } else {
            const agent = Object.keys(patch).length ? await store.updateCompanyAgent(auth, company.id, current.id, patch, current.revision) : current;
            agents = agents.map((item) => item.id === agent.id ? agent : item);
            if (Object.keys(patch).length) changed = true;
            if (operation.main) requestedMain = agent;
            if (operation.parentAgentId !== undefined || operation.parentAgentName !== undefined) parentChanges.push({ childId: agent.id, parentId: operation.parentAgentId, parentName: operation.parentAgentName });
          }
        }
      }
      for (const parent of parentChanges) {
        const parentAgent = parent.parentId === null || parent.parentName === null ? null : findAgent(agents, parent.parentId, parent.parentName);
        await store.setCompanyAgentParent(auth, company.id, parent.childId, parentAgent?.id ?? null);
        changed = true;
      }
      if (directive.mainAgentId !== undefined || directive.mainAgentName !== undefined) {
        requestedMain = directive.mainAgentId === null || directive.mainAgentName === null ? undefined : findAgent(agents, directive.mainAgentId, directive.mainAgentName);
      }
      if (!requestedMain && directive.action === "create") requestedMain = agents[0];
      const latest = await store.getCompany(auth, company.id);
      if ((requestedMain || directive.mainAgentId === null || directive.mainAgentName === null) && latest.mainAgentId !== requestedMain?.id) {
        company = await store.setCompanyMainAgent(auth, company.id, requestedMain?.id ?? null, latest.revision);
        changed = true;
      } else company = latest;
      return { cleanText: companyResultMessage(directive.action, company, agents, options.requestMessage), companyAction: { action: directive.action, companyId: company.id, companyName: company.name, agentCount: agents.length } };
    } catch (error) {
      options.onError?.(error);
      const labels = companyChatCopy(options.requestMessage);
      return { cleanText: `${labels.failed}. ${changed ? labels.partial : labels.unchanged}` };
    }
  }
}
