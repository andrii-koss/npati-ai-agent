/**
 * C7: presentation types for the Code Workspace.
 *
 * These types are deliberately transport-agnostic: the presentational layer renders them and the page
 * layer (a separate stream) fetches them. Keeping them free of fetch/auth concerns is what makes the
 * components testable in a plain Node environment and what keeps the UI from being able to widen an
 * agent's permissions by itself.
 */

/** Session modes exactly as the server names them (C5/C5a); `full_auto` is the legacy alias. */
export type CodeSessionMode = "plan" | "ask" | "auto_edit" | "full_auto_sandbox";

export const CODE_SESSION_MODES: readonly CodeSessionMode[] = ["plan", "ask", "auto_edit", "full_auto_sandbox"];

/** The four answers a human can give to an approval card. */
export type ApprovalScope = "once" | "session" | "project" | "deny";

export const APPROVAL_SCOPES: readonly ApprovalScope[] = ["once", "session", "project", "deny"];

/** What the approver is looking at: a diff, or a command with the directory it runs in. */
export interface ApprovalCardData {
  approvalId: string;
  /** Tool or action the approval is for, e.g. `code.shell.exec:npm:test`. */
  action: string;
  riskLevel?: string;
  command?: string;
  cwd?: string;
  diff?: string;
  /** Paths the diff touches — rendered as text, never interpreted. */
  filePaths?: readonly string[];
  expiresAt?: string;
}

/** A single HTTP request the UI intends to make. Kept as data so it can be asserted in tests. */
export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}

export interface ApprovalDecisionPlan {
  /** Always present: the decision on the pending approval. */
  decide: ApiRequest;
  /**
   * Present for `session`/`project`: the standing rule that makes this approval repeatable inside that
   * scope. `once` and `deny` never create a rule.
   */
  rule?: ApiRequest;
  /** What the UI should tell the user happened. */
  summary: string;
}

export type ToolCallStatus = "ok" | "failed" | "denied" | "pending";

export interface AgentMessageItem {
  kind: "message";
  role: "user" | "assistant" | "system";
  text: string;
  at?: string;
}

export interface AgentToolCallItem {
  kind: "tool_call";
  toolCallId: string;
  tool: string;
  toolVersion?: number;
  /** File the call operated on, if any. Rendered as text. */
  file?: string;
  command?: string;
  cwd?: string;
  result?: string;
  status: ToolCallStatus;
  truncated?: boolean;
  durationMs?: number;
  errorCode?: string;
}

export interface AgentPlanItem {
  kind: "plan";
  title?: string;
  steps: readonly { text: string; done?: boolean }[];
  /**
   * C9: the goal-driven fields of the same Plan/Todo block, all optional so a C1–C8 session that has none
   * of them renders exactly as before. Kept on this item rather than a second item kind on purpose: the
   * owner asked for one Plan/Todo block, and a separate block would let the two disagree about the plan.
   */
  goal?: GoalView | null;
  verification?: VerificationView | null;
  selfReview?: SelfReviewView | null;
}

/**
 * C9: one acceptance criterion of a goal. Status lives per criterion, never as a single "done" flag —
 * the server refuses to complete a goal while any criterion is unverified, so the UI must be able to show
 * *which* one is outstanding rather than just that something is.
 */
export type GoalCriterionStatus = "pending" | "verified" | "failed";

export interface GoalCriterion {
  id: string;
  /** Rendered as text. */
  text: string;
  status: GoalCriterionStatus;
  note?: string;
}

export type CodingGoalStatus = "planned" | "running" | "blocked" | "verifying" | "completed" | "failed";

export type GoalTaskStatus = "pending" | "in_progress" | "completed";

export interface GoalTask {
  taskId: string;
  /** Rendered as text. */
  content: string;
  status: GoalTaskStatus;
  /** Why this task is blocked; rendered as text, never interpreted. */
  blockedReason?: string;
}

export interface GoalView {
  goalId: string;
  /** Rendered as text. */
  objective: string;
  status: CodingGoalStatus;
  criteria: readonly GoalCriterion[];
  /** 0..1, derived by the server from verified criteria — never from "the code was written". */
  progress: number;
  tasks: readonly GoalTask[];
  /**
   * Present only while the run is waiting for a human. Deliberately separate from `status`: a goal that is
   * `blocked` for a technical reason and one that is `blocked` on a question look different to the user
   * because they need different actions.
   */
  blockedReason?: string;
  /** True when the server says the goal is blocked *and* a question is pending. */
  awaitingAnswer?: boolean;
}

