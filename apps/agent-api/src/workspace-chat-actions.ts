import { requestsBusinessGoal } from "./chat-intent-helpers";
import { createHash } from "node:crypto";
import type { AuthContext, Business, Company, CompanyAgentRunDetails, CompanyRunMode, MemoryInput, WorkspaceStore } from "@npati/workspace";
import type { CompanyAutomation, CompanyAutomationsRepository } from "./automations-repository";
import { computeNextCronDate, isValidCronExpression } from "./automation-scheduler";
import type { BrowserCampaignTarget, BrowserCampaignTargetInput, BrowserCredentialsRepository } from "./browser-credentials-repository";
import type { CompanyEmailAccount } from "./email-inbox-types";
import type { EmailInboxRepository } from "./email-inbox-repository";
import { chatLanguageInstruction, workspaceCardCopy, detectCompanyChatLanguage } from "./company-chat-i18n";
import { ContentLibraryStore, type ContentLibraryType } from "./content-library-store";
import type { IntegrationsRepository } from "./integrations-repository";
import { executeWebhookAction, webhookPromptContext, webhookResourceSignal, type WebhookDirective } from "./workspace-webhook-actions";

type WorkspaceActionKind = "activity.run" | "activity.cancel" | "activity.list" | "automation.list" | "automation.create" | "automation.update" | "automation.delete" | "automation.run" | "automation.history" | "website.list" | "website.create" | "website.seed_demo" | "website.update" | "website.delete" | "content.create" | "content.update" | "content.delete" | "memory.create" | "memory.update" | "memory.delete" | "webhook.list" | "webhook.create" | "webhook.update" | "webhook.delete";
type ContentType = "article" | "seo_blueprint" | "social_post" | "brief" | "strategy" | "other";

