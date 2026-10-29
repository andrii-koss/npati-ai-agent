/**
 * Which published `code.*` tools a model is actually shown for one run.
 *
 * This is a *view* over the catalogue, never a permission: the registry, the Capability Inspector and the
 * PolicyEngine are unchanged, and a hidden tool that the model names anyway is still judged (and refused) by
 * the runtime exactly as before. The only goal is a smaller, relevant tool list — fewer schema tokens on every
 * request and fewer wrong tool choices.
 *
 * Three tiers, all deterministic (no extra model call):
 *  - `core`        — always shown (subject to the session mode / read-only intent, which already removed writes);
 *  - `contextual`  — shown when a cheap signal in the user's message or run input matches (image attached, URL,
 *                    visual request, genuinely open-ended request);
 *  - `intent`      — tool families shown only when the request or the project state needs them (git, deps,
 *                    sub-agents, processes, async, data, MCP, planning, workspace maintenance).
 *
 * The tier lists are model-profile configuration (`CodeModelProfile.toolVisibility`); this module only owns the
 * defaults and the matching rules.
 */

export type CodeToolIntentGroup =
  | "git"
  | "deps"
  | "subagents"
  | "processes"
  | "async"
  | "data"
  | "mcp"
  | "planning"
  | "workspace";

export const CODE_TOOL_INTENT_GROUPS: readonly CodeToolIntentGroup[] = [
  "git", "deps", "subagents", "processes", "async", "data", "mcp", "planning", "workspace",
];

export interface CodeToolVisibilityPolicy {
  /** Shown on every run (minus whatever the mode already removed). */
  core: readonly string[];
  /** Contextual tools this profile may receive when their signal matches. */
  contextual: readonly string[];
  /** Intent groups this profile may receive when the request or project state asks for them. */
  intentGroups: readonly CodeToolIntentGroup[];
}

/** Full core for hosted models with native tool calling and a large window. */
export const DEFAULT_CODE_TOOL_VISIBILITY: CodeToolVisibilityPolicy = Object.freeze({
  core: Object.freeze([
    "code.fs.read", "code.fs.list", "code.fs.grep", "code.fs.tree", "code.project.info",
    "code.fs.edit", "code.fs.apply_patch", "code.fs.write", "code.fs.diff",
    "code.shell.exec", "code.verify.run", "code.finish",
  ]),
  contextual: Object.freeze(["code.image.view", "code.web.fetch", "code.web.search", "code.preview.screenshot", "code.preview.restart", "code.ask_user"]),
  intentGroups: CODE_TOOL_INTENT_GROUPS,
});

/**
 * Minimal core for small-context and local text-protocol models: every schema costs a larger share of their
 * window, and a text-parsed model handles a short list far more reliably. No patch format (exact edits only),
 * no tree (list + grep cover orientation), no sub-agents or async families.
 */
export const MINIMAL_CODE_TOOL_VISIBILITY: CodeToolVisibilityPolicy = Object.freeze({
  core: Object.freeze([
    "code.fs.read", "code.fs.list", "code.fs.grep",
    "code.fs.edit", "code.fs.write",
    "code.shell.exec", "code.verify.run", "code.finish",
  ]),
  contextual: Object.freeze(["code.image.view", "code.web.fetch", "code.preview.screenshot", "code.preview.restart", "code.ask_user"]),
  intentGroups: Object.freeze(["git", "deps", "data", "planning", "workspace", "mcp"] as CodeToolIntentGroup[]),
});

/**
 * Tools that are published and implemented but currently fail in practice. They stay in the registry and the
 * Inspector (with this status) and are not offered to the model. Evidence: `docs/audit/coding-tools-audit.md`
 * §3.4 — `code.shell.process.wait` 4/4 `tool_failed` (HTTP 500), `code.shell.exec_async` never succeeded.
 */
export const CODE_TOOL_MODEL_STATUS: Readonly<Record<string, { status: "degraded"; reason: string }>> = Object.freeze({
  "code.shell.exec_async": { status: "degraded", reason: "tracked async execution has no successful run on record; use code.shell.exec or code.verify.run" },
  "code.shell.process.wait": { status: "degraded", reason: "every recorded call failed with tool_failed (HTTP 500)" },
});

