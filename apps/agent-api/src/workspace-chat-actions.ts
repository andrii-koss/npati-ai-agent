import { demoWebsites } from "./workspace-demo-websites";
import { isInformationalOrCapabilityQuery } from "./company-chat-actions";
import { requestsBusinessGoal } from "./chat-intent-helpers";
import { ActiveContextResolver } from "./active-context-resolver";
import { createHash } from "node:crypto";
import type { AuthContext, Business, Company, CompanyAgentRunDetails, CompanyRunMode, MemoryInput, WorkspaceStore } from "@npati/workspace";
import type { CompanyAutomation, CompanyAutomationsRepository } from "./automations-repository";
import { automationRunEndStatus } from "./automations-repository";
import { computeNextCronDate, isValidCronExpression } from "./automation-scheduler";
import type { BrowserCampaignTarget, BrowserCampaignTargetInput, BrowserCredentialsRepository } from "./browser-credentials-repository";
import type { CompanyEmailAccount } from "./email-inbox-types";
import type { EmailInboxRepository } from "./email-inbox-repository";
import { automationListLabels, chatLanguageInstruction, workspaceCardCopy, detectCompanyChatLanguage } from "./company-chat-i18n";
import { ContentLibraryStore, type ContentLibraryType } from "./content-library-store";
import type { IntegrationsRepository } from "./integrations-repository";
import { executeWebhookAction, webhookPromptContext, webhookResourceSignal, type WebhookDirective } from "./workspace-webhook-actions";

type WorkspaceActionKind = "activity.run" | "activity.cancel" | "activity.list" | "automation.list" | "automation.create" | "automation.update" | "automation.delete" | "automation.run" | "automation.history" | "website.list" | "website.create" | "website.seed_demo" | "website.update" | "website.delete" | "content.create" | "content.update" | "content.delete" | "memory.create" | "memory.update" | "memory.delete" | "webhook.list" | "webhook.create" | "webhook.update" | "webhook.delete";
type ContentType = "article" | "seo_blueprint" | "social_post" | "brief" | "strategy" | "other";

type WorkspaceDirective = {
  action: WorkspaceActionKind;
  companyId?: string;
  companyName?: string;
  projectId?: string;
  businessId?: string;
  businessName?: string;
  automationId?: string;
  automationName?: string;
  websiteId?: string;
  websiteName?: string;
  emailAccountId?: string;
  emailAddress?: string;
  startAt?: string;
  historyLimit?: number;
  contentId?: string;
  contentTitle?: string;
  memoryId?: string;
  memoryTitle?: string;
  intro?: string;
  followUp?: string;
  activity?: { runId?: string; title?: string; task?: string; mode?: CompanyRunMode };
  automation?: { name?: string; description?: string; prompt?: string; cronExpression?: string; timezone?: string; agentId?: string | null; status?: "active" | "paused" };
  website?: BrowserCampaignTargetInput;
  websites?: BrowserCampaignTargetInput[];
  content?: { title?: string; type?: ContentType; content?: string; task?: string; mode?: CompanyRunMode };
  memory?: { type?: MemoryInput["type"]; title?: string; content?: string; confidence?: number };
} & Omit<WebhookDirective, "action">;

/** Workspace actions that only read stored records. */
/** A run or schedule time in UTC and in the automation's own timezone, so the model never converts offsets itself (V5-D71). */
function zonedTime(value: unknown, timezone: string): string {
  const date = new Date(value as string);
  if (!value || Number.isNaN(date.getTime())) return String(value || "never");
  const local = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
  return `${local} ${timezone || "UTC"} (${date.toISOString()})`;
}

export const WORKSPACE_READ_ACTIONS: ReadonlySet<string> = new Set(["activity.list", "automation.list", "automation.history", "website.list", "webhook.list"]);

export type WorkspaceChatActionResult = {
  cleanText: string;
  workspaceAction?: { action: WorkspaceActionKind; resourceId: string; companyId?: string; businessId?: string; projectId?: string };
  companyRunId?: string;
};

export type WorkspaceChatActionDependencies = {
  store: WorkspaceStore;
  automations: CompanyAutomationsRepository;
  content: ContentLibraryStore;
  runCompany: (auth: AuthContext, companyId: string, input: { task: string; mode?: CompanyRunMode; projectId?: string; conversationId?: string }, idempotencyKey: string) => Promise<CompanyAgentRunDetails>;
  cancelCompanyRun: (auth: AuthContext, companyId: string, runId: string) => Promise<CompanyAgentRunDetails>;
  runAutomation?: (auth: AuthContext, automation: CompanyAutomation) => Promise<{ runId: string; result: string; durationMs: number }>;
  browserTargets?: Pick<BrowserCredentialsRepository, "listTargets" | "createTarget" | "updateTarget" | "deleteTarget">;
  email?: Pick<EmailInboxRepository, "listAccounts" | "getAccount">;
  webhooks?: Pick<IntegrationsRepository, "listWebhooks" | "createWebhook" | "deleteWebhook" | "setWebhookActive">;
};
type WorkspacePromptResources = Pick<WorkspaceChatActionDependencies, "automations" | "content"> &
  Partial<Pick<WorkspaceChatActionDependencies, "browserTargets" | "email" | "webhooks">> & { memoryReadAllowed?: boolean;
  /** The semantic route already chose workspace records (for example a Memory recall without the word "memory"). */
  routed?: boolean };

const memoryTypes = new Set<MemoryInput["type"]>(["business_fact", "audience", "brand", "preference", "decision", "product", "channel", "experiment", "result", "other"]);
const contentTypes = new Set<ContentType>(["article", "seo_blueprint", "social_post", "brief", "strategy", "other"]);
const runModes = new Set<CompanyRunMode>(["auto", "single", "pipeline", "fusion"]);
const websiteStatuses = new Set(["pending", "paused"]);

import { actionSignals, resourceSignals, mutationSignals, referenceSignals, profileFieldTerms, profileEntitySignal, conversationScopedRemember, memoryVerbSignal, researchVerbSignal, automationReadSignals, websiteResourceSignals, runCancellationSignal } from "./workspace-chat-signals";