type WorkspaceDirective = {
  action: WorkspaceActionKind;
  companyId?: string;
  companyName?: string;
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

export type WorkspaceChatActionResult = {
  cleanText: string;
  workspaceAction?: { action: WorkspaceActionKind; resourceId: string; companyId?: string; businessId?: string };
  companyRunId?: string;
};

export type WorkspaceChatActionDependencies = {
  store: WorkspaceStore;
  automations: CompanyAutomationsRepository;
  content: ContentLibraryStore;
  runCompany: (auth: AuthContext, companyId: string, input: { task: string; mode?: CompanyRunMode }, idempotencyKey: string) => Promise<CompanyAgentRunDetails>;
  cancelCompanyRun: (auth: AuthContext, companyId: string, runId: string) => Promise<CompanyAgentRunDetails>;
  runAutomation?: (auth: AuthContext, automation: CompanyAutomation) => Promise<{ runId: string; result: string; durationMs: number }>;
  browserTargets?: Pick<BrowserCredentialsRepository, "listTargets" | "createTarget" | "updateTarget" | "deleteTarget">;
  email?: Pick<EmailInboxRepository, "listAccounts" | "getAccount">;
  webhooks?: Pick<IntegrationsRepository, "listWebhooks" | "createWebhook" | "deleteWebhook" | "setWebhookActive">;
};
type WorkspacePromptResources = Pick<WorkspaceChatActionDependencies, "automations" | "content"> &
  Partial<Pick<WorkspaceChatActionDependencies, "browserTargets" | "email" | "webhooks">> & { memoryReadAllowed?: boolean };

const memoryTypes = new Set<MemoryInput["type"]>(["business_fact", "audience", "brand", "preference", "decision", "product", "channel", "experiment", "result", "other"]);
const contentTypes = new Set<ContentType>(["article", "seo_blueprint", "social_post", "brief", "strategy", "other"]);
const runModes = new Set<CompanyRunMode>(["auto", "single", "pipeline", "fusion"]);
const websiteStatuses = new Set(["pending", "paused"]);
const demoWebsites: BrowserCampaignTargetInput[] = [
  {
    siteName: "WordPress Playground (isolated demo)",
    registrationUrl: "https://playground.wordpress.net/?storage=browser&url=/wp-admin/post-new.php",
    publishUrl: "https://playground.wordpress.net/?storage=browser&url=/wp-admin/post-new.php",
    articleTitle: "NPATI browser automation test",
    articleBody: "This draft verifies that the browser agent can create and publish an article in an isolated WordPress Playground session.",
    priority: 10,
    status: "paused",
  },
  {
    siteName: "RealWorld Conduit (public demo)",
    registrationUrl: "https://realworld.svelte.dev/register",
    publishUrl: "https://realworld.svelte.dev/editor",
    articleTitle: "NPATI browser automation test",
    articleBody: "A test article created by the NPATI browser automation in the public RealWorld demo application.",
    priority: 20,
    status: "paused",
  },
];

const actionSignals = [
  /\b(?:create|add|schedule|run|start|save|remember|generate|write|prepare|configure|edit|update|change|delete|remove|pause|resume|cancel|disable|enable|deactivate|activate|turn\s+(?:on|off))\b/iu,
  /(?:створ|дод|заплан|запуст|почн|збереж|запам.?ят|генер|напиш|підгот|налашт|редаг|змін|онов|видал|приб|призуп|віднов|скас|вимкн|увімкн|вмикн|деактив)/iu,
  /(?:cré\p{L}*|ajout\p{L}*|planifi\p{L}*|lanc\p{L}*|enregistr\p{L}*|mémoris\p{L}*|génér\p{L}*|écri\p{L}*|configur\p{L}*|modifi\p{L}*|mettr\p{L}* à jour|supprim\p{L}*|retir\p{L}*|suspend\p{L}*|repren\p{L}*|annul\p{L}*)/iu,
  /(?:erstell\p{L}*|hinzufüg\p{L}*|plan\p{L}*|start\p{L}*|speicher\p{L}*|merk\p{L}*|generier\p{L}*|schreib\p{L}*|konfigurier\p{L}*|bearbeit\p{L}*|aktualisier\p{L}*|änder\p{L}*|lösch\p{L}*|entfern\p{L}*|pausier\p{L}*|fortsetz\p{L}*|abbrech\p{L}*)/iu,
  /(?:crea\p{L}*|añad\p{L}*|program\p{L}*|inici\p{L}*|guard\p{L}*|record\p{L}*|gener\p{L}*|escri\p{L}*|configur\p{L}*|edit\p{L}*|actualiz\p{L}*|cambi\p{L}*|elimin\p{L}*|borr\p{L}*|paus\p{L}*|reanud\p{L}*|cancel\p{L}*)/iu,
  /(?:crea\p{L}*|aggiung\p{L}*|pianific\p{L}*|avvi\p{L}*|salv\p{L}*|ricord\p{L}*|gener\p{L}*|scriv\p{L}*|configur\p{L}*|modific\p{L}*|aggiorn\p{L}*|cambi\p{L}*|elimin\p{L}*|rimuov\p{L}*|sospend\p{L}*|riprend\p{L}*|annull\p{L}*)/iu,
  /(?:utwórz|dodaj|zaplanuj|uruchom|zapisz|zapamiętaj|wygeneruj|napisz|skonfiguruj|edytuj|zaktualizuj|zmień|usuń|wstrzymaj|wznów|anuluj)/iu,
  /(?:cri\p{L}*|adicion\p{L}*|agend\p{L}*|inici\p{L}*|salv\p{L}*|lembr\p{L}*|ger\p{L}*|escrev\p{L}*|configur\p{L}*|edit\p{L}*|atualiz\p{L}*|alter\p{L}*|exclu\p{L}*|remov\p{L}*|paus\p{L}*|retom\p{L}*|cancel\p{L}*)/iu,
  /(?:maak|maken|toevoeg\p{L}*|plan\p{L}*|start\p{L}*|opsla\p{L}*|onthoud\p{L}*|genere\p{L}*|schrijf\p{L}*|configure\p{L}*|bewerk\p{L}*|werk\p{L}* bij|wijzig\p{L}*|verwijder\p{L}*|pauzeer\p{L}*|hervat\p{L}*|annuleer\p{L}*)/iu,
  /(?:oluştur|ekle|planla|başlat|kaydet|hatırla|üret|yaz|yapılandır|düzenle|güncelle|değiştir|sil|kaldır|duraklat|sürdür|iptal)/iu,
  /(?:созда|добав|заплан|запуст|сохран|запом|сгенер|напиш|настро|редакт|измен|обнов|удал|приостанов|возобнов|отмен)/iu,
  /(?:创建|新增|添加|安排|运行|开始|保存|记住|生成|撰写|配置|编辑|更新|修改|删除|移除|暂停|恢复|取消)/u,
  /(?:作成|追加|予定|実行|開始|保存|記憶|生成|書いて|設定|編集|更新|変更|削除|一時停止|再開|キャンセル)/u,
  /(?:생성|추가|예약|실행|시작|저장|기억|작성|설정|편집|업데이트|변경|삭제|제거|일시 중지|재개|취소)/u,
  /(?:أنشئ|إنشاء|أضف|جدول|شغل|ابدأ|احفظ|تذكر|اكتب|كوّن|حرر|حدث|غيّر|احذف|أزل|أوقف|استأنف|ألغ)/u,
  /(?:बनाएं|बनाओ|जोड़ें|शेड्यूल|चलाएं|शुरू|सहेजें|याद|लिखें|कॉन्फ़िगर|संपादित|अपडेट|बदलें|हटाएं|रोकें|फिर शुरू|रद्द)/u,
];

const resourceSignals = [
  /\b(?:activit(?:y|ies)|run trace|execution trace|automation|scheduled task|cron job|content hub|article|seo blueprint|social draft|business memory|memory item|memory|brand voice|audience profile)\b/iu,
  /(?:активност|трасуван|запуск|автоматизац|запланован.*завдан|контент|статт|seo|соціальн.*допис|пам.?ят|мемор|тон.*бренд|аудитор)/iu,
  /(?:activité|trace d.exécution|automatisation|tâche planifiée|contenu|article|mémoire|voix de marque|audience)/iu,
  /(?:aktivität|ausführungsspur|automatisierung|geplante aufgabe|inhalt|artikel|gedächtnis|markenstimme|zielgruppe)/iu,
  /(?:actividad|traza de ejecución|automatización|tarea programada|contenido|artículo|memoria|voz de marca|audiencia)/iu,
  /(?:attività|traccia di esecuzione|automazione|attività pianificata|contenuto|articolo|memoria|voce del marchio|pubblico)/iu,
  /(?:aktywno\p{L}*|ślad wykonania|automatyza\p{L}*|zaplanowane zadanie|treś\p{L}*|artyku\p{L}*|pamię\p{L}*|głos marki|odbiorcy)/iu,
  /(?:atividade|rastreamento de execução|automação|tarefa agendada|conteúdo|artigo|memória|voz da marca|público)/iu,
  /(?:activiteit|uitvoeringstrace|automatisering|geplande taak|inhoud|artikel|geheugen|merkstem|doelgroep)/iu,
  /(?:etkinlik|çalıştırma izi|otomasyon|zamanlanmış görev|içerik|makale|hafıza|marka sesi|hedef kitle)/iu,
  /(?:активност|трассиров|запуск|автоматизац|запланирован.*задач|контент|стать|памят|голос.*бренд|аудитор)/iu,
  /(?:活动|运行跟踪|执行跟踪|自动化|定时任务|内容|文章|记忆|品牌语气|受众)/u,
  /(?:アクティビティ|実行トレース|自動化|スケジュール.*タスク|コンテンツ|記事|メモリ|ブランドボイス|対象者)/u,
  /(?:활동|실행 추적|자동화|예약 작업|콘텐츠|기사|메모리|브랜드 보이스|대상 고객)/u,
  /(?:نشاط|تتبع التنفيذ|أتمتة|مهمة مجدولة|محتوى|مقال|ذاكرة|صوت العلامة|الجمهور)/u,
  /(?:गतिविधि|निष्पादन ट्रेस|ऑटोमेशन|निर्धारित कार्य|सामग्री|लेख|मेमोरी|ब्रांड वॉइस|दर्शक)/u,
];

const mutationSignals = [
  /\b(?:edit|update|change|delete|remove|pause|resume|cancel)\b/iu,
  /(?:редаг|змін|онов|видал|приб|призуп|віднов|скас)/iu,
  /(?:modifi|mettre à jour|supprim|retir|suspend|repren|annul)/iu,
  /(?:bearbeit|aktualisier|änder|lösch|entfern|pausier|fortsetz|abbrech)/iu,
  /(?:edit|actualiz|cambi|elimin|borr|paus|reanud|cancel)/iu,
  /(?:modific|aggiorn|cambi|elimin|rimuov|sospend|riprend|annull)/iu,
  /(?:edytuj|zaktualizuj|zmień|usuń|wstrzymaj|wznów|anuluj)/iu,
  /(?:edit|atualiz|alter|exclu|remov|paus|retom|cancel)/iu,
  /(?:bewerk|werk.*bij|wijzig|verwijder|pauzeer|hervat|annuleer)/iu,
  /(?:düzenle|güncelle|değiştir|sil|kaldır|duraklat|sürdür|iptal)/iu,
  /(?:редакт|измен|обнов|удал|приостанов|возобнов|отмен)/iu,
  /(?:编辑|更新|修改|删除|移除|暂停|恢复|取消)/u,
  /(?:編集|更新|変更|削除|一時停止|再開|キャンセル)/u,
  /(?:편집|업데이트|변경|삭제|제거|일시 중지|재개|취소)/u,
  /(?:حرر|حدث|غيّر|احذف|أزل|أوقف|استأنف|ألغ)/u,
  /(?:संपादित|अपडेट|बदलें|हटाएं|रोकें|फिर शुरू|रद्द)/u,
];
const referenceSignals = [
  /\b(?:it|this|that|one|last|previous)\b/iu,
  /(?:її|його|це|цю|цей|останн|попередн)/iu,
  /\b(?:le|la|les|ceci|cela|dernier|précédent)\b/iu,
  /\b(?:es|dies|diese|letzte|vorherige)\b/iu,
  /\b(?:lo|la|esto|esta|últim|anterior)\b/iu,
  /\b(?:lo|la|quest|ultim|precedent)\b/iu,
  /\b(?:to|ten|ta|ostatni|poprzedni)\b/iu,
  /\b(?:isso|isto|este|esta|últim|anterior)\b/iu,
  /\b(?:het|dit|deze|laatste|vorige)\b/iu,
  /\b(?:onu|bunu|şunu|son|önceki)\b/iu,
  /(?:её|его|это|эту|этот|последн|предыдущ)/iu,
  /(?:它|这个|这条|最后|上一个)/u,
  /(?:それ|これ|この|最後|前の)/u,
  /(?:그것|이것|이 항목|마지막|이전)/u,
  /(?:إياه|إياها|هذا|هذه|الأخير|السابق)/u,
  /(?:इसे|यह|इसको|अंतिम|पिछल)/u,
];

// Brand voice and audience are also Company / Business Profile fields: they only name a memory resource when the
// request is not about a company or business profile ("Create company X. Brand tone: warm" creates a company).
const profileFieldTerms = /(?:brand\s+(?:voice|tone)|audience(?:\s+profile)?|тон\p{L}*\s+бренд\p{L}*|аудитор\p{L}*|voix de marque|markenstimme|zielgruppe|voz de marca|audiencia|voce del marchio|pubblico|głos marki|odbiorcy|voz da marca|público|merkstem|doelgroep|marka sesi|hedef kitle|голос\p{L}*\s+бренд\p{L}*|品牌语气|受众)/giu;
const profileEntitySignal = /(?:компан\p{L}*|бізнес[- ]?профіл\p{L}*|бизнес[- ]?профил\p{L}*|\bcompan(?:y|ies)\b|business\s+profile|entreprise|unternehmen|empresa|azienda|perfil\s+de\s+neg[óo]cio|bedrijf|şirket|公司)/iu;

// An imperative "Remember ..." is a memory action by its verb alone (Ukrainian "запам'ятай" already contains "пам'ят");
// "Do you remember ...?" is a question, not an action.
const memoryVerbSignal = /(?:^|[.!?;:]\s+)(?:please\s+|por favor,?\s+|bitte\s+)?(?:remember|merk(?:e|t)?\s+dir|merken?\s+sie|recuerd[ae]|lembr[ae](?:-?se)?|m[ée]morise|ricorda|zapamiętaj|onthoud|hatırla|запомни)(?![\p{L}])/iu;

/** Researching or analysing websites is reading them, not managing the campaign's website targets. */
const researchVerbSignal = /(?:\bresearch\b|recherch\p{L}*|pesquis\p{L}*|investiga\p{L}*|\bsearch\b|\banaly[sz]e\b|analysier\p{L}*|\bcompare\b|vergleich\p{L}*|досліди\p{L}*|дослідж\p{L}*|проаналізуй|порівня\p{L}*|знайди\s+в\s+інтернеті)/iu;

const automationReadSignals = [
  /\b(?:list|show|which|when|status|history|runs?|tasks?|websites?|sites?)\b/iu,
  /(?:покажи|перегля|список|який|яка|які|коли|статус|історі|запуск|завдан|сайт)/iu,
];
const websiteResourceSignals = [
  /\b(?:website registration|website publishing|browser campaign|campaign sites?|websites|sites)\b/iu,
  /(?:реєстрац\p{L}*.*сайт|публікац\p{L}*.*сайт|сайт\p{L}*.*(?:реєстрац|публікац)|сайти|сайтів|вебсайти|вебсайтів)/iu,
  /(?:автоматизац\p{L}*|запланован\p{L}*.*завдан|агент\p{L}*.*завдан)/iu,
];

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
  if (selectedCompanyId) return store.getCompany(auth, selectedCompanyId);
  const all = await companies(store, auth);
  const name = directive.companyName?.trim().toLocaleLowerCase();
  const matches = name ? all.filter((item) => item.name.toLocaleLowerCase() === name) : all;
  if (matches.length !== 1) throw new Error(matches.length ? "Specify which company to use" : "Create a company before using this action");
  return matches[0]!;
}