export function codeToolModelStatus(name: string): { status: "visible" | "degraded"; reason?: string } {
  return CODE_TOOL_MODEL_STATUS[name] ?? { status: "visible" };
}

/** Maps a tool to its intent group; `null` means the tool is not in a group (core or contextual). */
export function intentGroupForTool(name: string): CodeToolIntentGroup | null {
  if (!name.startsWith("code.")) return "mcp";
  if (name.startsWith("code.git.")) return "git";
  if (name.startsWith("code.deps.")) return "deps";
  if (name.startsWith("code.agent.")) return "subagents";
  if (name === "code.shell.exec_async" || name === "code.shell.process.wait") return "async";
  if (name.startsWith("code.shell.process.")) return "processes";
  if (name.startsWith("code.data.")) return "data";
  if (name === "code.plan.propose" || name === "code.plan.update") return "planning";
  if (["code.fs.move", "code.fs.delete", "code.fs.undo_last_turn", "code.symbols.outline"].includes(name)) return "workspace";
  return null;
}

export interface CodeToolVisibilityContext {
  /** The user's own words. Never the composed prompt, which carries system guidance with incidental keywords. */
  userMessage: string;
  sessionMode: string;
  readOnlyIntent?: boolean;
  websiteEdit?: boolean;
  requireImplementation?: boolean;
  imageCount?: number;
  dataBackendAttached?: boolean;
  /** `code.data_studio`: when off, the data group is never offered. */
  dataStudioEnabled?: boolean;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/iu;
/** A check of the running site (console errors, broken links, Live Preview) needs the Browser QA tool, not only a build. */
const BROWSER_QA_PATTERN = /(?:browser\s*qa|\bqa\b|console\s+errors?|broken\s+links?|live\s+preview|\bpreview\b|консол\p{L}*|бит\p{L}*\s+посилан\p{L}*|прев[ʼ'’]?ю|відкрий\s+(?:сайт|сторінк\p{L}*|меню)|erros?\s+de\s+console|links?\s+quebrad\p{L}*|errores?\s+de\s+consola|konsolenfehler|defekte\s+links)/iu;
const DOCS_PATTERN = /(?:документац|довідк|знайди в (?:інтернеті|мережі)|пошукай в (?:інтернеті|мережі)|загугли|\bdocs?\b|documentation|api reference|search the web|look it up online|\bgoogle\b|latest version|остання версія)/iu;
const IMAGE_PATTERN = /(?:фото|зображен|картинк|скрин|логотип|іконк|\bimage|\bpicture|\bphoto|screenshot|\blogo\b|\.(?:png|jpe?g|gif|webp|svg)\b)/iu;
const VISUAL_PATTERN = /(?:дизайн|вигляд|виглядає|колір|кольор|стил[ьяі]|макет|верстк|шрифт|відступ|адаптив|мобільн|кнопк|(?<!\p{L})фон(?!\p{L})|\bdesign|\blook|\bcolou?r|\bstyle|\blayout|\bcss\b|\bfont|spacing|responsive|\btheme|\bui\b|screenshot|скрин)/iu;
const ASK_PATTERN = /(?:запитай|уточни|спитай|ask me|clarify|which (?:one|option)|який (?:варіант|краще)|що краще)/iu;
const GROUP_PATTERNS: Record<Exclude<CodeToolIntentGroup, "mcp">, RegExp> = {
  git: /(?:\bgit\b|коміт|закоміть|commit|гілк|\bbranch|\bpush\b|запуш|pull request|\bpr\b|merge|злий|github|історі[яю] змін|git log|відкоти коміт)/iu,
  deps: /(?:залежн|пакет|бібліотек|dependenc|\bpackage|\blibrary|npm (?:i|install|add)\b|yarn add|pnpm add|pip install|composer require|vulnerab|вразлив|\baudit\b|lockfile|package\.json|requirements\.txt)/iu,
  subagents: /(?:субагент|sub-?agent|делегуй|delegate|паралельно кількома агентами|in parallel agents)/iu,
  processes: /(?:dev[- ]?server|сервер розробки|запусти сервер|start the server|\bwatch\b|watcher|фонов\w* процес|background process|\blogs?\b|(?<!\p{L})логи?(?!\p{L})|зупини процес|stop the process)/iu,
  async: /(?:довгий процес|long[- ]running|in the background|у фоні|фоново)/iu,
  data: /(?:баз[аиуі] даних|(?<!\p{L})бд(?!\p{L})|database|\bdb\b|таблиц|\btable|схем[аиуі] (?:бази|даних)|schema|колонк|\bcolumn|\bfield|поле в|\brls\b|row level|політик[аиу] доступу|access polic|\bseed|наповни|тестов\w* дан|міграц|migration|\bsql\b|збереж\w* дан|зберігат\w* дан|store data|persist|data studio|supabase|postgres)/iu,
  planning: /(?:(?<!\p{L})план(?!\p{L})|сплануй|сплануват|\bplan\b|\btodo\b|список задач|покроков|step[- ]by[- ]step)/iu,
  workspace: /(?:перейменуй|перемісти|rename|\bmove\b|видали файл|видали теку|delete (?:the )?file|remove (?:the )?file|undo|відкоти|скасуй останн|revert|outline|символи файлу|\bsymbols?\b)/iu,
};

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

/** Contextual signals, evaluated on the user's words and the run input only. */
export function contextualToolMatches(context: CodeToolVisibilityContext): Set<string> {
  const message = context.userMessage ?? "";
  const runtimeRequested = BROWSER_QA_PATTERN.test(message) || /(?:\brestart\b|перезапус\p{L}*|runtime[-\s]*(?:errors?|помил\p{L}*)|зіграй|новий\s+раунд)/iu.test(message);
  const matched = new Set<string>();
  const hasImages = (context.imageCount ?? 0) > 0;
  if (hasImages || IMAGE_PATTERN.test(message)) matched.add("code.image.view");
  if (URL_PATTERN.test(message)) matched.add("code.web.fetch");
  if (DOCS_PATTERN.test(message)) { matched.add("code.web.search"); matched.add("code.web.fetch"); }
  if (context.websiteEdit && (hasImages || VISUAL_PATTERN.test(message) || runtimeRequested)) matched.add("code.preview.screenshot");
  if (context.websiteEdit && runtimeRequested && !context.readOnlyIntent && context.sessionMode !== "plan") matched.add("code.preview.restart");
  // A question is worth pausing a run for only when the request is genuinely open: a creation request, an
  // explicit "ask me", or a message too short to name a target. A concrete edit must not stop to ask.
  if (context.requireImplementation || ASK_PATTERN.test(message) || wordCount(message) <= 3) matched.add("code.ask_user");
  return matched;
}

/** Intent groups requested by the user's words or by the project state. */
export function intentGroupMatches(context: CodeToolVisibilityContext, runtimeToolNames: readonly string[] = []): Set<CodeToolIntentGroup> {
  const message = context.userMessage ?? "";
  const groups = new Set<CodeToolIntentGroup>();
  for (const [group, pattern] of Object.entries(GROUP_PATTERNS) as Array<[Exclude<CodeToolIntentGroup, "mcp">, RegExp]>) {
    if (pattern.test(message)) groups.add(group);
  }
  if (context.dataBackendAttached) groups.add("data");
  if (context.sessionMode === "plan" || context.requireImplementation) groups.add("planning");
  // A runtime MCP tool is offered when the user names MCP or the tool/connection itself.
  const lowered = message.toLowerCase();
  if (/\bmcp\b/iu.test(message) || runtimeToolNames.some((name) => name.split(/[:/._-]+/u).some((part) => part.length >= 4 && lowered.includes(part.toLowerCase())))) {
    groups.add("mcp");
  }
  if (context.dataStudioEnabled === false) groups.delete("data");
  return groups;
}

export interface CodeToolVisibilityDecision {
  visible: string[];
  hidden: Array<{ name: string; reason: "degraded" | "not_in_tier" | "intent_not_requested" | "context_not_matched" | "data_studio_disabled" }>;
  contextual: string[];
  intentGroups: CodeToolIntentGroup[];
}

/**
 * Applies a profile's tiers to the tools the catalogue already allowed for this run (mode, read-only intent,
 * flags, delegation and manifest pin are applied before this). Order of the input list is preserved.
 */
export function selectVisibleTools(
  available: readonly string[],
  policy: CodeToolVisibilityPolicy,
  context: CodeToolVisibilityContext,
): CodeToolVisibilityDecision {
  const core = new Set(policy.core);
  const contextualAllowed = new Set(policy.contextual);
  const groupsAllowed = new Set(policy.intentGroups);
  const contextual = contextualToolMatches(context);
  const runtimeNames = available.filter((name) => !name.startsWith("code."));
  const groups = intentGroupMatches(context, runtimeNames);
  const visible: string[] = [];
  const hidden: CodeToolVisibilityDecision["hidden"] = [];
  for (const name of available) {
    if (codeToolModelStatus(name).status === "degraded") { hidden.push({ name, reason: "degraded" }); continue; }
    if (core.has(name)) { visible.push(name); continue; }
    if (contextualAllowed.has(name)) {
      if (contextual.has(name)) visible.push(name);
      else hidden.push({ name, reason: "context_not_matched" });
      continue;
    }
    const group = intentGroupForTool(name);
    if (group && groupsAllowed.has(group)) {
      if (groups.has(group)) visible.push(name);
      else hidden.push({ name, reason: group === "data" && context.dataStudioEnabled === false ? "data_studio_disabled" : "intent_not_requested" });
      continue;
    }
    hidden.push({ name, reason: "not_in_tier" });
  }
  return { visible, hidden, contextual: [...contextual], intentGroups: [...groups] };
}

export function validateCodeToolVisibilityPolicy(policy: unknown, profileId: string): void {
  if (policy === undefined) return;
  const value = policy as Partial<CodeToolVisibilityPolicy> | null;
  if (!value || typeof value !== "object") throw new Error(`Model profile ${profileId}: toolVisibility must be an object`);
  for (const key of ["core", "contextual"] as const) {
    const list = value[key];
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error(`Model profile ${profileId}: toolVisibility.${key} must be an array of tool names`);
    }
  }
  if (!Array.isArray(value.intentGroups) || value.intentGroups.some((group) => !CODE_TOOL_INTENT_GROUPS.includes(group))) {
    throw new Error(`Model profile ${profileId}: toolVisibility.intentGroups contains an unknown group`);
  }
}

/** Tool families a website edit or a creation run may be offered; git, sub-agents and admin tools are not. */
export const WEBSITE_EDIT_TOOL_PATTERN = /^code\.(fs\.|deps\.|shell\.|verify\.|web\.|data\.|plan\.|project\.info$|ask_user$|finish$|image\.view$|preview\.(?:screenshot|restart)$)/;

/** Gates whether the `code.data.*` family is offered to the model at all (a view, never a permission). */
export const CODE_DATA_STUDIO_FLAG = "code.data_studio";

/** The explicit end-of-run tool; a successful call settles the run like a final answer. */
export const CODE_FINISH_TOOL = "code.finish";

/** True when the settled tool message for `toolCallId` reports success. */
export function toolCallSucceeded(messages: ReadonlyArray<{ role: string; tool_call_id?: string; content?: unknown }>, toolCallId: string): boolean {
  const settled = messages.find((message) => message.role === "tool" && message.tool_call_id === toolCallId);
  return typeof settled?.content === "string" && /^\{\s*"ok"\s*:\s*true\b/u.test(settled.content);
}

/**
 * The final answer of a turn that called `code.finish` successfully (assistant prose plus the summary), or
 * `null` when the turn did not finish. A refused or invalid finish is ordinary tool feedback.
 */
export function finishedRunText(
  calls: ReadonlyArray<{ id: string; name: string; arguments: Record<string, unknown> }>,
  messages: ReadonlyArray<{ role: string; tool_call_id?: string; content?: unknown }>,
  assistantText: string,
): string | null {
  const call = calls.find((entry) => entry.name === CODE_FINISH_TOOL);
  if (!call || !toolCallSucceeded(messages, call.id)) return null;
  const summary = typeof call.arguments.summary === "string" ? call.arguments.summary.trim() : "";
  return [assistantText.trim(), summary].filter(Boolean).join("\n\n");
}