function clean(value: unknown, max = 12_000): string {
  if (typeof value !== "string") return "";
  return value.replace(/```/g, "'''").trim().slice(0, max);
}

function fenced(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/```workspace-action\s*([\s\S]*?)```/gi)];
}

async function companies(store: WorkspaceStore, auth: AuthContext): Promise<Company[]> {
  const result: Company[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listCompanies(auth, 100, cursor);
    result.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && result.length < 500);
  return result;
}

async function resolveCompany(store: WorkspaceStore, auth: AuthContext, directive: WorkspaceDirective, selectedCompanyId?: string): Promise<Company> {
  if (directive.companyId) return store.getCompany(auth, directive.companyId);
  const all = await companies(store, auth);
  const name = directive.companyName?.trim().toLocaleLowerCase();
  if (!name && selectedCompanyId) return store.getCompany(auth, selectedCompanyId);
  const matches = name ? all.filter((item) => item.name.toLocaleLowerCase() === name) : all;
  if (matches.length !== 1) throw new Error(matches.length ? "Specify which company to use" : "Create a company before using this action");
  return matches[0]!;
}

async function resolveAutomation(deps: WorkspaceChatActionDependencies, auth: AuthContext, companyId: string, directive: WorkspaceDirective, item?: Partial<BrowserCampaignTargetInput>): Promise<CompanyAutomation> {
  const available = await deps.automations.list(auth, companyId);
  const id = item?.automationId || directive.automationId;
  const name = (directive.automationName ?? (directive.action === "automation.run" || directive.action === "automation.history" ? directive.automation?.name : undefined))?.trim().toLocaleLowerCase();
  const matches = id
    ? available.filter((entry) => entry.id === id)
    : available.filter((entry) => entry.name.toLocaleLowerCase() === name);
  if (matches.length !== 1) throw new Error("Automation target is missing or ambiguous");
  return matches[0]!;
}

async function resolveEmailAccount(deps: WorkspaceChatActionDependencies, auth: AuthContext, companyId: string, directive: WorkspaceDirective, item?: Partial<BrowserCampaignTargetInput>): Promise<CompanyEmailAccount> {
  if (!deps.email) throw new Error("Email accounts are unavailable");
  const available = await deps.email.listAccounts(auth, companyId);
  const id = item?.emailAccountId || directive.emailAccountId;
  const address = directive.emailAddress?.trim().toLocaleLowerCase();
  const matches = id
    ? available.filter((entry) => entry.id === id)
    : available.filter((entry) => entry.emailAddress.toLocaleLowerCase() === address);
  if (matches.length !== 1) throw new Error("Connected Company email target is missing or ambiguous");
  if (matches[0]!.status !== "connected") throw new Error("The selected Company email account is not connected");
  return matches[0]!;
}

function resolveWebsite(available: BrowserCampaignTarget[], directive: WorkspaceDirective): BrowserCampaignTarget {
  const name = directive.websiteName?.trim().toLocaleLowerCase();
  const matches = directive.websiteId
    ? available.filter((entry) => entry.id === directive.websiteId)
    : available.filter((entry) => entry.siteName.toLocaleLowerCase() === name);
  if (matches.length !== 1) throw new Error("Website target is missing or ambiguous");
  return matches[0]!;
}

function requestedStartAt(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Website automation startAt must be a valid ISO date");
  if (date.getTime() < Date.now() - 60_000) throw new Error("Website automation startAt cannot be in the past");
  return date.toISOString();
}

async function resolveBusiness(store: WorkspaceStore, auth: AuthContext, directive: WorkspaceDirective, selectedBusinessId?: string): Promise<Business> {
  if (directive.businessId) return store.getUserBusiness(auth, directive.businessId);
  const all = await store.listUserBusinesses(auth);
  const name = directive.businessName?.trim().toLocaleLowerCase();
  if (!name && selectedBusinessId) return store.getUserBusiness(auth, selectedBusinessId);
  const matches = name ? all.filter((item) => item.name.toLocaleLowerCase() === name) : all;
  if (matches.length !== 1) throw new Error(matches.length ? "Specify which business to use" : "Create a business profile before adding memory");
  return matches[0]!;
}

function intro(directive: WorkspaceDirective): string {
  return clean(directive.intro, 500) || "✓";
}

function followUp(directive: WorkspaceDirective): string {
  return clean(directive.followUp, 700);
}

function finish(directive: WorkspaceDirective, card: string): string {
  return `${intro(directive)}\n\n${card}${followUp(directive) ? `\n\n${followUp(directive)}` : ""}`;
}

function automationSettingsUrl(companyId: string): string {
  return `/settings/automations?company=${encodeURIComponent(companyId)}`;
}

function idempotency(auth: AuthContext, conversationId: string, requestMessage: string, action: string): string {
  return createHash("sha256").update(`${auth.workspaceId}:${auth.userId}:${conversationId}:${requestMessage}:${action}`).digest("hex");
}

function contentType(value: ContentType): ContentLibraryType {
  if (value === "seo_blueprint") return "seo_structure";
  if (value === "social_post") return "social_post";
  if (value === "brief" || value === "strategy") return "brief";
  return "article";
}

export const CONTENT_DELIVERABLE_RULE = "Your answer is saved verbatim as the finished content document. Return only the content itself, in the language of the brief: no greeting, no confirmation such as \"done\" or \"saved\", no card or code-fence wrapper, no list of edits or checks, and no follow-up question.";
/** The stored automation status in the card language (an update card said "paused" in Ukrainian, V6 step 12). */
function automationStatus(status: string, labels: { paused: string; active: string }) {
  return status === "paused" ? labels.paused : status === "active" ? labels.active : status;
}

function contentTask(task: string): { title?: string; type: ContentLibraryType } {
  const match = task.match(/^\[NPATI_CONTENT:(article|seo_blueprint|social_post|brief|strategy|other):([A-Za-z0-9_-]+)\]/);
  if (!match) return { type: "article" };
  try { return { title: Buffer.from(match[2]!, "base64url").toString("utf8"), type: contentType(match[1] as ContentType) }; }
  catch { return { type: contentType(match[1] as ContentType) }; }
}

/** Items that carry companyId and companyName, grouped by company (V6 step 14: the pair was repeated on every item). */
function groupByCompany<T extends { companyId: string; companyName: string }>(items: T[]) {
  const groups = new Map<string, { companyId: string; companyName: string; items: Array<Omit<T, "companyId" | "companyName">> }>();
  for (const { companyId, companyName, ...rest } of items) {
    const group = groups.get(companyId) ?? { companyId, companyName, items: [] };
    group.items.push(rest);
    groups.set(companyId, group);
  }
  return [...groups.values()];
}

export class WorkspaceChatActions {
  /** Reading stored memory uses the existing scoped context; it must not start a mutation planner. */
  static isReadOnlyMemoryRequest(message: string): boolean {
    const memory = /(?:\bmemor(?:y|ies|ia)\b|mem\u00f3ria|ged\u00e4chtnis|m\u00e9moire|\u043f\u0430\u043c['\u2019]?\u044f\u0442|\u043f\u0430\u043c\u044f\u0442)/iu.test(message);
    return memory && !memoryVerbSignal.test(message) && !actionSignals.some(pattern => pattern.test(message));
  }

  static isManagementRequest(message: string, options: { includeGoals?: boolean } = {}): boolean {
    if (runCancellationSignal.test(message)) return true;
    const informational = isInformationalOrCapabilityQuery(message);
    const subject = profileEntitySignal.test(message) ? message.replace(profileFieldTerms, " ") : message;
    // "Research two bakery websites …" reads websites; it does not manage the browser campaign's website targets.
    const websiteTargets = websiteResourceSignals.some((pattern) => pattern.test(subject)) && !researchVerbSignal.test(message);
    const resource = resourceSignals.some((pattern) => pattern.test(subject)) || websiteTargets || webhookResourceSignal.test(subject);
    // Reading an actual workspace resource still uses its existing list/history action;
    // historical verbs in other questions must not enter the mutation planner.
    // A question about the goals ("Welche Ziele hat die Bäckerei?") is answered, not planned as a goal action.
    const question = /\?\s*$/u.test(message.trim())
      && /^(?:[^:?]{0,40}:\s*)?(?:які|який|яка|скільки|що|чи|какие|сколько|what|which|how\s+many|do\s+we|does|welche|welcher|was|wie\s+viele|quais|qual|quantos|cuáles|cuál|cuántos|quelles?|quels?)(?![\p{L}])/iu.test(message.trim());
    const goalRequest = options.includeGoals !== false && requestsBusinessGoal(message) && !question;
    if (informational) return goalRequest || resource && automationReadSignals.some((pattern) => pattern.test(message));
    return goalRequest || memoryVerbSignal.test(subject) || resource && (actionSignals.some((pattern) => pattern.test(message)) || automationReadSignals.some((pattern) => pattern.test(message)));
  }

  /** A Company fact belongs to its existing instructions; Business Memory needs a Business target. */
  static async companyInstructionTarget(auth: AuthContext, store: WorkspaceStore, message: string, selectedCompanyId?: string): Promise<Company | undefined> {
    if (!memoryVerbSignal.test(message) || conversationScopedRemember.test(message)) return undefined;
    const resolver = new ActiveContextResolver(store);
    const namedCompanies = await resolver.companiesNamedIn(auth, message);
    if ((await resolver.businessesNamedIn(auth, message)).length || namedCompanies.length > 1) return undefined;
    return namedCompanies[0] ?? (selectedCompanyId ? store.getCompany(auth, selectedCompanyId) : undefined);
  }

  /** "Run Stress Weekly Revised once" names an automation without the word "automation": its exact name counts as the resource. */
  static async namesOwnedAutomation(auth: AuthContext, store: WorkspaceStore, message: string, automations?: WorkspaceChatActionDependencies["automations"]): Promise<boolean> {
    if (!automations || !auth.permissions.includes("business:manage")) return false;
    // The listing is oldest first; the 20 most recently updated companies are the ones the user works with.
    const owned = (await companies(store, auth).catch(() => [] as Company[]))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 20);
    const names = (await Promise.all(owned.map((company) => automations.list(auth, company.id).catch(() => [])))).flat().map((item) => item.name.trim());
    return names.some((name) => name.length > 2 && new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(message));
  }

  /** "Enable Stress Hook in Bakery" names an existing webhook: its exact name identifies the resource, as for automations. */
  static async namesOwnedWebhook(auth: AuthContext, store: WorkspaceStore, message: string, webhooks?: WorkspaceChatActionDependencies["webhooks"]): Promise<boolean> {
    if (!webhooks || !auth.permissions.includes("business:manage")) return false;
    const owned = (await companies(store, auth).catch(() => [] as Company[]))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 20);
    const names = (await Promise.all(owned.map((company) => webhooks.listWebhooks(auth, company.id).catch(() => [])))).flat().map((item) => item.name.trim());
    return names.some((name) => name.length > 2 && new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(message));
  }

  static isPotentialMutationRequest(message: string): boolean {
    return mutationSignals.some((pattern) => pattern.test(message)) && referenceSignals.some((pattern) => pattern.test(message));
  }

  static isBusinessMemoryDeletionRequest(message: string): boolean {
    const normalized = message.toLocaleLowerCase();
    if (!normalized.includes("/settings/memory") && ["company memory","компанія пам'ять","пам'ять компанії"].some((phrase) => normalized.includes(phrase))) return false;
    return ["memory","мемор","пам’ят","пам'ят","mémoire","gedächtnis","memoria","pamięć"].some((word) => normalized.includes(word))
      && ["delete","remove","видал","приб","supprim","effac","lösch","entfern","elimin","borr","rimuov","usuń","skasuj"].some((word) => normalized.includes(word));
  }

  static noSavedMemoryMessage(message: string): string {
    const messages: Record<ReturnType<typeof detectCompanyChatLanguage>, string> = {
      en: "I found no saved Business Memory records. Refresh Settings → Memory if an old card is still visible.",
      uk: "Я не знайшов збережених записів пам’яті бізнесу. Якщо стара картка ще відображається, оновіть сторінку Налаштування → Пам’ять.",
      de: "Ich habe keine gespeicherten Einträge im Business Memory gefunden. Aktualisieren Sie Einstellungen → Memory, falls noch eine alte Karte angezeigt wird.",
      fr: "Je n’ai trouvé aucune entrée enregistrée dans la mémoire métier. Actualisez Paramètres → Mémoire si une ancienne fiche est encore visible.",
      es: "No encontré registros guardados en la memoria del negocio. Actualiza Configuración → Memoria si aún aparece una tarjeta antigua.",
      it: "Non ho trovato voci salvate nella memoria aziendale. Aggiorna Impostazioni → Memoria se vedi ancora una vecchia scheda.",
      pl: "Nie znalazłem zapisanych wpisów pamięci biznesowej. Odśwież Ustawienia → Pamięć, jeśli nadal widać starą kartę.",
      pt: "Não encontrei registos guardados na memória do negócio. Atualiza Definições → Memória se ainda aparecer um cartão antigo.",
      nl: "Ik heb geen opgeslagen bedrijfsherinneringen gevonden. Vernieuw Instellingen → Geheugen als er nog een oude kaart staat.",
      tr: "Kayıtlı işletme belleği bulunamadı. Eski bir kart görünüyorsa Ayarlar → Bellek sayfasını yenileyin.",
      ru: "Сохранённых записей памяти бизнеса не найдено. Если видна старая карточка, обновите Настройки → Память.",
      zh: "未找到已保存的业务记忆。如果仍显示旧卡片，请刷新设置 → 记忆。",
      ja: "保存されたビジネスメモリが見つかりません。古いカードが表示される場合は、設定 → メモリを更新してください。",
      ko: "저장된 사업 메모리를 찾지 못했습니다. 이전 카드가 보이면 설정 → 메모리를 새로 고침해 주세요.",
      ar: "لم أعثر على سجلات محفوظة لذاكرة النشاط التجاري. حدّث الإعدادات → الذاكرة إذا بقيت بطاقة قديمة ظاهرة.",
      hi: "व्यवसाय की मेमोरी में कोई सहेजे गए रिकॉर्ड नहीं मिले। पुराना कार्ड दिख रहा हो तो सेटिंग्स → मेमोरी को रीफ़्रेश करें।",
    };
    return messages[detectCompanyChatLanguage(message)] ?? messages.en!;
  }

  static noActionMessage(message: string): string {
    const language = detectCompanyChatLanguage(message);
    const messages: Record<typeof language, string> = {
      uk: "Не вдалося безпечно виконати цю дію. Уточніть компанію або бізнес і потрібні параметри.",
      fr: "Je n’ai pas pu exécuter cette action en toute sécurité. Précisez l’entreprise et les paramètres nécessaires.",
      de: "Diese Aktion konnte nicht sicher ausgeführt werden. Bitte geben Sie das Unternehmen und die erforderlichen Angaben an.",
      es: "No pude ejecutar esta acción de forma segura. Especifica la empresa y los parámetros necesarios.",
      zh: "无法安全执行此操作。请指定公司或业务以及所需参数。",
      ja: "この操作を安全に実行できませんでした。会社またはビジネスと必要な設定を指定してください。",
      ko: "이 작업을 안전하게 실행할 수 없습니다. 회사 또는 비즈니스와 필요한 설정을 지정해 주세요.",
      ar: "تعذر تنفيذ هذا الإجراء بأمان. حدد الشركة أو النشاط التجاري والإعدادات المطلوبة.",
      hi: "यह कार्रवाई सुरक्षित रूप से पूरी नहीं हो सकी। कंपनी या व्यवसाय और आवश्यक विवरण बताएं।",
      en: "I could not complete this action safely. Specify the company or business and the required settings.",
      ru: "Не удалось безопасно выполнить это действие. Уточните компанию или бизнес и необходимые параметры.",
      it: "Non è stato possibile completare questa azione in sicurezza. Specifica l’azienda o l’attività e le impostazioni necessarie.",
      pl: "Nie udało się bezpiecznie wykonać tej czynności. Wskaż firmę lub biznes i wymagane ustawienia.",
      pt: "Não foi possível concluir esta ação com segurança. Indica a empresa ou o negócio e as definições necessárias.",
      nl: "Deze actie kon niet veilig worden uitgevoerd. Geef het bedrijf of de onderneming en de vereiste instellingen op.",
      tr: "Bu işlem güvenli şekilde tamamlanamadı. Şirketi veya işletmeyi ve gerekli ayarları belirtin.",
    };
    return messages[language] ?? "I could not complete this action safely. Specify the company or business and the required settings.";
  }

  static async buildSystemPrompt(auth: AuthContext, store: WorkspaceStore, message: string, selectedCompanyId?: string, selectedBusinessId?: string, resources?: WorkspacePromptResources): Promise<string> {
    if (!auth.permissions.includes("business:manage")) return "";
    if (!resources?.routed && !runCancellationSignal.test(message) && !resourceSignals.some((pattern) => pattern.test(message)) && !websiteResourceSignals.some((pattern) => pattern.test(message)) && !memoryVerbSignal.test(message) && !webhookResourceSignal.test(message) && !((selectedCompanyId || selectedBusinessId) && this.isPotentialMutationRequest(message))
      && !await this.namesOwnedAutomation(auth, store, message, resources?.automations)) return "";
    // Only the first 30 records reach the prompt: the selected one, then those named in the request, then the most
    // recently updated - not the oldest 30, which hid the company the user had just created.
    const promptOrder = <T extends { id: string; name: string; updatedAt: string }>(items: T[], selectedId?: string) => {
      const lower = message.toLocaleLowerCase();
      const rank = (item: T) => (item.id === selectedId ? 0 : lower.includes(item.name.toLocaleLowerCase()) ? 1 : 2);
      // The PostgreSQL store returns timestamps as Date objects despite the string type.
      const time = (item: T) => new Date(item.updatedAt as unknown as string | Date).getTime() || 0;
      return [...items].sort((a, b) => rank(a) - rank(b) || time(b) - time(a));
    };
    const ownedCompanies = promptOrder(await companies(store, auth), selectedCompanyId);
    const ownedBusinesses = promptOrder(await store.listUserBusinesses(auth), selectedBusinessId);
    const companyContext = await Promise.all(ownedCompanies.slice(0, 30).map(async (company) => ({
      id: company.id,
      name: company.name,
      businessId: company.businessId,
      mainAgentId: company.mainAgentId,
      projects: (await store.listProjects(auth, company.id)).slice(0, 30).map(project => ({ id: project.id, name: project.name, type: project.type })),
      agents: (await store.listCompanyAgentsPage(auth, company.id, 50)).items.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role, active: agent.isActive })),
    })));
    const linkedBusinessId = ownedCompanies.find(company => company.id === selectedCompanyId)?.businessId;
    const namedBusinesses = new Set(ownedBusinesses.filter(business => message.toLocaleLowerCase().includes(business.name.toLocaleLowerCase())).map(business => business.id));
    const memoryBusinesses = resources?.memoryReadAllowed === false ? [] : ownedBusinesses.filter(business =>
      namedBusinesses.size ? namedBusinesses.has(business.id) : (!selectedCompanyId && !selectedBusinessId)
        || business.id === selectedBusinessId || business.id === linkedBusinessId);
    const memoryContext = await Promise.all(memoryBusinesses.slice(0, 30).map(async (business) => ({
      id: business.id,
      name: business.name,
      memory: (await store.listMemory(auth, business.id)).slice(0, 50).map((item) => ({ id: item.id, type: item.type, title: item.title, content: item.content, confidence: item.confidence })),
    })));
    const overrides = resources ? await resources.content.list(auth) : {};
    const automationContext = resources ? (await Promise.all(ownedCompanies.slice(0, 30).map(async (company) =>
      (await resources.automations.list(auth, company.id)).map((item) => ({ id: item.id, companyId: company.id, companyName: company.name, name: item.name, description: item.description, prompt: item.prompt.length > 300 ? item.prompt.slice(0, 300) + "…" : item.prompt, cronExpression: item.cronExpression, timezone: item.timezone, agentId: item.agentId, status: item.status, lastRunAt: item.lastRunAt, nextRunAt: item.nextRunAt }))
    ))).flat() : [];
    const webhookContext = resources?.webhooks ? await webhookPromptContext(auth, resources.webhooks, ownedCompanies.slice(0, 30)) : [];
    const websiteContext = resources?.browserTargets ? (await Promise.all(ownedCompanies.slice(0, 30).map(async (company) => {
      const [targets, accounts] = await Promise.all([
        resources.browserTargets!.listTargets(auth, company.id),
        resources.email?.listAccounts(auth, company.id) ?? Promise.resolve([]),
      ]);
      return {
        companyId: company.id,
        companyName: company.name,
        emailAccounts: accounts.map((account) => ({ id: account.id, emailAddress: account.emailAddress, status: account.status })),
        websites: targets.map((target) => ({
          id: target.id, automationId: target.automationId, emailAccountId: target.emailAccountId,
          siteName: target.siteName, registrationUrl: target.registrationUrl, publishUrl: target.publishUrl,
          articleTitle: target.articleTitle, status: target.status, resultUrl: target.resultUrl,
          errorMessage: target.errorMessage, attempts: target.attempts, priority: target.priority,
          lastAttemptAt: target.lastAttemptAt, completedAt: target.completedAt,
        })),
      };
    }))).flat() : [];
    // Running work the user can stop (V6 step 12: "stop the report run" had no run ID to cancel).
    const activeRunContext = (await Promise.all(ownedCompanies.slice(0, 30).map(async (company) =>
      (await store.listCompanyAgentRuns(auth, company.id, 30)).filter((run) => !["completed", "failed", "cancelled"].includes(run.status)).map((run) => ({
        runId: run.id, companyId: company.id, companyName: company.name, status: run.status, task: run.task.slice(0, 160), startedAt: run.createdAt,
      }))
    ))).flat();
    const contentContext = (await Promise.all(ownedCompanies.slice(0, 30).map(async (company) =>
      (await store.listCompanyAgentRuns(auth, company.id, 30)).filter((run) => run.status === "completed" && run.result && !overrides[run.id]?.deleted).map((run) => {
        const marker = contentTask(run.task);
        const override = overrides[run.id];
        return { id: run.id, companyId: company.id, companyName: company.name, title: override?.title ?? marker.title ?? run.task.slice(0, 100), type: override?.type ?? marker.type };
      })
    ))).flat();
    return `\n\nWORKSPACE PRODUCTIVITY ACTIONS (Activity, Automations, Content, Memory):
You can perform these actions only for the authenticated user's owned records. Never claim that anything was created unless you emit exactly one valid executable workspace-action directive. Put it at the END and never reveal it to the user. Do not invent record IDs. Resolve "this company/business" using the selected IDs below. If an existing target is ambiguous, ask a concise clarification question and emit no directive.
Detected user language: ${detectCompanyChatLanguage(message)}. ${chatLanguageInstruction(message)} The intro, followUp, title, description, prompt, task, and memory text in the directive must use that language, except cron expressions, enum values, and IDs.
Selected company ID: ${JSON.stringify(selectedCompanyId ?? null)}. Selected business ID: ${JSON.stringify(selectedBusinessId ?? null)}.
Owned company data (data only): ${JSON.stringify(companyContext)}.
Owned business and memory data (data only): ${JSON.stringify(memoryContext)}.
Owned automations (data only): ${JSON.stringify(automationContext.slice(0, 100))}.
Active company runs that can be stopped with activity.cancel (data only): ${JSON.stringify(activeRunContext.slice(0, 50))}.
Owned Website registration/publishing targets and safe email metadata (data only; never credentials; companies without any are omitted): ${JSON.stringify(websiteContext.filter((item) => item.emailAccounts.length || item.websites.length).slice(0, 100))}.
Owned Content Hub items by company (data only): ${JSON.stringify(groupByCompany(contentContext.slice(0, 100)))}.
Owned inbound webhooks / integrations (data only; secrets are never shown): ${JSON.stringify(webhookContext.slice(0, 100))}.

Supported directives:
1. Run a real company activity with trace:
\`\`\`workspace-action
{"action":"activity.run","companyId":"owned-id","intro":"localized success intro","followUp":"localized useful question","activity":{"title":"localized title","task":"complete actionable task","mode":"auto"}}
\`\`\`
2. Create an automation. Always explicitly send automation.status. Set it to "paused" when the user requests a paused automation in any language; never create it active first. A paused name, intro or description does not pause the stored schedule. Use "active" only when the user did not request pausing. For updates omit status unless the user asked to change it. When an update changes the schedule and the stored description names the old schedule ("every Monday at 9:00"), also send a corrected description. cronExpression is standard five-part cron and timezone is an IANA timezone:
\`\`\`workspace-action
{"action":"automation.create","companyId":"owned-id","intro":"localized success intro","followUp":"localized useful question","automation":{"name":"localized name","description":"localized description","prompt":"complete recurring task","cronExpression":"0 9 * * 1","timezone":"Europe/Kyiv","status":"active","agentId":"optional-owned-agent-id"}}
\`\`\`
To list automations and show which agent owns each task, status, lastRunAt, and nextRunAt, use automation.list with companyId.
To show the run ledger for one automation, use automation.history with companyId, automationId, and optional historyLimit.
To execute one automation immediately, use automation.run with companyId and automationId.
For Website registration and publishing:
- website.list lists configured sites and verified execution results.
- website.create accepts companyId, automationId or automationName, emailAccountId or emailAddress, optional startAt ISO timestamp, and either website or websites (maximum 25). Website fields are siteName, registrationUrl, optional publishUrl, articleTitle, articleBody, priority, and status pending or paused.
- website.seed_demo adds the two built-in paused demo sites and requires the same owned automation and connected Company email selection.
- website.update or website.delete uses websiteId (preferred) or exact websiteName. Updates may change website fields, the linked owned automation, or the connected Company email.
- startAt activates the linked automation and sets its exact first start time. Use this for requests such as tomorrow or a specific date/time.
- Registration and publishing URLs must be HTTPS and remain on the same safe public domain. Never accept or expose site passwords in chat; passwords are generated and encrypted by the server.
3. Produce Content Hub content through a real company run:
\`\`\`workspace-action
{"action":"content.create","companyId":"owned-id","intro":"localized success intro","followUp":"localized useful question","content":{"title":"localized title","type":"article","task":"complete content brief","mode":"single"}}
\`\`\`
Valid content types: article, seo_blueprint, social_post, brief, strategy, other.
4. Save durable Business Memory:
\`\`\`workspace-action
{"action":"memory.create","businessId":"owned-id","intro":"localized success intro","followUp":"localized useful question","memory":{"type":"brand","title":"localized title","content":"durable verified fact or rule","confidence":1}}
\`\`\`
Valid memory types: business_fact, audience, brand, preference, decision, product, channel, experiment, result, other.
To edit or delete an existing record, use the exact owned ID from the supplied data:
- Automation: action automation.update or automation.delete, automationId, companyId, and for update an automation object containing only changed fields. Editable fields: name, description, prompt, cronExpression, timezone, agentId (or null), status (active or paused).
- Content: action content.update or content.delete, contentId, companyId, and for update a content object containing only changed fields. Editable fields: title, type, content. Updating content edits the stored document; it does not rerun agents.
- Memory: action memory.update or memory.delete, memoryId, businessId, and for update a memory object containing only changed fields. Editable fields: type, title, content, confidence.
If the user refers to the record on Settings > Memory or says "it" and exactly one owned Business Memory record exists, use that record's exact memoryId and businessId. If several records could match, ask for the title instead of guessing.
- Webhook (inbound integration that starts a company agent run): webhook.list with companyId; webhook.create with companyId and webhook {name, promptTemplate describing what the agent does with the incoming data, optional agentId, optional isActive preserving a requested disabled state}; webhook.update with webhookId (or exact webhookName) and webhook {isActive} to enable or disable it; webhook.delete with webhookId or exact webhookName. Never reveal a webhook secret or its URL in chat; point to Settings > Integrations.
- Activity: to show recent company runs (status, agents, duration, failures and their reasons) use activity.list with companyId and optional historyLimit (default 10). Completed run traces are immutable audit records and cannot be edited or deleted. An active run may be cancelled with action activity.cancel, companyId, and activity.runId. If asked to alter a completed result, offer a new activity instead.
Use activity.run when the user asks the company agents to perform work and wants a trace. For a Project review include its owned projectId from the supplied Company projects; the selected agents must inspect actual project files before making source claims. Use content.create for a durable article, SEO blueprint, social draft, brief, or strategy in Content Hub. Never save guesses as Memory. A request to remember something only for this conversation or chat (a checkpoint, "in this chat") is not a Memory write: do not emit memory.create for it. In a multi-step request whose primary outcome is a Business Profile, memory is a dependent record linked to that profile; never treat memory creation as completion of the whole request. If the user asks for recommendations, recommend missing durable categories from the supplied memory summary (business facts, audience, brand voice, products, channels, decisions, experiments/results) in the user's language; create one only when explicitly requested. Keep intro concise, put the verified details in the server-rendered card, and end followUp with a useful next question.`;
  }

  static async buildActionPlannerPrompt(auth: AuthContext, deps: WorkspaceChatActionDependencies, message: string, selectedCompanyId?: string, selectedBusinessId?: string): Promise<string> {
    return `${await this.buildSystemPrompt(auth, deps.store, message, selectedCompanyId, selectedBusinessId, deps)}\n\nDecide what the latest user message asks for. If it requests no stored change, return exactly READ_ONLY: it only asks to read, show, list, summarize or explain existing records, or to keep a fact in this conversation rather than saved Memory. Otherwise return ONLY one complete workspace-action block for the requested change, without stating that it succeeded, or exactly NO_ACTION when required data is missing or the target is ambiguous.`;
  }

  static async extractAndExecute(auth: AuthContext, text: string, deps: WorkspaceChatActionDependencies, conversationId: string, options: { requestMessage?: string; selectedCompanyId?: string; selectedBusinessId?: string; selectedProjectId?: string; onError?: (error: unknown) => void } = {}): Promise<WorkspaceChatActionResult> {
    const matches = fenced(text);
    if (!matches[0]) {
      if (!/```workspace-action/i.test(text)) return { cleanText: text };
      // Logged as a classification only (marker word or invalid JSON), never the model text.
      const body = /```workspace-action\s*([\s\S]*?)(?:```|$)/i.exec(text)?.[1]?.trim() ?? "";
      options.onError?.(new Error("Unexecutable workspace-action block: " + (/^[A-Z_]{2,40}$/.test(body) ? body : "invalid directive")));
      return { cleanText: this.noActionMessage(options.requestMessage ?? "") };
    }
    try {
      if (!auth.permissions.includes("business:manage")) throw new Error("Permission denied");
      if (matches.length !== 1) throw new Error("Use one action per response");
      const directive = JSON.parse(matches[0][1]!.trim()) as WorkspaceDirective;
      if (!directive || !["activity.run", "activity.cancel", "activity.list", "automation.list", "automation.create", "automation.update", "automation.delete", "automation.run", "automation.history", "website.list", "website.create", "website.seed_demo", "website.update", "website.delete", "content.create", "content.update", "content.delete", "memory.create", "memory.update", "memory.delete", "webhook.list", "webhook.create", "webhook.update", "webhook.delete"].includes(directive.action)) throw new Error("Invalid action");
      const key = idempotency(auth, conversationId, options.requestMessage ?? matches[0][0], directive.action);
      const labels = workspaceCardCopy(options.requestMessage);

      if (directive.action === "memory.create" && conversationScopedRemember.test(options.requestMessage ?? "")) {
        // "Remember X as this conversation's checkpoint" belongs to the chat history, not to durable Business Memory.
        return { cleanText: text.replace(matches[0]![0], "").trim() };
      }
      if (directive.action.startsWith("memory.")) {
        let targetBusinessId = directive.businessId || options.selectedBusinessId;
        if (directive.action !== "memory.create" && !targetBusinessId && !directive.businessName) {
          const owned = await deps.store.listUserMemories(auth);
          const title = directive.memoryTitle?.trim().toLocaleLowerCase();
          const matches = directive.memoryId
            ? owned.filter((entry) => entry.id === directive.memoryId)
            : title ? owned.filter((entry) => entry.title.toLocaleLowerCase() === title)
            : owned.length === 1 ? owned : [];
          if (matches.length === 1) targetBusinessId = matches[0]!.businessId;
        }
        const business = await resolveBusiness(deps.store, auth, directive, targetBusinessId);
        const item = directive.memory;
        if (directive.action !== "memory.create") {
          const available = await deps.store.listMemory(auth, business.id);
          const title = directive.memoryTitle?.trim().toLocaleLowerCase();
          const matches = directive.memoryId
            ? available.filter((entry) => entry.id === directive.memoryId)
            : title ? available.filter((entry) => entry.title.toLocaleLowerCase() === title)
            : available.length === 1 ? available : [];
          if (matches.length !== 1) throw new Error("Memory target is missing or ambiguous");
          const current = matches[0]!;
          // A copied ID of a sibling record must not change or delete it: "delete only Delivery, keep Recipe" (A086).
          const request = options.requestMessage?.toLocaleLowerCase() ?? "";
          const named = available.filter((entry) => entry.title.trim().length > 2 && request.includes(entry.title.trim().toLocaleLowerCase()))
            .filter((entry, _, all) => !all.some((other) => other !== entry && other.title.toLocaleLowerCase().includes(entry.title.toLocaleLowerCase())));
          if (named.length === 1 && named[0]!.id !== current.id)
            throw new Error(`This request names the memory "${named[0]!.title}" (ID ${named[0]!.id}), not "${current.title}". Use that memoryId.`);
          if (directive.action === "memory.delete") {
            await deps.store.deleteMemory(auth, business.id, current.id);
            const card = `\`\`\`card:${clean(current.title, 300)}\n**${labels.business}:** ${clean(business.name, 300)}\n\n[${labels.openMemory}](/settings/memory?business=${encodeURIComponent(business.id)})\n\`\`\``;
            return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: current.id, businessId: business.id } };
          }
          if (!item) throw new Error("Memory changes are required");
          const patch: Partial<MemoryInput> = {};
          if (item.type !== undefined) { if (!memoryTypes.has(item.type)) throw new Error("Invalid memory type"); patch.type = item.type; }
          if (item.title !== undefined) { if (!clean(item.title, 300)) throw new Error("Invalid memory title"); patch.title = clean(item.title, 300); }
          if (item.content !== undefined) { if (!clean(item.content)) throw new Error("Invalid memory content"); patch.content = clean(item.content); }
          if (item.confidence !== undefined) { if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error("Invalid confidence"); patch.confidence = item.confidence; }
          if (!Object.keys(patch).length) throw new Error("Memory changes are required");
          const updated = await deps.store.updateMemory(auth, business.id, current.id, patch);
          const card = `\`\`\`card:${clean(updated.title, 300)}\n**${labels.type}:** ${updated.type}\n**${labels.business}:** ${clean(business.name, 300)}\n**${labels.confidence}:** ${Math.round((updated.confidence ?? 1) * 100)}%\n\n${clean(updated.content)}\n\n[${labels.openMemory}](/settings/memory?business=${encodeURIComponent(business.id)})\n\`\`\``;
          return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: updated.id, businessId: business.id } };
        }
        if (!item || !memoryTypes.has(item.type as MemoryInput["type"]) || !clean(item.title, 300) || !clean(item.content)) throw new Error("Invalid memory");
        if (item.confidence !== undefined && (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) throw new Error("Invalid confidence");
        const source = `chat:${key}`;
        const title = clean(item.title, 300);
        const existing = await deps.store.listMemory(auth, business.id);
        // One answer can save the same fact twice (the Business Profile tool and a memory command): a memory with the
        // same title in this Business is updated instead of duplicated.
        const sameTitle = existing.find((entry) => entry.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase());
        const created = existing.find((entry) => entry.source === source)
          ?? (sameTitle
            ? await deps.store.updateMemory(auth, business.id, sameTitle.id, { type: item.type!, content: clean(item.content), confidence: item.confidence ?? 1 })
            : await deps.store.createMemory(auth, business.id, { type: item.type!, title, content: clean(item.content), confidence: item.confidence ?? 1, source }));
        const card = `\`\`\`card:${clean(created.title, 300)}\n**${labels.type}:** ${created.type}\n**${labels.business}:** ${clean(business.name, 300)}\n**${labels.confidence}:** ${Math.round((created.confidence ?? 1) * 100)}%\n\n${clean(created.content)}\n\n[${labels.openMemory}](/settings/memory?business=${encodeURIComponent(business.id)})\n\`\`\``;
        return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: created.id, businessId: business.id } };
      }

      const company = await resolveCompany(deps.store, auth, directive, options.selectedCompanyId);
      if (directive.action.startsWith("website.")) {
        if (!deps.browserTargets || !deps.email) throw new Error("Website automation storage is unavailable");
        const available = await deps.browserTargets.listTargets(auth, company.id);
        if (directive.action === "website.list") {
          const automations = await deps.automations.list(auth, company.id);
          const agents = await deps.store.listCompanyAgents(auth, company.id);
          const accounts = await deps.email.listAccounts(auth, company.id);
          const lines = available.length ? available.map((target) => {
            const automation = automations.find((entry) => entry.id === target.automationId);
            const agent = agents.find((entry) => entry.id === automation?.agentId);
            const account = accounts.find((entry) => entry.id === target.emailAccountId);
            return [
              "### " + clean(target.siteName, 300),
              "**Status:** " + target.status,
              "**Automation:** " + clean(automation?.name || "not selected", 300),
              "**Agent:** " + clean(agent?.name || "automatic selection", 300),
              "**Company email:** " + clean(account?.emailAddress || "not selected", 320),
              "**Next run:** " + (automation?.nextRunAt ? zonedTime(automation.nextRunAt, automation.timezone) : "not scheduled"),
              "**Registration:** " + clean(target.registrationUrl, 2000),
              target.publishUrl ? "**Publishing:** " + clean(target.publishUrl, 2000) : "",
              target.resultUrl ? "**Result:** " + clean(target.resultUrl, 2000) : "",
              target.errorMessage ? "**Error:** " + clean(target.errorMessage, 1000) : "",
            ].filter(Boolean).join("\n");
          }).join("\n\n") : "No Website registration/publishing targets are configured.";
          return { cleanText: intro(directive) + "\n\n" + lines + "\n\n[" + labels.openAutomations + "](" + automationSettingsUrl(company.id) + ")", workspaceAction: { action: directive.action, resourceId: company.id, companyId: company.id } };
        }
        if (directive.action === "website.create" || directive.action === "website.seed_demo") {
          const requested = directive.action === "website.seed_demo"
            ? demoWebsites
            : directive.websites?.length ? directive.websites : directive.website ? [directive.website] : [];
          if (!requested.length || requested.length > 25) throw new Error("Provide between 1 and 25 websites");
          const startAt = requestedStartAt(directive.startAt);
          const created: BrowserCampaignTarget[] = [];
          const linkedAutomations = new Map<string, CompanyAutomation>();
          for (const item of requested) {
            if (!clean(item.siteName, 160) || !clean(item.registrationUrl, 2000)) throw new Error("Website name and registration URL are required");
            if (item.status && !websiteStatuses.has(item.status)) throw new Error("New website status must be pending or paused");
            const automation = await resolveAutomation(deps, auth, company.id, directive, item);
            const account = await resolveEmailAccount(deps, auth, company.id, directive, item);
            linkedAutomations.set(automation.id, automation);
            const duplicate = available.find((entry) =>
              entry.automationId === automation.id &&
              entry.registrationUrl === item.registrationUrl &&
              entry.siteName.toLocaleLowerCase() === item.siteName.trim().toLocaleLowerCase()
            );
            created.push(duplicate ?? await deps.browserTargets.createTarget(auth, company.id, {
              ...item,
              automationId: automation.id,
              emailAccountId: account.id,
              status: startAt ? "pending" : (item.status === "paused" ? "paused" : "pending"),
            }));
          }
          if (startAt) {
            await Promise.all(Array.from(linkedAutomations.values()).map((automation) =>
              deps.automations.update(auth, company.id, automation.id, { status: "active", nextRunAt: startAt })
            ));
          }
          const lines = created.map((target) => "- " + clean(target.siteName, 160) + ": " + target.status + " — " + clean(target.registrationUrl, 2000)).join("\n");
          const schedule = startAt ? "\n\n**First run:** " + startAt : "";
          return { cleanText: intro(directive) + "\n\n" + lines + schedule + "\n\n[" + labels.openAutomations + "](" + automationSettingsUrl(company.id) + ")", workspaceAction: { action: directive.action, resourceId: created[0]!.id, companyId: company.id } };
        }
        const current = resolveWebsite(available, directive);
        if (directive.action === "website.delete") {
          if (!await deps.browserTargets.deleteTarget(auth, company.id, current.id)) throw new Error("Website target not found");
          return { cleanText: intro(directive) + "\n\n" + clean(current.siteName, 300) + "\n\n[" + labels.openAutomations + "](" + automationSettingsUrl(company.id) + ")", workspaceAction: { action: directive.action, resourceId: current.id, companyId: company.id } };
        }
        const item = directive.website;
        if (!item) throw new Error("Website changes are required");
        if (item.status && !websiteStatuses.has(item.status)) throw new Error("Website status may only be pending or paused from chat");
        const patch: Partial<BrowserCampaignTargetInput> = { ...item };
        if (item.automationId || directive.automationId || directive.automationName) patch.automationId = (await resolveAutomation(deps, auth, company.id, directive, item)).id;
        if (item.emailAccountId || directive.emailAccountId || directive.emailAddress) patch.emailAccountId = (await resolveEmailAccount(deps, auth, company.id, directive, item)).id;
        const updated = await deps.browserTargets.updateTarget(auth, company.id, current.id, patch);
        const startAt = requestedStartAt(directive.startAt);
        if (startAt && updated.automationId) await deps.automations.update(auth, company.id, updated.automationId, { status: "active", nextRunAt: startAt });
        return { cleanText: intro(directive) + "\n\n**Website:** " + clean(updated.siteName, 300) + "\n**Status:** " + updated.status + (startAt ? "\n**First run:** " + startAt : "") + "\n\n[" + labels.openAutomations + "](" + automationSettingsUrl(company.id) + ")", workspaceAction: { action: directive.action, resourceId: updated.id, companyId: company.id } };
      }
      if (directive.action.startsWith("webhook.")) {
        if (!deps.webhooks) throw new Error("Webhook management is unavailable");
        const result = await executeWebhookAction(auth, { store: deps.store, webhooks: deps.webhooks }, company, directive as WebhookDirective, labels, intro(directive), (card) => finish(directive, card));
        return { cleanText: result.text, workspaceAction: { action: directive.action, resourceId: result.resourceId, companyId: company.id } };
      }
      if (directive.action.startsWith("automation.")) {
        const item = directive.automation;
        if (directive.action === "automation.list") {
          const available = await deps.automations.list(auth, company.id);
          const agents = await deps.store.listCompanyAgents(auth, company.id);
          const list = automationListLabels(options.requestMessage);
          const lines = available.length ? available.map((automation) => {
            const agent = agents.find((entry) => entry.id === automation.agentId);
            return [
              "### " + clean(automation.name, 300),
              "**" + labels.status + ":** " + automationStatus(automation.status, labels),
              "**" + list.agent + ":** " + clean(agent?.name || list.automaticAgent, 300),
              "**" + labels.schedule + ":** `" + automation.cronExpression + "` (" + clean(automation.timezone, 100) + ")",
              "**" + list.lastRun + ":** " + zonedTime(automation.lastRunAt, automation.timezone),
              "**" + labels.nextRun + ":** " + (automation.status === "active" ? zonedTime(automation.nextRunAt, automation.timezone) : "—"),
              clean(automation.description) || clean(automation.prompt),
            ].join("\n");
          }).join("\n\n") : list.none;
          return { cleanText: intro(directive) + "\n\n" + lines + "\n\n[" + labels.openAutomations + "](" + automationSettingsUrl(company.id) + ")", workspaceAction: { action: directive.action, resourceId: company.id, companyId: company.id } };
        }
        if (directive.action === "automation.history" || directive.action === "automation.run") {
          const current = await resolveAutomation(deps, auth, company.id, directive);
          if (directive.action === "automation.history") {
            const runs = await deps.automations.listRuns(auth, company.id, current.id, Math.min(50, Math.max(1, directive.historyLimit ?? 10)));
            const lines = runs.length ? runs.map((run) =>
              "- " + zonedTime(run.startedAt, current.timezone) + " — " + run.status + " (" + run.durationMs + " ms)" +
              (run.errorMessage ? ": " + clean(run.errorMessage, 500) : "") +
              (run.result ? "\n  " + clean(run.result, 1000).replace(/\n/g, "\n  ") : "")
            ).join("\n") : automationListLabels(options.requestMessage).noRuns;
            return { cleanText: intro(directive) + "\n\n### " + clean(current.name, 300) + "\n" + lines + "\n\n[" + labels.openAutomations + "](" + automationSettingsUrl(company.id) + ")", workspaceAction: { action: directive.action, resourceId: current.id, companyId: company.id } };
          }
          if (!deps.runAutomation) throw new Error("Immediate automation execution is unavailable");
          const list = automationListLabels(options.requestMessage);
          let run: Awaited<ReturnType<NonNullable<WorkspaceChatActionDependencies["runAutomation"]>>>;
          try { run = await deps.runAutomation(auth, current); }
          catch (error) {
            // A run stopped with Stop is reported as such; the bare error let the model invent a cause ("the
            // automation is paused") for a run the user had cancelled from another chat (V6 step 12).
            if (automationRunEndStatus(error) !== "cancelled") throw error;
            return { cleanText: "### " + clean(current.name, 300) + "\n**" + labels.status + ":** " + list.cancelled + "\n\n" + list.stopped + "\n\n[" + labels.openAutomations + "](" + automationSettingsUrl(company.id) + ")", workspaceAction: { action: directive.action, resourceId: current.id, companyId: company.id } };
          }
          return { cleanText: intro(directive) + "\n\n### " + clean(current.name, 300) + "\n**" + labels.status + ":** " + labels.completed + "\n**" + labels.duration + ":** " + run.durationMs + " ms\n\n" + clean(run.result) + "\n\n[" + labels.openAutomations + "](" + automationSettingsUrl(company.id) + ")", workspaceAction: { action: directive.action, resourceId: current.id, companyId: company.id } };
        }
        if (directive.action !== "automation.create") {
          const available = await deps.automations.list(auth, company.id);
          const name = directive.automationName?.trim().toLocaleLowerCase();
          const matches = directive.automationId ? available.filter((entry) => entry.id === directive.automationId) : available.filter((entry) => entry.name.toLocaleLowerCase() === name);
          if (matches.length !== 1) throw new Error("Automation target is missing or ambiguous");
          const current = matches[0]!;
          if (directive.action === "automation.delete") {
            if (!await deps.automations.delete(auth, company.id, current.id)) throw new Error("Automation not found");
            const card = `\`\`\`card:${clean(current.name, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n\n[${labels.openAutomations}](${automationSettingsUrl(company.id)})\n\`\`\``;
            return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: current.id, companyId: company.id } };
          }
          if (!item) throw new Error("Automation changes are required");
          if (item.agentId) {
            const agents = await deps.store.listCompanyAgents(auth, company.id);
            if (!agents.some((agent) => agent.id === item.agentId)) throw new Error("Agent is not owned by this company");
          }
          if (item.cronExpression !== undefined && !isValidCronExpression(item.cronExpression)) throw new Error("Invalid automation schedule");
          const nextCronExpression = item.cronExpression?.trim() || current.cronExpression;
          const nextTimezone = item.timezone !== undefined ? clean(item.timezone, 100) : current.timezone;
          const update = {
            ...(item.name !== undefined ? { name: clean(item.name, 300) } : {}),
            ...(item.description !== undefined ? { description: clean(item.description, 2000) } : {}),
            ...(item.prompt !== undefined ? { prompt: clean(item.prompt) } : {}),
            ...(item.cronExpression !== undefined ? { cronExpression: nextCronExpression } : {}),
            ...(item.timezone !== undefined ? { timezone: clean(item.timezone, 100) } : {}),
            // A schedule change, or resuming a paused automation (its stored slot is in the past and ran at once as a
            // catch-up, V6 step 12), starts from the next slot after now.
            ...(item.cronExpression !== undefined || item.timezone !== undefined || (item.status === "active" && current.status !== "active")
              ? { nextRunAt: computeNextCronDate(nextCronExpression, new Date(), nextTimezone).toISOString() }
              : {}),
            ...(item.agentId !== undefined ? { agentId: item.agentId } : {}),
            ...(item.status !== undefined ? { status: item.status } : {}),
          };
          if (!Object.keys(update).length || (item.name !== undefined && !update.name) || (item.prompt !== undefined && !update.prompt)) throw new Error("Invalid automation changes");
          const updated = await deps.automations.update(auth, company.id, current.id, update);
          const card = `\`\`\`card:${clean(updated.name, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n**${labels.status}:** ${automationStatus(updated.status, labels)}\n**${labels.schedule}:** \`${updated.cronExpression}\`\n**${labels.timezone}:** ${clean(updated.timezone, 100)}\n**${labels.nextRun}:** ${(updated.status === "active" ? zonedTime(updated.nextRunAt, updated.timezone) : "—")}\n\n${clean(updated.description) || clean(updated.prompt)}\n\n[${labels.openAutomations}](${automationSettingsUrl(company.id)})\n\`\`\``;
          return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: updated.id, companyId: company.id } };
        }
        if (!item || !clean(item.name, 300) || !clean(item.prompt) || !item.cronExpression || !isValidCronExpression(item.cronExpression)) throw new Error("Invalid automation");
        if (item.agentId) {
          const agents = await deps.store.listCompanyAgents(auth, company.id);
          if (!agents.some((agent) => agent.id === item.agentId)) throw new Error("Agent is not owned by this company");
        }
        // A missing status used to create an active automation while the model reported a paused one (V5-D78).
        if (item.status !== "active" && item.status !== "paused") throw new Error('automation.status is required: "paused" when the user asked for a paused automation, otherwise "active"');
        const automationName = clean(item.name, 300);
        const automationPrompt = clean(item.prompt);
        const cronExpression = item.cronExpression.trim();
        const timezone = clean(item.timezone, 100) || "Europe/Kyiv";
        const created: CompanyAutomation = (await deps.automations.list(auth, company.id)).find((entry) =>
          entry.name === automationName && entry.prompt === automationPrompt && entry.cronExpression === cronExpression
        ) ?? await deps.automations.create(auth, company.id, {
          name: automationName, description: clean(item.description, 2000) || undefined, prompt: automationPrompt,
          cronExpression, timezone, agentId: item.agentId ?? undefined, status: item.status === "paused" ? "paused" : "active",
          nextRunAt: computeNextCronDate(cronExpression, new Date(), timezone).toISOString(),
        });
        const card = `\`\`\`card:${clean(created.name, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n**${labels.status}:** ${automationStatus(created.status, labels)}\n**${labels.schedule}:** \`${created.cronExpression}\`\n**${labels.timezone}:** ${clean(created.timezone, 100)}\n**${labels.nextRun}:** ${(created.status === "active" ? zonedTime(created.nextRunAt, created.timezone) : "—")}\n\n${clean(created.description) || clean(created.prompt)}\n\n[${labels.openAutomations}](${automationSettingsUrl(company.id)})\n\`\`\``;
        return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: created.id, companyId: company.id } };
      }

      if (directive.action === "activity.list") {
        // Read-only: the run ledger the Activity page shows, newest first, without results longer than a summary.
        const runs = await deps.store.listCompanyAgentRuns(auth, company.id, Math.min(50, Math.max(1, directive.historyLimit ?? 10)));
        const agents = await deps.store.listCompanyAgents(auth, company.id);
        const names = (ids: string[]) => ids.map((id) => agents.find((agent) => agent.id === id)?.name).filter(Boolean).join(", ");
        const lines = runs.length ? runs.map((run) => [
          "### " + clean(run.task, 160),
          "**" + labels.status + ":** " + run.status + (run.errorCode ? " (" + run.errorCode + ")" : ""),
          ...(run.selectedAgentIds?.length ? ["**Agents:** " + clean(names(run.selectedAgentIds), 300)] : []),
          "**Started:** " + (run.startedAt ?? run.createdAt) + (run.totalDurationMs ? " · " + Math.round(run.totalDurationMs / 1000) + " s" : ""),
          ...(run.errorMessage ? ["**Error:** " + clean(run.errorMessage, 300)] : []),
        ].join("\n")).join("\n\n") : "No company runs yet.";
        return { cleanText: intro(directive) + "\n\n" + lines, workspaceAction: { action: directive.action, resourceId: company.id, companyId: company.id } };
      }
      if (directive.action === "activity.cancel") {
        const runId = directive.activity?.runId;
        if (!runId) throw new Error("Run ID is required");
        const current = await deps.store.getCompanyAgentRun(auth, company.id, runId);
        if (["completed", "failed", "cancelled"].includes(current.run.status)) throw new Error("Completed activity traces are immutable");
        const details = await deps.cancelCompanyRun(auth, company.id, runId);
        const card = `\`\`\`card:${clean(current.run.task, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n**${labels.status}:** ${details.run.status}\n\n[${labels.openActivity}](/settings/activity)\n\`\`\``;
        return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: runId, companyId: company.id }, companyRunId: runId };
      }

      if (directive.action === "activity.run") {
        const item = directive.activity;
        if (!item || !clean(item.task) || (item.mode && !runModes.has(item.mode))) throw new Error("Invalid activity");
        const projectId = directive.projectId ?? options.selectedProjectId;
        if (projectId) await deps.store.getProject(auth, company.id, projectId);
        const details = await deps.runCompany(auth, company.id, { task: clean(item.task), mode: item.mode ?? "auto", projectId, conversationId }, `chat-activity:${key}`);
        const run = details.run;
        if (run.status !== "completed") throw new Error(run.errorMessage || "Company run did not complete");
        const title = clean(item.title, 300) || clean(run.task, 300);
        const card = `\`\`\`card:${title}\n**${labels.company}:** ${clean(company.name, 300)}\n**${labels.status}:** ${labels.completed}\n**${labels.mode}:** ${run.executionMode ?? run.requestedMode}\n**${labels.steps}:** ${details.steps.length}\n**${labels.toolCalls}:** ${details.toolAudit.length}\n**${labels.duration}:** ${run.totalDurationMs ?? 0} ms\n\n${clean(run.result) || "✓"}\n\n[${labels.openActivity}](/settings/activity)\n\`\`\``;
        return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: run.id, companyId: company.id, ...(projectId ? { projectId } : {}) }, companyRunId: run.id };
      }

      const item = directive.content;
      if (directive.action === "content.update" || directive.action === "content.delete") {
        const runs = await deps.store.listCompanyAgentRuns(auth, company.id, 100);
        const overrides = await deps.content.list(auth);
        const title = directive.contentTitle?.trim().toLocaleLowerCase();
        const matches = directive.contentId ? runs.filter((run) => run.id === directive.contentId) : runs.filter((run) => {
          const marker = contentTask(run.task);
          return (overrides[run.id]?.title ?? marker.title ?? run.task.slice(0, 100)).toLocaleLowerCase() === title;
        });
        if (matches.length !== 1 || matches[0]!.status !== "completed" || !matches[0]!.result || overrides[matches[0]!.id]?.deleted) throw new Error("Content target is missing or ambiguous");
        const run = matches[0]!;
        const currentMarker = contentTask(run.task);
        const currentOverride = overrides[run.id];
        const currentTitle = currentOverride?.title ?? currentMarker.title ?? run.task.slice(0, 100);
        if (directive.action === "content.delete") {
          await deps.content.delete(auth, run.id, company.id);
          const card = `\`\`\`card:${clean(currentTitle, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n\n[${labels.openContent}](/settings/content)\n\`\`\``;
          return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: run.id, companyId: company.id } };
        }
        if (!item) throw new Error("Content changes are required");
        const update: { title?: string; type?: ContentLibraryType; content?: string } = {};
        if (item.title !== undefined) { if (!clean(item.title, 300)) throw new Error("Invalid content title"); update.title = clean(item.title, 300); }
        if (item.type !== undefined) { if (!contentTypes.has(item.type)) throw new Error("Invalid content type"); update.type = contentType(item.type); }
        if (item.content !== undefined) { if (!clean(item.content, 200_000)) throw new Error("Invalid content"); update.content = clean(item.content, 200_000); }
        if (!Object.keys(update).length) throw new Error("Content changes are required");
        const updated = await deps.content.update(auth, run.id, company.id, update);
        const card = `\`\`\`card:${clean(updated.title ?? currentTitle, 300)}\n${clean(updated.content ?? currentOverride?.content ?? run.result, 200_000)}\n\n[${labels.openContent}](/settings/content)\n\`\`\``;
        return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: run.id, companyId: company.id } };
      }
      if (!item || !clean(item.title, 300) || !contentTypes.has(item.type as ContentType) || !clean(item.task) || (item.mode && !runModes.has(item.mode))) throw new Error("Invalid content request");
      // The run's answer is stored as the Content Hub document itself (V6 step 11: it arrived as a chat reply with "Done,
      // saved", a nested card and an edit log, all stored and shown as raw ''' in the chat).
      const task = `[NPATI_CONTENT:${item.type}:${Buffer.from(clean(item.title, 300), "utf8").toString("base64url")}] ${clean(item.task)}\n\n${CONTENT_DELIVERABLE_RULE}`;
      const business = directive.businessId || directive.businessName ? await resolveBusiness(deps.store, auth, directive, options.selectedBusinessId) : undefined;
      const details = await deps.runCompany(auth, company.id, { task, mode: item.mode ?? "single", conversationId }, `chat-content:${key}`);
      const run = details.run;
      if (run.status !== "completed" || !clean(run.result)) throw new Error(run.errorMessage || "Content generation did not complete");
      await deps.content.update(auth, run.id, company.id, { title: clean(item.title, 300), type: contentType(item.type!), content: clean(run.result, 200_000), businessId: business?.id });
      const card = `\`\`\`card:${clean(item.title, 300)}\n${clean(run.result)}\n\n[${labels.openContent}](/settings/content)\n\`\`\``;
      return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: run.id, companyId: company.id }, companyRunId: run.id };
    } catch (error) {
      options.onError?.(error);
      // As in the email executor, the validation reason is kept so a native tool call can be corrected.
      return { cleanText: `${this.noActionMessage(options.requestMessage ?? "")} ${error instanceof Error ? clean(error.message, 400) : ""}`.trim() };
    }
  }
}