async function resolveAutomation(deps: WorkspaceChatActionDependencies, auth: AuthContext, companyId: string, directive: WorkspaceDirective, item?: Partial<BrowserCampaignTargetInput>): Promise<CompanyAutomation> {
  const available = await deps.automations.list(auth, companyId);
  const id = item?.automationId || directive.automationId;
  const name = directive.automationName?.trim().toLocaleLowerCase();
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
  if (selectedBusinessId) return store.getUserBusiness(auth, selectedBusinessId);
  const all = await store.listUserBusinesses(auth);
  const name = directive.businessName?.trim().toLocaleLowerCase();
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

function contentTask(task: string): { title?: string; type: ContentLibraryType } {
  const match = task.match(/^\[NPATI_CONTENT:(article|seo_blueprint|social_post|brief|strategy|other):([A-Za-z0-9_-]+)\]/);
  if (!match) return { type: "article" };
  try { return { title: Buffer.from(match[2]!, "base64url").toString("utf8"), type: contentType(match[1] as ContentType) }; }
  catch { return { type: contentType(match[1] as ContentType) }; }
}

export class WorkspaceChatActions {
  /** Reading stored memory uses the existing scoped context; it must not start a mutation planner. */
  static isReadOnlyMemoryRequest(message: string): boolean {
    const memory = /(?:\bmemor(?:y|ies|ia)\b|mem\u00f3ria|ged\u00e4chtnis|m\u00e9moire|\u043f\u0430\u043c['\u2019]?\u044f\u0442|\u043f\u0430\u043c\u044f\u0442)/iu.test(message);
    return memory && !memoryVerbSignal.test(message) && !actionSignals.some(pattern => pattern.test(message));
  }

  static isManagementRequest(message: string, options: { includeGoals?: boolean } = {}): boolean {
    const subject = profileEntitySignal.test(message) ? message.replace(profileFieldTerms, " ") : message;
    // "Research two bakery websites …" reads websites; it does not manage the browser campaign's website targets.
    const websiteTargets = websiteResourceSignals.some((pattern) => pattern.test(subject)) && !researchVerbSignal.test(message);
    const resource = resourceSignals.some((pattern) => pattern.test(subject)) || websiteTargets || webhookResourceSignal.test(subject);
    // A question about the goals ("Welche Ziele hat die Bäckerei?") is answered, not planned as a goal action.
    const question = /\?\s*$/u.test(message.trim())
      && /^(?:[^:?]{0,40}:\s*)?(?:які|який|яка|скільки|що|чи|какие|сколько|what|which|how\s+many|do\s+we|does|welche|welcher|was|wie\s+viele|quais|qual|quantos|cuáles|cuál|cuántos|quelles?|quels?)(?![\p{L}])/iu.test(message.trim());
    return (options.includeGoals !== false && requestsBusinessGoal(message) && !question) || memoryVerbSignal.test(subject) || resource && (actionSignals.some((pattern) => pattern.test(message)) || automationReadSignals.some((pattern) => pattern.test(message)));
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
    const messages: Record<string, string> = {
      en: "I found no saved Business Memory records. Refresh Settings → Memory if an old card is still visible.",
      uk: "Я не знайшов збережених записів пам’яті бізнесу. Якщо стара картка ще відображається, оновіть сторінку Налаштування → Пам’ять.",
      de: "Ich habe keine gespeicherten Einträge im Business Memory gefunden. Aktualisieren Sie Einstellungen → Memory, falls noch eine alte Karte angezeigt wird.",
      fr: "Je n’ai trouvé aucune entrée enregistrée dans la mémoire métier. Actualisez Paramètres → Mémoire si une ancienne fiche est encore visible.",
      es: "No encontré registros guardados en la memoria del negocio. Actualiza Configuración → Memoria si aún aparece una tarjeta antigua.",
      it: "Non ho trovato voci salvate nella memoria aziendale. Aggiorna Impostazioni → Memoria se vedi ancora una vecchia scheda.",
      pl: "Nie znalazłem zapisanych wpisów pamięci biznesowej. Odśwież Ustawienia → Pamięć, jeśli nadal widać starą kartę.",
    };
    return messages[detectCompanyChatLanguage(message)] ?? messages.en!;
  }

  static noActionMessage(message: string): string {
    const language = detectCompanyChatLanguage(message);
    const messages: Partial<Record<typeof language, string>> = {
      uk: "Не вдалося безпечно виконати цю дію. Уточніть компанію або бізнес і потрібні параметри.",
      fr: "Je n’ai pas pu exécuter cette action en toute sécurité. Précisez l’entreprise et les paramètres nécessaires.",
      de: "Diese Aktion konnte nicht sicher ausgeführt werden. Bitte geben Sie das Unternehmen und die erforderlichen Angaben an.",
      es: "No pude ejecutar esta acción de forma segura. Especifica la empresa y los parámetros necesarios.",
      zh: "无法安全执行此操作。请指定公司或业务以及所需参数。",
      ja: "この操作を安全に実行できませんでした。会社またはビジネスと必要な設定を指定してください。",
      ko: "이 작업을 안전하게 실행할 수 없습니다. 회사 또는 비즈니스와 필요한 설정을 지정해 주세요.",
      ar: "تعذر تنفيذ هذا الإجراء بأمان. حدد الشركة أو النشاط التجاري والإعدادات المطلوبة.",
      hi: "यह कार्रवाई सुरक्षित रूप से पूरी नहीं हो सकी। कंपनी या व्यवसाय और आवश्यक विवरण बताएं।",
    };
    return messages[language] ?? "I could not complete this action safely. Specify the company or business and the required settings.";
  }

  static async buildSystemPrompt(auth: AuthContext, store: WorkspaceStore, message: string, selectedCompanyId?: string, selectedBusinessId?: string, resources?: WorkspacePromptResources): Promise<string> {
    if (!auth.permissions.includes("business:manage")) return "";
    if (!resourceSignals.some((pattern) => pattern.test(message)) && !websiteResourceSignals.some((pattern) => pattern.test(message)) && !memoryVerbSignal.test(message) && !webhookResourceSignal.test(message) && !((selectedCompanyId || selectedBusinessId) && this.isPotentialMutationRequest(message))) return "";
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
      (await resources.automations.list(auth, company.id)).map((item) => ({ id: item.id, companyId: company.id, companyName: company.name, name: item.name, description: item.description, prompt: item.prompt, cronExpression: item.cronExpression, timezone: item.timezone, agentId: item.agentId, status: item.status, lastRunAt: item.lastRunAt, nextRunAt: item.nextRunAt }))
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
Owned Website registration/publishing targets and safe email metadata (data only; never credentials): ${JSON.stringify(websiteContext.slice(0, 100))}.
Owned Content Hub items (data only): ${JSON.stringify(contentContext.slice(0, 100))}.
Owned inbound webhooks / integrations (data only; secrets are never shown): ${JSON.stringify(webhookContext.slice(0, 100))}.

Supported directives:
1. Run a real company activity with trace:
\`\`\`workspace-action
{"action":"activity.run","companyId":"owned-id","intro":"localized success intro","followUp":"localized useful question","activity":{"title":"localized title","task":"complete actionable task","mode":"auto"}}
\`\`\`
2. Create an automation. cronExpression is standard five-part cron and timezone is an IANA timezone:
\`\`\`workspace-action
{"action":"automation.create","companyId":"owned-id","intro":"localized success intro","followUp":"localized useful question","automation":{"name":"localized name","description":"localized description","prompt":"complete recurring task","cronExpression":"0 9 * * 1","timezone":"Europe/Kyiv","agentId":"optional-owned-agent-id"}}
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
{"action":"content.create","companyId":"owned-id","intro":"localized success intro","followUp":"localized useful question","content":{"title":"localized title","type":"article","task":"complete content brief","mode":"auto"}}
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
Use activity.run when the user asks the company agents to perform work and wants a trace. Use content.create for a durable article, SEO blueprint, social draft, brief, or strategy in Content Hub. Never save guesses as Memory. In a multi-step request whose primary outcome is a Business Profile, memory is a dependent record linked to that profile; never treat memory creation as completion of the whole request. If the user asks for recommendations, recommend missing durable categories from the supplied memory summary (business facts, audience, brand voice, products, channels, decisions, experiments/results) in the user's language; create one only when explicitly requested. Keep intro concise, put the verified details in the server-rendered card, and end followUp with a useful next question.`;
  }

  static async buildActionPlannerPrompt(auth: AuthContext, deps: WorkspaceChatActionDependencies, message: string, selectedCompanyId?: string, selectedBusinessId?: string): Promise<string> {
    return `${await this.buildSystemPrompt(auth, deps.store, message, selectedCompanyId, selectedBusinessId, deps)}\n\nDecide what the latest user message asks for. If it only asks to read, show, list, summarize or explain existing records and requests no change, return exactly READ_ONLY. Otherwise return ONLY one complete workspace-action block for the requested change, without stating that it succeeded, or exactly NO_ACTION when required data is missing or the target is ambiguous.`;
  }

  static async extractAndExecute(auth: AuthContext, text: string, deps: WorkspaceChatActionDependencies, conversationId: string, options: { requestMessage?: string; selectedCompanyId?: string; selectedBusinessId?: string; onError?: (error: unknown) => void } = {}): Promise<WorkspaceChatActionResult> {
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
          if (directive.action === "memory.delete") {
            await deps.store.deleteMemory(auth, business.id, current.id);
            const card = `\`\`\`card:${clean(current.title, 300)}\n**${labels.business}:** ${clean(business.name, 300)}\n\n[${labels.openMemory}](/settings/memory)\n\`\`\``;
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
          const card = `\`\`\`card:${clean(updated.title, 300)}\n**${labels.type}:** ${updated.type}\n**${labels.business}:** ${clean(business.name, 300)}\n**${labels.confidence}:** ${Math.round((updated.confidence ?? 1) * 100)}%\n\n${clean(updated.content)}\n\n[${labels.openMemory}](/settings/memory)\n\`\`\``;
          return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: updated.id, businessId: business.id } };
        }
        if (!item || !memoryTypes.has(item.type as MemoryInput["type"]) || !clean(item.title, 300) || !clean(item.content)) throw new Error("Invalid memory");
        if (item.confidence !== undefined && (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) throw new Error("Invalid confidence");
        const source = `chat:${key}`;
        const created = (await deps.store.listMemory(auth, business.id)).find((entry) => entry.source === source)
          ?? await deps.store.createMemory(auth, business.id, { type: item.type!, title: clean(item.title, 300), content: clean(item.content), confidence: item.confidence ?? 1, source });
        const card = `\`\`\`card:${clean(created.title, 300)}\n**${labels.type}:** ${created.type}\n**${labels.business}:** ${clean(business.name, 300)}\n**${labels.confidence}:** ${Math.round((created.confidence ?? 1) * 100)}%\n\n${clean(created.content)}\n\n[${labels.openMemory}](/settings/memory)\n\`\`\``;
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
              "**Next run:** " + (automation?.nextRunAt || "not scheduled"),
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
          const lines = available.length ? available.map((automation) => {
            const agent = agents.find((entry) => entry.id === automation.agentId);
            return [
              "### " + clean(automation.name, 300),
              "**Status:** " + automation.status,
              "**Agent:** " + clean(agent?.name || "automatic selection", 300),
              "**Schedule:** " + automation.cronExpression + " (" + clean(automation.timezone, 100) + ")",
              "**Last run:** " + (automation.lastRunAt || "never"),
              "**Next run:** " + automation.nextRunAt,
              clean(automation.description) || clean(automation.prompt),
            ].join("\n");
          }).join("\n\n") : "No automations are configured.";
          return { cleanText: intro(directive) + "\n\n" + lines + "\n\n[" + labels.openAutomations + "](" + automationSettingsUrl(company.id) + ")", workspaceAction: { action: directive.action, resourceId: company.id, companyId: company.id } };
        }
        if (directive.action === "automation.history" || directive.action === "automation.run") {
          const current = await resolveAutomation(deps, auth, company.id, directive);
          if (directive.action === "automation.history") {
            const runs = await deps.automations.listRuns(auth, company.id, current.id, Math.min(50, Math.max(1, directive.historyLimit ?? 10)));
            const lines = runs.length ? runs.map((run) =>
              "- " + run.startedAt + " — " + run.status + " (" + run.durationMs + " ms)" +
              (run.errorMessage ? ": " + clean(run.errorMessage, 500) : "") +
              (run.result ? "\n  " + clean(run.result, 1000).replace(/\n/g, "\n  ") : "")
            ).join("\n") : "This automation has no runs yet.";
            return { cleanText: intro(directive) + "\n\n### " + clean(current.name, 300) + "\n" + lines + "\n\n[" + labels.openAutomations + "](" + automationSettingsUrl(company.id) + ")", workspaceAction: { action: directive.action, resourceId: current.id, companyId: company.id } };
          }
          if (!deps.runAutomation) throw new Error("Immediate automation execution is unavailable");
          const run = await deps.runAutomation(auth, current);
          return { cleanText: intro(directive) + "\n\n### " + clean(current.name, 300) + "\n**Status:** completed\n**Duration:** " + run.durationMs + " ms\n\n" + clean(run.result) + "\n\n[" + labels.openAutomations + "](" + automationSettingsUrl(company.id) + ")", workspaceAction: { action: directive.action, resourceId: current.id, companyId: company.id } };
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
            ...(item.cronExpression !== undefined || item.timezone !== undefined
              ? { nextRunAt: computeNextCronDate(nextCronExpression, new Date(), nextTimezone).toISOString() }
              : {}),
            ...(item.agentId !== undefined ? { agentId: item.agentId } : {}),
            ...(item.status !== undefined ? { status: item.status } : {}),
          };
          if (!Object.keys(update).length || (item.name !== undefined && !update.name) || (item.prompt !== undefined && !update.prompt)) throw new Error("Invalid automation changes");
          const updated = await deps.automations.update(auth, company.id, current.id, update);
          const card = `\`\`\`card:${clean(updated.name, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n**${labels.status}:** ${updated.status}\n**${labels.schedule}:** \`${updated.cronExpression}\`\n**${labels.timezone}:** ${clean(updated.timezone, 100)}\n**${labels.nextRun}:** ${updated.nextRunAt}\n\n${clean(updated.description) || clean(updated.prompt)}\n\n[${labels.openAutomations}](${automationSettingsUrl(company.id)})\n\`\`\``;
          return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: updated.id, companyId: company.id } };
        }
        if (!item || !clean(item.name, 300) || !clean(item.prompt) || !item.cronExpression || !isValidCronExpression(item.cronExpression)) throw new Error("Invalid automation");
        if (item.agentId) {
          const agents = await deps.store.listCompanyAgents(auth, company.id);
          if (!agents.some((agent) => agent.id === item.agentId)) throw new Error("Agent is not owned by this company");
        }
        const automationName = clean(item.name, 300);
        const automationPrompt = clean(item.prompt);
        const cronExpression = item.cronExpression.trim();
        const timezone = clean(item.timezone, 100) || "Europe/Kyiv";
        const created: CompanyAutomation = (await deps.automations.list(auth, company.id)).find((entry) =>
          entry.name === automationName && entry.prompt === automationPrompt && entry.cronExpression === cronExpression
        ) ?? await deps.automations.create(auth, company.id, {
          name: automationName, description: clean(item.description, 2000) || undefined, prompt: automationPrompt,
          cronExpression, timezone, agentId: item.agentId ?? undefined,
          nextRunAt: computeNextCronDate(cronExpression, new Date(), timezone).toISOString(),
        });
        const card = `\`\`\`card:${clean(created.name, 300)}\n**${labels.company}:** ${clean(company.name, 300)}\n**${labels.status}:** ${labels.active}\n**${labels.schedule}:** \`${created.cronExpression}\`\n**${labels.timezone}:** ${clean(created.timezone, 100)}\n**${labels.nextRun}:** ${created.nextRunAt}\n\n${clean(created.description) || clean(created.prompt)}\n\n[${labels.openAutomations}](${automationSettingsUrl(company.id)})\n\`\`\``;
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
        const details = await deps.runCompany(auth, company.id, { task: clean(item.task), mode: item.mode ?? "auto" }, `chat-activity:${key}`);
        const run = details.run;
        if (run.status !== "completed") throw new Error(run.errorMessage || "Company run did not complete");
        const title = clean(item.title, 300) || clean(run.task, 300);
        const card = `\`\`\`card:${title}\n**${labels.company}:** ${clean(company.name, 300)}\n**${labels.status}:** ${labels.completed}\n**${labels.mode}:** ${run.executionMode ?? run.requestedMode}\n**${labels.steps}:** ${details.steps.length}\n**${labels.toolCalls}:** ${details.toolAudit.length}\n**${labels.duration}:** ${run.totalDurationMs ?? 0} ms\n\n${clean(run.result) || "✓"}\n\n[${labels.openActivity}](/settings/activity)\n\`\`\``;
        return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: run.id, companyId: company.id }, companyRunId: run.id };
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
      const task = `[NPATI_CONTENT:${item.type}:${Buffer.from(clean(item.title, 300), "utf8").toString("base64url")}] ${clean(item.task)}`;
      const details = await deps.runCompany(auth, company.id, { task, mode: item.mode ?? "auto" }, `chat-content:${key}`);
      const run = details.run;
      if (run.status !== "completed" || !clean(run.result)) throw new Error(run.errorMessage || "Content generation did not complete");
      await deps.content.update(auth, run.id, company.id, { title: clean(item.title, 300), type: contentType(item.type!), content: clean(run.result, 200_000) });
      const card = `\`\`\`card:${clean(item.title, 300)}\n${clean(run.result)}\n\n[${labels.openContent}](/settings/content)\n\`\`\``;
      return { cleanText: finish(directive, card), workspaceAction: { action: directive.action, resourceId: run.id, companyId: company.id }, companyRunId: run.id };
    } catch (error) {
      options.onError?.(error);
      return { cleanText: this.noActionMessage(options.requestMessage ?? "") };
    }
  }
}
