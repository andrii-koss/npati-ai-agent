export const DEVELOPMENT_PROCESS_SETTINGS_KEY = "chat-development-processes:v1";
import { classifyProjectIntent } from "./project-intent";
/** Shared deterministic routing: creation requests only, never ordinary project edits. */
export type DevelopmentTarget = { name: string; kind: "website" | "blog" | "store" | "crm" | "mobile_app"; framework: "Next.js" | "HTML/CSS" | "Expo" };
export type ModelTurnUsage = { id: string; turn: number; totalTokens?: number; inputTokens?: number; outputTokens?: number; costUsd?: number; model?: string; provider?: string; toolCallIds: string[]; durationMs?: number };
export type DevelopmentProcessProgressItem = {
  modelUsage?: ModelTurnUsage;
  dryRun?: boolean;
  id: string;
  stage: string;
  title: string;
  at: string;
  language?: string;
  conversationId?: string;
  sequence?: number;
  kind?: "operation" | "assistant_message";
  files?: { path: string; action?: "created" | "modified" | "deleted"; linesAdded?: number; linesRemoved?: number; diff?: string }[];
  fileChange?: "created" | "modified" | "deleted";
  diff?: string;
  linesAdded?: number;
  linesRemoved?: number;
  tests?: { passed: number; failed: number; skipped: number; total: number };
  status?: "pending" | "awaiting_approval" | "active" | "running" | "completed" | "failed" | "cancelled" | "waiting_for_approval";
  tool?: string;
  command?: string;
  arguments?: string;
  fileContent?: string;
  file?: string;
  cwd?: string;
  result?: string;
  stdout?: string;
  stderr?: string;
  resultTruncated?: boolean;
  runId?: string;
  durationMs?: number;
  exitCode?: number;
  error?: string;
  errorCode?: string;
  agentId?: string;
};
export type DevelopmentProcess = {
  id: string; companyId: string; parentConversationId: string; conversationId?: string;
  projectId?: string; sessionId?: string; runId?: string; name: string; framework: string;
  status: "idle" | "queued" | "preparing" | "running" | "stopping" | "completed" | "failed" | "cancelled" | "interrupted" | "suspended_by_flag" | "awaiting_approval";
  conversationMessages?: { id: string; role: "user" | "assistant"; content: string; createdAt: string }[];
  initialRunId?: string; responseLanguage?: string; runStatuses?: Record<string, string>; runStartedAts?: Record<string,string>; runLanguages?: Record<string,string>;
  progress?: DevelopmentProcessProgressItem[];
  inboxEnabled?: boolean; hidden: boolean; createdAt: string; updatedAt: string; detail?: string; previewUrl?: string;
};
export const developmentIsActive = (p: DevelopmentProcess) => ["queued", "preparing", "running", "stopping"].includes(p.status);
export function requestsDevelopmentRestore(message: string): boolean {
  return /(?:open|show|restore|відкри|покаж|віднов|открой).*(?:development processes|процеси.*розроб|процессы.*разраб)/iu.test(message);
}
export function planChatDevelopment(message: string, activeProjectId?: string): DevelopmentTarget[] {
  if (activeProjectId && !["CREATE_PROJECT", "CREATE_WEBSITE"].includes(classifyProjectIntent({ message, activeProjectId }).intent)) return [];
  if (!/(?:\bcreate\b|\bbuild\s+(?:a\s+|an\s+|new\s+|[1-4]\s+)?(?:website|site|shop|store|blog|mobile|crm)|\bmake\b|створ|зроби|создай|создать)/iu.test(message)) return [];
  if (/(?:create|make|створ|зроби|создай).*(?:\bpage\b|\bcomponent\b|\bbutton\b|\bheader\b|сторінк|компонент|кнопк)/iu.test(message)
      && !/(?:new\s+(?:website|site)|новий\s+сайт)/iu.test(message)) return [];
  const kinds: DevelopmentTarget["kind"][] = [];
  if (/(?:website|\bsite\b|сайт|landing)/iu.test(message)) kinds.push("website");
  if (/(?:blog|блог)/iu.test(message)) kinds.push("blog");
  if (/(?:store|shop|магазин)/iu.test(message)) {
    // A 'website shop' is one project; explicitly separate company sites remain distinct.
    if (kinds.includes("website") && !/(?:company|компан)/iu.test(message)) kinds.splice(kinds.indexOf("website"), 1);
    kinds.push("store");
  }
  if (/(?:mobile\s+app|мобільн|мобильн)/iu.test(message)) kinds.push("mobile_app");
  if (/(?:\bcrm\b|срм)/iu.test(message)) kinds.push("crm");
  const names = { website: "Company website", blog: "Blog", store: "Online store", mobile_app: "Mobile app", crm: "CRM" };
  const count = kinds.length === 1 ? Number(/(?:create|build|make|створи|зроби|создай)\s+(?:мені\s+)?(\d+)/iu.exec(message)?.[1] ?? 1) : kinds.length;
  if (count > 4 || kinds.length > 4) throw new Error("A chat can start up to four development projects at once.");
  const targets = kinds.length === 1 ? Array.from({ length: Math.max(1, count) }, () => kinds[0]!) : kinds;
  return targets.map((kind, index) => ({ kind, name: names[kind] + (count > 1 && kinds.length === 1 ? " " + (index + 1) : ""), framework: kind === "mobile_app" ? "Expo" : /html\s*(?:\/|and|\+)\s*css/iu.test(message) ? "HTML/CSS" : "Next.js" }));
}

export function createDevelopmentAssistantIntro(message: string, targets: DevelopmentTarget[], language?: string): string {
  const isUk = language === "uk" || /[\u0400-\u04ff]/u.test(message);
  const targetNames = targets.map(t => {
    if (isUk) {
      if (t.name === "Online store") return "Інтернет-магазин";
      if (t.name === "Company website") return "Вебсайт компанії";
      if (t.name === "Blog") return "Блог";
      if (t.name === "Mobile app") return "Мобільний застосунок";
      if (t.name === "CRM") return "CRM-система";
    }
    return t.name;
  }).join(", ");
  const framework = targets[0]?.framework ?? "Next.js";
  if (isUk) {
    const hasCatalog = /каталог/i.test(message);
    const hasCart = /кошик/i.test(message);
    const hasAuth = /авториз|auth/i.test(message);
    const hasBuild = /build|збірк/i.test(message);
    const hasPreview = /preview|прев/i.test(message);
    const features: string[] = [];
    if (hasCatalog) features.push("каталогом");
    if (hasCart) features.push("кошиком");
    if (hasAuth) features.push("авторизацією");
    let intro = `Прийнято! Створюю проєкт «${targetNames}» на базі ${framework}`;
    if (features.length > 0) intro += ` з ${features.join(", ")}`;
    intro += ".";
    if (hasBuild || hasPreview) intro += " Виконаю збірку та запущу Live Preview.";
    else intro += " Налаштую структуру та необхідні компоненти.";
    return intro;
  }
  return `Understood! Creating "${targetNames}" based on ${framework}. Implementing requested features and launching Live Preview.`;
}

