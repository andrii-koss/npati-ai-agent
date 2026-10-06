import type {
  ApiRequest,
  ApprovalCardData,
  ApprovalDecisionPlan,
  ApprovalScope,
  AskUserAnswer,
  AskUserCardData,
  CodeSessionMode,
} from "./types";

/**
 * C7: the pure request mapping behind every control in the workspace.
 *
 * Why this lives outside the components: the UI must not be able to decide *what* an approval means.
 * Components render and collect a choice; these functions turn that choice into an explicit request
 * against the existing API, so the mapping can be asserted in a Node-only test run (no jsdom) and so a
 * reviewer can read in one place which endpoints the UI is allowed to call.
 *
 * Server contracts this mirrors:
 *  - approval decision: `POST /companies/:companyId/approvals/:approvalId/decide`
 *    body `{ decision: "approved" | "rejected", notes?: string }` (approvals-routes.ts);
 *  - standing rule: `POST /companies/:companyId/code/approval-rules`
 *    body `{ scope: "session" | "project", action, projectId?, sessionId?, command? }`
 *    (code-approval-routes.ts, C5);
 *  - mode change: `PUT /companies/:companyId/code/sessions/:sessionId/mode`
 *    body `{ mode, expectedRevision }` (C5a, owner/admin only);
 *  - stop / changes-revert: added by the C7 session-control stream — kept here as the single place to
 *    adjust if those paths change.
 */

export interface ApprovalChoiceInput {
  companyId: string;
  approval: Pick<ApprovalCardData, "approvalId" | "action" | "command">;
  scope: ApprovalScope;
  /** Returned to the model on `deny`; ignored for approvals. */
  comment?: string;
  projectId?: string;
  sessionId?: string;
}

/** The decision payload the approvals API accepts (`decision`/`notes`), never a free-form object. */
export function approvalDecisionPayload(scope: ApprovalScope, comment?: string): Record<string, unknown> {
  if (scope === "deny") {
    const notes = (comment ?? "").trim();
    return notes.length > 0 ? { decision: "rejected", notes } : { decision: "rejected" };
  }
  return { decision: "approved" };
}

/**
 * Turn a card choice into the requests to send. `once` and `deny` never create a standing rule — that
 * separation is what keeps "approve for project" from silently becoming a blanket permission.
 */
export function approvalDecisionPlan(input: ApprovalChoiceInput): ApprovalDecisionPlan {
  const base = `/companies/${encodeURIComponent(input.companyId)}/approvals/${encodeURIComponent(
    input.approval.approvalId
  )}/decide`;

  const decide: ApiRequest = {
    method: "POST",
    path: base,
    body: approvalDecisionPayload(input.scope, input.comment),
  };

  if (input.scope === "once") return { decide, summary: "approved once" };
  if (input.scope === "deny") return { decide, summary: "denied" };

  const body: Record<string, unknown> = { scope: input.scope, action: input.approval.action };
  if (input.projectId) body.projectId = input.projectId;
  if (input.sessionId) body.sessionId = input.sessionId;
  // A shell allowance must name the command shape it covers, so the rule cannot be replayed onto
  // another command (the service refuses ambiguous shell rules).
  if (input.approval.command) body.command = input.approval.command;

  return {
    decide,
    rule: { method: "POST", path: `/companies/${encodeURIComponent(input.companyId)}/code/approval-rules`, body },
    summary: input.scope === "project" ? "approved for project" : "approved for session",
  };
}

export type PathValidation = { ok: true; paths: string[] } | { ok: false; reason: string; path: string };

/**
 * Validate workspace-relative paths coming from the UI before asking the server to revert them.
 * The server validates too; doing it here means a malicious or mistyped path never reaches a git call
 * and the user sees why. Absolute paths, drive letters, `..` segments, backslashes, `~` and control
 * characters are all refused rather than normalised — normalising a traversal is still a traversal.
 */
