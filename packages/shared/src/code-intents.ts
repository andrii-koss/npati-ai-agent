/**
 * C6 — code intents for the shared router.
 *
 * This module EXTENDS the existing hybrid router: it adds a code-intent classification that the router
 * maps onto its already existing `ProjectIntent` values, instead of introducing a second router. The
 * classifier is deliberately pure and deterministic: no model call, no network, no state.
 *
 * Rules (owner-approved plan, C6 item 8):
 * - Seven code intents: CREATE_CODE, EDIT_CODE, DEBUG_CODE, EXPLAIN_CODE, REVIEW_CODE, REFACTOR_CODE, TEST_CODE.
 * - A code intent that needs a repository requires an ACTIVE code project/session. When there is none we ask
 *   the user which project to use instead of guessing.
 * - EXPLAIN_CODE is the one exception: a general explanation with no active project stays a normal chat
 *   message ("explain what a closure is" must not open a sandbox).
 * - Nothing here decides authorization, budgets or sandbox admission: the caller (PolicyEngine/RBAC) does.
 */

import type { ProjectIntent } from "./project-intent";

export type CodeIntent =
  | "CREATE_CODE"
  | "EDIT_CODE"
  | "DEBUG_CODE"
  | "EXPLAIN_CODE"
  | "REVIEW_CODE"
  | "REFACTOR_CODE"
  | "TEST_CODE";

export const CODE_INTENTS: readonly CodeIntent[] = [
  "CREATE_CODE",
  "EDIT_CODE",
  "DEBUG_CODE",
  "EXPLAIN_CODE",
  "REVIEW_CODE",
  "REFACTOR_CODE",
  "TEST_CODE",
] as const;

/** Intents that only read: they never require write capability, but they still need a project to look at. */
export const READ_ONLY_CODE_INTENTS: readonly CodeIntent[] = ["EXPLAIN_CODE", "REVIEW_CODE"] as const;

/** Intent meanings are stable identifiers used everywhere (logs, Activity, runner input). */
export type CodeProjectKind = "code_project" | "website" | "mobile_app" | "unknown";

export interface CodeIntentInput {
  message: string;
  /** Active code project, if any. Absence is meaningful: it triggers the clarification question. */
  activeProjectId?: string | null;
  activeSessionId?: string | null;
  /** The active project's type. Only `code_project` routes into the coding agent. */
  projectKind?: CodeProjectKind | null;
  /** Result of the existing project-intent classifier, when the caller already has it. */
  projectIntent?: ProjectIntent | null;
}

export interface CodeIntentDecision {
  /** `CHAT` means "not a code intent": the caller must keep the existing chat behaviour unchanged. */
  intent: CodeIntent | "CHAT";
  confidence: number;
  /** Machine-readable reason, always present so routing decisions are explainable in logs/Activity. */
  reason: string;
  /** True when this intent needs a repository and there is no active project, so we must ask. */
  needsProjectSelection: boolean;
  clarificationMessage?: string;
  /** The intent may run without an active project (EXPLAIN_CODE only). */
  projectOptional: boolean;
}

export const PROJECT_SELECTION_MESSAGE =
  "Which project should I work in? Pick an active code project (or create one) and repeat the request.";