export type VerificationStatus =
  | "not_run"
  | "passed"
  | "failed"
  | "unavailable"
  | "passed_with_unjustified_test_changes";

export interface VerificationCheckView {
  /** `lint` / `typecheck` / `test` / `build`, or a project-defined command name. */
  check: string;
  status: "passed" | "failed" | "skipped";
  errorCode?: string;
  /** Rendered as text. */
  message?: string;
}

/** C9: a diff that removed or weakened tests — the answer to "did verify go green by deleting a test?". */
export type TestIntegrityFindingKind =
  | "file_removed"
  | "case_count_reduced"
  | "skip_added"
  | "only_added"
  | "assertion_weakened"
  | "each_block_removed";

export interface TestIntegrityFinding {
  /** Rendered as text. */
  path: string;
  kind: TestIntegrityFindingKind;
  /** Rendered as text. */
  reason: string;
  /** True only when the agent's summary justified the change; false is shown, not hidden. */
  justified?: boolean;
}

export interface VerificationView {
  status: VerificationStatus;
  checks: readonly VerificationCheckView[];
  /** Repair attempts consumed so far. Shown even when verification passed, because 0 attempts is a fact. */
  attemptsUsed: number;
  /** The configured limit (`repairLoopAttempts`); `null` when the server did not report one. */
  maxAttempts: number | null;
  /** Set instead of a status when the server has no report — never rendered as "passed". */
  unavailable?: string;
  testIntegrityFindings?: readonly TestIntegrityFinding[];
}

export type SelfReviewStatus = "not_run" | "clean" | "findings" | "unavailable";

export type SelfReviewSeverity = "info" | "warning" | "error";

export interface SelfReviewFindingView {
  severity: SelfReviewSeverity;
  /** Rendered as text. */
  path?: string;
  /** Rendered as text. */
  reason: string;
  suggestedFix?: string;
}

export interface SelfReviewView {
  status: SelfReviewStatus;
  findings: readonly SelfReviewFindingView[];
  /** How many fix iterations the review used; the limit is one. */
  iterationsUsed?: number;
  unavailable?: string;
}

/** C9: `ask_user` — a structured question that pauses the run until a human answers or it expires. */
export type AskUserStatus = "pending" | "answered" | "expired" | "cancelled";

export interface AskUserChoice {
  id: string;
  /** Rendered as text. */
  label: string;
}

export interface AskUserCardData {
  questionId: string;
  /** Rendered as text. */
  prompt: string;
  choices: readonly AskUserChoice[];
  /** Whether the server accepts a free-form answer in addition to (or instead of) the choices. */
  allowFreeAnswer: boolean;
  status: AskUserStatus;
  /** Optimistic-concurrency revision the answer call must echo back. */
  revision: number;
  answeredBy?: string;
  answeredAt?: string;
  /** The recorded answer; rendered as text. */
  answer?: string;
  expiresAt?: string;
  /** Why it expired or was cancelled; rendered as text. */
  reason?: string;
}

export interface AgentAskUserItem {
  kind: "ask_user";
  card: AskUserCardData;
}

/** One answer a human gives to an `ask_user` card: a choice, or a free-form answer, never both. */
export interface AskUserAnswer {
  choiceId?: string;
  freeAnswer?: string;
}

export interface AgentChangedFilesItem {
  kind: "changed_files";
  files: readonly ChangedFile[];
}

export type AgentStreamItem =
  | AgentMessageItem
  | AgentToolCallItem
  | AgentPlanItem
  | AgentChangedFilesItem
  | AgentAskUserItem;

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  /** Unified diff, rendered inside a `<pre>` as text. */
  diff?: string;
}

/** Which read-only view a blocked workspace shows. `forbidden` and `not_found` must look identical. */
export type AccessDeniedKind = "forbidden" | "not_found";

export interface UsageView {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  /** Set when the server has no accounting for this session yet — never rendered as zero. */
  unavailable?: string;
}