export function validateChangePaths(paths: readonly string[]): PathValidation {
  if (paths.length === 0) return { ok: false, reason: "empty selection", path: "" };
  for (const raw of paths) {
    const path = String(raw ?? "");
    if (path.trim().length === 0) return { ok: false, reason: "empty path", path };
    if (path !== path.trim()) return { ok: false, reason: "untrimmed path", path };
    if (path.startsWith("/") || path.startsWith("\\")) return { ok: false, reason: "absolute path", path };
    if (/^[a-zA-Z]:/.test(path)) return { ok: false, reason: "drive-letter path", path };
    if (path.includes("\\")) return { ok: false, reason: "backslash path", path };
    if (path.startsWith("~")) return { ok: false, reason: "home-relative path", path };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(path)) return { ok: false, reason: "control character", path };
    if (path.split("/").some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
      return { ok: false, reason: "traversal or empty segment", path };
    }
  }
  return { ok: true, paths: [...paths] };
}

export interface RevertInput {
  companyId: string;
  sessionId: string;
  files?: readonly string[];
  all?: boolean;
}

export type RevertPlan = { ok: true; request: ApiRequest } | { ok: false; reason: string; path?: string };

/** `all` reverts the whole turn; a file list is validated first and never mutated to make it pass. */
export function revertRequest(input: RevertInput): RevertPlan {
  const path = `/companies/${encodeURIComponent(input.companyId)}/code/sessions/${encodeURIComponent(
    input.sessionId
  )}/changes/revert`;

  if (input.all === true) return { ok: true, request: { method: "POST", path, body: { all: true } } };

  const files = input.files ?? [];
  const validated = validateChangePaths(files);
  if (!validated.ok) return { ok: false, reason: validated.reason, path: validated.path };
  return { ok: true, request: { method: "POST", path, body: { files: validated.paths } } };
}

export function modeChangeRequest(input: {
  companyId: string;
  sessionId: string;
  mode: CodeSessionMode;
  expectedRevision: number;
}): ApiRequest {
  return {
    method: "PUT",
    path: `/companies/${encodeURIComponent(input.companyId)}/code/sessions/${encodeURIComponent(
      input.sessionId
    )}/mode`,
    body: { mode: input.mode, expectedRevision: input.expectedRevision },
  };
}

export function stopRequest(input: { companyId: string; sessionId: string }): ApiRequest {
  return {
    method: "POST",
    path: `/companies/${encodeURIComponent(input.companyId)}/code/sessions/${encodeURIComponent(
      input.sessionId
    )}/stop`,
    body: {},
  };
}

/** Human labels in the two supported UI languages, kept beside the mapping so they cannot drift. */
export function approvalScopeLabel(scope: ApprovalScope, isUk: boolean): string {
  const labels: Record<ApprovalScope, [string, string]> = {
    once: ["Approve once", "Дозволити один раз"],
    session: ["Approve for session", "Дозволити на сесію"],
    project: ["Approve for project", "Дозволити для проєкту"],
    deny: ["Deny", "Відхилити"],
  };
  const entry = labels[scope];
  return isUk ? entry[1] : entry[0];
}

export function modeLabel(mode: CodeSessionMode, isUk: boolean): string {
  const labels: Record<CodeSessionMode, [string, string]> = {
    plan: ["Plan", "План"],
    ask: ["Ask", "Питати"],
    auto_edit: ["Auto edit", "Авто-редагування"],
    full_auto_sandbox: ["Full auto (sandbox)", "Повний авто (sandbox)"],
  };
  const entry = labels[mode];
  return isUk ? entry[1] : entry[0];
}

/**
 * Label for a mode that came out of persisted data, where the C1 spellings (`edit`, `auto`, `full_auto`) can
 * still appear on sessions created before C5. Returns null for anything unrecognised rather than inventing a
 * label for a value the server would not accept.
 */
