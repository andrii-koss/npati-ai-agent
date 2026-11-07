export const DEVELOPMENT_PROCESS_SETTINGS_KEY = "chat-development-processes:v1";
import { classifyProjectIntent, extractFramework, isBackendProjectFramework, isMobileProjectFramework } from "./project-intent";
/** Shared deterministic routing: creation requests only, never ordinary project edits. */
export type DevelopmentTarget = { name: string; kind: "website" | "blog" | "store" | "crm" | "mobile_app" | "game" | "api"; framework: string; technologySelection?: { source: "user_explicit" | "ai_planner" | "policy_fallback"; reason: string; criteria: string[] } };
export type ModelTurnUsage = { id: string; turn: number; totalTokens?: number; inputTokens?: number; outputTokens?: number; costUsd?: number; model?: string; provider?: string; toolCallIds: string[]; durationMs?: number; /** Provider-reported cached prompt tokens, when it reports them. */ cachedTokens?: number };
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
// "в застосунку", "in the app": a place the request is about, not a thing to build.
const WEB_APP = /(?<!(?:^|[\s(])(?:в|у|до|із|з|in|on|to|into|from|the|my|this|your)\s)(?:\bweb\s*app\b|\bapp\b|\bapplication\b|застосун\p{L}*|додат(?:ок|ку|ком)|приложени\p{L}*|\bscene\b|сцен\p{L}*|(?<![\p{L}\d])3d(?![\p{L}])|three\.?js|webgl|\bcanvas\b|\btodo\b|to-?do|дашборд|dashboard|калькулятор|calculator|портфоліо|портфолио|portfolio)/iu;

export function planChatDevelopment(message: string, activeProjectId?: string): DevelopmentTarget[] {
  // A follow-up that explicitly says "do not create a new project, edit this one" must never
  // be re-planned as a creation just because the requested replacement text names a framework.
  if (/(?:не\s+створюй|не\s+создавай|do\s+not\s+create|don't\s+create)\s+(?:новий\s+|новый\s+|a\s+new\s+|new\s+)?(?:про[єе]кт|project)/iu.test(message)) return [];
  if (activeProjectId && !["CREATE_PROJECT", "CREATE_WEBSITE"].includes(classifyProjectIntent({ message, activeProjectId }).intent)) return [];
  if (!/(?:\bcreate\b|\bbuild\s+(?:a\s+|an\s+|new\s+|[1-4]\s+)?(?:website|site|shop|store|blog|mobile|crm)|\bbuild\b(?=[^.!?\n]{0,40}\b(?:app|application|game|scene|dashboard|tool)\b)|\bmake\b|створ|зроби|создай|создать)/iu.test(message)) return [];
  if (/(?:create|make|створ|зроби|создай).*(?:\bpage\b|\bcomponent\b|\bbutton\b|\bheader\b|сторінк|компонент|кнопк)/iu.test(message)
      && (/(?:my|this|existing|current)\s+(?:website|web\s*site|\bsite\b|project|app)|(?:мій|цей|існуюч)\p{L}*/iu.test(message)
        || (!/(?:website|web\s*site|\bsite\b|project|app|сайт|про[єе]кт|застосун\p{L}*|магазин|store|shop|blog|блог|crm|срм)/iu.test(message)
          && !/(?:new\s+(?:website|site)|новий\s+сайт)/iu.test(message)))) return [];
  const kinds: DevelopmentTarget["kind"][] = [];
  const requestedFramework = extractFramework(message);
  // "Лендинг" is how a landing page is usually written in Ukrainian and Russian; without it such a request went to the
  // plain chat, which built the site with no steps on screen.
  if (/(?:website|\bsite\b|сайт|landing|ленд[иі]нг|лэндинг)/iu.test(message)) kinds.push("website");
  if (/(?:blog|блог)/iu.test(message)) kinds.push("blog");
  if (/(?:store|shop|магазин)/iu.test(message)) {
    // A 'website shop' is one project; explicitly separate company sites remain distinct.
    if (kinds.includes("website") && !/(?:company|компан)/iu.test(message)) kinds.splice(kinds.indexOf("website"), 1);
    kinds.push("store");
  }
  if (/(?:mobile\s+app|мобільн|мобильн|\bexpo\b|\bflutter\b|react[\s-]*native|android)/iu.test(message)) kinds.push("mobile_app");
  if (/(?:\bcrm\b|срм)/iu.test(message)) kinds.push("crm");
  // A game becomes its own project; a mobile game stays a mobile app (Expo).
  if (!kinds.includes("mobile_app") && /(?:\bgames?\b|(?<![\p{L}])(?:гр[уаи]|ігр\p{L}*|игр\p{L}*)(?![\p{L}]))/iu.test(message)) kinds.push("game");
  // A backend prompt need not contain the word "website": creating an Express/FastAPI service
  // is still a code project and must enter the coding-agent path rather than a generic chat.
  if (!kinds.length && isBackendProjectFramework(requestedFramework)) kinds.push("api");
  // A web app, a 3D scene, a dashboard or anything built with a named front-end framework is a project too. Without this
  // "Створи сцену на Three.js …" or "Build a React + Vite TODO app" went to the plain chat and was built with no steps.
  const webApp = !kinds.length && (WEB_APP.test(message) || (!!requestedFramework && requestedFramework !== "HTML/CSS" && !isMobileProjectFramework(requestedFramework)));
  if (webApp) kinds.push("website");
  const names = { website: webApp ? "Web app" : "Company website", blog: "Blog", store: "Online store", mobile_app: "Mobile app", game: "Game", crm: "CRM", api: "API service" };
  // "Створи 2D-гру" asks for one game: a number joined to a letter (2D, 3D) is not a count of projects.
  const count = kinds.length === 1 ? Number(/(?:create|build|make|створи|зроби|создай)\s+(?:мені\s+)?(\d+)(?![\p{L}\d])/iu.exec(message)?.[1] ?? 1) : kinds.length;
  if (count > 4 || kinds.length > 4) throw new Error("A chat can start up to four development projects at once.");
  const targets = kinds.length === 1 ? Array.from({ length: Math.max(1, count) }, () => kinds[0]!) : kinds;
  return targets.map((kind, index) => ({
    kind,
    name: names[kind] + (count > 1 && kinds.length === 1 ? " " + (index + 1) : ""),
    framework: kind === "mobile_app" ? isMobileProjectFramework(requestedFramework) ? requestedFramework! : "Expo" : requestedFramework ?? "HTML/CSS",
  }));
}

export function createDevelopmentAssistantIntro(message: string, targets: DevelopmentTarget[], language?: string): string {
  const isUk = language === "uk" || /[\u0400-\u04ff]/u.test(message);
  const targetNames = targets.map(t => {
    if (isUk) {
      if (t.name === "Online store") return "Інтернет-магазин";
      if (t.name === "Company website") return "Вебсайт компанії";
      if (t.name === "Blog") return "Блог";
      if (t.name === "Mobile app") return "Мобільний застосунок";
      if (t.name === "Game") return "Гра";
      if (t.name === "CRM") return "CRM-система";
      if (t.name === "API service") return "API-сервіс";
    }
    return t.name;
  }).join(", ");
  const framework = targets[0]?.framework ?? "HTML/CSS";
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