/** Keywords are matched against a lowercased message; Ukrainian and English are both first-class. */
const DEBUG_PATTERNS = [
  /(?:виправ|полагод|налагод|дебаж|розберись|чому пада|чому не працю|fix|debug|troubleshoot|broken|fails?|failing|failing test|не проходить|падаюч\p{L}* тест)/iu,
];
const TEST_PATTERNS = [/(?:запусти тести|прожени тести|протестуй|напиши тест|додай тест|run (?:the )?tests?|write (?:a )?tests?|add (?:a )?tests?)/iu];
const REVIEW_PATTERNS = [/(?:рев[ʼ']?ю|перевір код|оглянь код|review (?:the )?code|code review|audit (?:the )?code)/iu];
const REFACTOR_PATTERNS = [/(?:рефактор|перепиши чистіше|оптимізуй код|спрости код|refactor|clean up the code|simplify)/iu];
const EXPLAIN_PATTERNS = [/(?:поясни (?:код|функцію|цей файл)|що робить (?:цей )?(?:код|файл|метод)|explain (?:this |the )?(?:code|function|file)|what does (?:this|the) (?:code|function) do)/iu];
/**
 * An explicit analysis request ("проаналізуй", "оціни", "analyze", "audit"). It is read-only only while the same
 * message carries no change verb: "проаналізуй і виправ" is an edit. Checked before the router's project intent,
 * like EXPLAIN, because a semantic "edit this site" label must not turn "analyze the site" into a write run.
 */
const ANALYSIS_PATTERNS = [/(?:проаналізу|проаналізува|аналізу|зроби аналіз|оціни|оцінити|переглянь|ознайомся|опиши (?:код|проєкт|структур|сайт)|знайди (?:проблем|помилк|слабк)|які (?:є )?проблеми|що не так|analy[sz]e|analysis|\bassess|\bevaluate|\binspect\b|\baudit\b|what(?:'s| is) wrong|find (?:issues|problems|bugs))/iu];
const CHANGE_VERB_PATTERNS = [/(?:виправ|полагод|зміни|змінити|онови|додай|створи|видали|перепиши|зроби (?!аналіз)|налаштуй|встанови|заміни|рефактор|реалізуй|впровад|переробі|\bfix|\bchange|\bupdate|\badd\b|\bcreate|\bremove|\bdelete|\brewrite|\bmake\b|\bimplement|\brefactor|\breplace|\bapply\b|\binstall|\bbuild\b)/iu];
const CREATE_PATTERNS = [/(?:створи|згенеруй|напиши|додай)\s+(?:новий\s+|нову\s+|new\s+)?(?:скрипт|модуль|функці\p{L}*|клас|файл|ендпойнт|сервіс)|create (?:a )?(?:new )?(?:script|module|function|class|file|endpoint|service)/iu];
const EDIT_PATTERNS = [/(?:зміни|змінити|відредагуй|онови|поправ|перейменуй|видали|додай)[^\n]{0,40}(?:функці\p{L}*|модул\p{L}*|файл\p{L}*|клас\p{L}*|код\p{L}*)|(?:edit|modify|update|rename|delete|add)[^\n]{0,30}(?:the )?(?:code|file|function|module|class)/iu];

/**
 * Deterministic code-intent classification. Order matters: the most specific intent wins, and the
 * destructive/blocking ones (debug, test, review, refactor) are checked before the generic edit.
 */
export function classifyCodeIntent(input: CodeIntentInput): CodeIntentDecision {
  const message = (input.message ?? "").trim();
  const hasProject = Boolean(input.activeProjectId);
  const projectKind: CodeProjectKind = input.projectKind ?? (hasProject ? "code_project" : "unknown");
  // A website/mobile project is handled by the existing project pipeline, never by the coding agent.
  const codeContext = projectKind === "code_project" || projectKind === "unknown";

  const matches = (patterns: RegExp[]): boolean => patterns.some((pattern) => pattern.test(message));
  const decided = (intent: CodeIntent, confidence: number, reason: string): CodeIntentDecision =>
    finish(intent, confidence, reason, input);

  if (!message) return { intent: "CHAT", confidence: 0, reason: "empty_message", needsProjectSelection: false, projectOptional: false };

  if (!codeContext) {
    return { intent: "CHAT", confidence: 0.9, reason: `project_kind_not_code:${projectKind}`, needsProjectSelection: false, projectOptional: false };
  }

  if (matches(ANALYSIS_PATTERNS) && !matches(CHANGE_VERB_PATTERNS)) return decided("REVIEW_CODE", 0.8, "analysis_keywords_without_change");

  // Explicit project intent from the existing router has priority: it already understands the domain.
  const fromProjectIntent = mapProjectIntentToCodeIntent(input.projectIntent ?? null, projectKind);
  if (fromProjectIntent && matches(DEBUG_PATTERNS) === false && matches(EXPLAIN_PATTERNS) === false) {
    return decided(fromProjectIntent, 0.85, `project_intent:${input.projectIntent}`);
  }

  if (matches(EXPLAIN_PATTERNS)) return decided("EXPLAIN_CODE", 0.8, "explain_code_keywords");
  if (matches(DEBUG_PATTERNS)) return decided("DEBUG_CODE", 0.85, "debug_code_keywords");
  if (matches(TEST_PATTERNS)) return decided("TEST_CODE", 0.8, "test_code_keywords");
  if (matches(REVIEW_PATTERNS)) return decided("REVIEW_CODE", 0.8, "review_code_keywords");
  if (matches(REFACTOR_PATTERNS)) return decided("REFACTOR_CODE", 0.75, "refactor_code_keywords");
  if (matches(CREATE_PATTERNS)) return decided("CREATE_CODE", 0.7, "create_code_keywords");
  if (matches(EDIT_PATTERNS)) return decided("EDIT_CODE", 0.7, "edit_code_keywords");
  if (fromProjectIntent) return decided(fromProjectIntent, 0.6, `project_intent:${input.projectIntent}`);

  return { intent: "CHAT", confidence: 0.5, reason: "no_code_intent_signal", needsProjectSelection: false, projectOptional: false };
}

function finish(intent: CodeIntent, confidence: number, reason: string, input: CodeIntentInput): CodeIntentDecision {
  const projectOptional = READ_ONLY_CODE_INTENTS.includes(intent) && intent === "EXPLAIN_CODE";
  const hasProject = Boolean(input.activeProjectId);
  // Without a project we ask instead of guessing, except for a general explanation, which stays chat.
  if (!hasProject && !projectOptional) {
    return { intent, confidence, reason, needsProjectSelection: true, clarificationMessage: PROJECT_SELECTION_MESSAGE, projectOptional: false };
  }
  if (!hasProject && projectOptional) {
    return { intent: "CHAT", confidence, reason: `${reason}:no_project_explanation_only`, needsProjectSelection: false, projectOptional: true };
  }
  return { intent, confidence, reason, needsProjectSelection: false, projectOptional };
}

/**
 * Maps the existing router's `ProjectIntent` onto a code intent. Returns `null` when the project intent
 * has no code meaning (CHAT, deploy, repository connection, data model, …) so the caller keeps the current
 * behaviour for those.
 */
export function mapProjectIntentToCodeIntent(intent: ProjectIntent | null, projectKind: CodeProjectKind = "code_project"): CodeIntent | null {
  if (!intent) return null;
  if (projectKind !== "code_project") {
    // Website/mobile builds are not code-agent work even when the verbs look similar.
    return null;
  }
  switch (intent) {
    case "DEBUG_PROJECT":
      return "DEBUG_CODE";
    case "TEST_PROJECT":
      return "TEST_CODE";
    case "REVIEW_PROJECT":
      return "REVIEW_CODE";
    case "IMPROVE_PROJECT":
      return "REFACTOR_CODE";
    case "EDIT_PROJECT":
    case "EDIT_WEBSITE":
    case "CONTINUE_PROJECT":
      return "EDIT_CODE";
    case "CREATE_PROJECT":
    case "CREATE_WEBSITE":
      return "CREATE_CODE";
    default:
      return null;
  }
}

/** True when the intent may mutate the workspace; used by callers to decide on write capability/flags. */
export function codeIntentIsReadOnly(intent: CodeIntent | "CHAT"): boolean {
  return intent !== "CHAT" && READ_ONLY_CODE_INTENTS.includes(intent);
}

/** Stable, versioned identifier for anything persisted or streamed (C1a naming rules). */
export const CODE_INTENT_SCHEMA_VERSION = 1;