export function persistedModeLabel(mode: string | null | undefined, isUk: boolean): string | null {
  if (!mode) return null;
  const canonical: Record<string, CodeSessionMode> = {
    plan: "plan",
    ask: "ask",
    edit: "ask",
    auto: "auto_edit",
    auto_edit: "auto_edit",
    full_auto: "full_auto_sandbox",
    full_auto_sandbox: "full_auto_sandbox",
  };
  const resolved = canonical[mode];
  return resolved ? modeLabel(resolved, isUk) : null;
}

/** Upper bound for a free-form answer, mirroring the approvals `notes` limit the API already enforces. */
export const ASK_USER_FREE_ANSWER_MAX = 2000;

export type AskUserAnswerValidation = { ok: true; answer: AskUserAnswer } | { ok: false; reason: string };

/**
 * C9: the one rule for what counts as a valid answer to an `ask_user` card, shared by the card and (by
 * intent) the server. A choice and a free-form answer are mutually exclusive: accepting both would leave the
 * record ambiguous about what the human actually decided, and the run would continue on an interpretation.
 *
 * The choice ids are checked against the card's own `choices`, so a stale or tampered UI cannot answer with
 * an option that was never offered. The free-form answer is refused when the server said it does not accept
 * one — a UI that offers more than the API accepts produces a rejected answer after the user has typed it.
 */
export function validateAskUserAnswer(answer: AskUserAnswer, card: AskUserCardData): AskUserAnswerValidation {
  if (card.status !== "pending") {
    return { ok: false, reason: `the question is not open (status: ${card.status})` };
  }

  const choiceId = answer.choiceId;
  const freeAnswer = (answer.freeAnswer ?? "").trim();

  if (choiceId !== undefined && freeAnswer.length > 0) {
    return { ok: false, reason: "choose an option or write your own answer, not both" };
  }
  if (choiceId === undefined && freeAnswer.length === 0) {
    return { ok: false, reason: "an answer is required" };
  }

  if (choiceId !== undefined) {
    if (!card.choices.some((choice) => choice.id === choiceId)) {
      return { ok: false, reason: "that option was not offered for this question" };
    }
    return { ok: true, answer: { choiceId } };
  }

  if (!card.allowFreeAnswer) {
    return { ok: false, reason: "this question only accepts one of the offered options" };
  }
  if (freeAnswer.length > ASK_USER_FREE_ANSWER_MAX) {
    return { ok: false, reason: `the answer is longer than ${ASK_USER_FREE_ANSWER_MAX} characters` };
  }
  return { ok: true, answer: { freeAnswer } };
}

export interface AskUserAnswerInput {
  companyId: string;
  sessionId: string;
  questionId: string;
  /** Echoed so the server can refuse an answer to a question that has since changed or expired. */
  revision: number;
  answer: AskUserAnswer;
}

/**
 * The request that answers a paused question. `revision` makes the call optimistic-concurrency safe: a card
 * rendering an older revision must fail loudly rather than answer a question the run has already moved on
 * from, and `questionId` gives the server its idempotency key for a retried submit.
 *
 * NOTE (contract to reconcile): the `code.ask_user` route is implemented by a different stream. This path
 * mirrors the session-control shape the C7 routes use, and the card itself never calls it directly — it hands
 * the answer to a handler the page provides, so an unwired route shows as a disabled control with a reason
 * instead of a button that appears to work. This function is the single place to adjust once the route lands.
 */
export function askUserAnswerRequest(input: AskUserAnswerInput): ApiRequest {
  return {
    method: "POST",
    path: `/companies/${encodeURIComponent(input.companyId)}/code/sessions/${encodeURIComponent(
      input.sessionId
    )}/questions/${encodeURIComponent(input.questionId)}/answer`,
    body: {
      revision: input.revision,
      ...(input.answer.choiceId !== undefined ? { choiceId: input.answer.choiceId } : {}),
      ...(input.answer.freeAnswer !== undefined ? { freeAnswer: input.answer.freeAnswer } : {}),
    },
  };
}
