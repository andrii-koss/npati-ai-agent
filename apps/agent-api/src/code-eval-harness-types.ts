import type { CodeIntent } from "@npati/shared";
import type {
  SelfReviewFindingCategory,
  SelfReviewSeverity,
} from "./code-self-review";
import type {
  TestIntegrityKind,
} from "./code-test-integrity-guard";
import type {
  VerificationCheckState,
} from "./code-verification-loop";

/**
 * The persisted vocabulary of a report and of a fixture. Raised from 1 to 2 when the C9 `check` step and the
 * change-set verifications were added, and from 2 to 3 when C14 added `diff_stats` plus the `turns`/
 * `diffStats`/`costUsd` scores (rule 13: a persisted format is versioned). Both changes are **additive**: a
 * schema-1 task — `file_contains`/`command_succeeds` over tool and message steps — is a valid schema-3 task,
 * which is why the eight original C6 tasks did not have to move.
 */
export const CODE_EVAL_SCHEMA_VERSION = 3;
/** The oldest fixture this build still reads. A newer fixture is refused rather than guessed at. */
export const EVAL_FIXTURE_MIN_SCHEMA_VERSION = 1;

/**
 * C14: the closed vocabulary of corpus task kinds, exported as data so a report or a UI does not re-type it.
 *
 * A corpus that only ever fixed single-file JavaScript bugs could be green while the loop cannot do the work
 * the product sells, so the coverage is measured against exactly these seven kinds — and a task naming a kind
 * outside this list is refused at load time instead of being counted as "covered".
 */
export const EVAL_TASK_KINDS = [
  "bug_fix",
  "feature",
  "refactor",
  "tests",
  "multi_file",
  "build_repair",
  "dependency_migration",
] as const;
export type EvalTaskKind = (typeof EVAL_TASK_KINDS)[number];

/**
 * C14: the languages the corpus ships **source fixtures** in. `json` is a configuration format, not a
 * programming language, and is named here anyway because the build-repair tasks really do change JSON.
 *
 * What this list does NOT mean: that the corpus understands these languages. The fixture's test runner is a
 * regex simulator restricted to the JS/TS expression shape (see `tests/coding-agent-c6-eval.test.ts`), so a
 * Python or Go task carries no command at all and is verified by `file_contains`/`diff_stats` over the change
 * set. Naming a language here is a statement about the fixture text, never about execution.
 */
export const EVAL_LANGUAGES = ["javascript", "typescript", "python", "go", "json"] as const;
export type EvalLanguage = (typeof EVAL_LANGUAGES)[number];

/** C14: USD per 1M tokens, in the shape the project's own pricing table already uses (`cost-telemetry`). */
export interface EvalTokenPrice {
  promptPerM: number;
  completionPerM: number;
}

/** C14: the run's change set, in the shape the C7 usage view already reports (`diffStats`). */
export interface EvalDiffStats {
  files: number;
  linesAdded: number;
  linesRemoved: number;
}

/** C14: tokens per run, split the way pricing needs them. `tokens` stays the total the report always had. */
export interface EvalTokenTotals {
  tokens: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * C14: why a run has no cost. Two values, because the two situations need different operator action:
 *
 *  - `no_price_for_model` — the price table has no entry for the model. There is nothing to compute, and a
 *    generic fallback row would be a budget guess reported as this model's price;
 *  - `token_split_unavailable` — a price exists, but the caller reported only a total, and pricing a total at
 *    the prompt rate understates while the completion rate overstates. `0` is not an acceptable answer here
 *    either: it reads as "this run was free".
 */
export const EVAL_COST_UNAVAILABLE_REASONS = ["no_price_for_model", "token_split_unavailable"] as const;
export type EvalCostUnavailableReason = (typeof EVAL_COST_UNAVAILABLE_REASONS)[number];

/**
 * C14: the cost of a run, from the tokens it reported and the price of its model — or an honest refusal.
 *
 * The arithmetic matches `CostTelemetry.calculate` (per-1M rates, rounded to 6 decimals) so the eval number
 * and the production telemetry number are the same number; the price itself is injected rather than looked up
 * here, because a price table is configuration and this module has no business owning one.
 */
export function computeEvalCost(
  totals: EvalTokenTotals,
  price: EvalTokenPrice | null | undefined,
): { costUsd: number | null; unavailable?: EvalCostUnavailableReason } {
  const usable = price
    && Number.isFinite(price.promptPerM) && price.promptPerM >= 0
    && Number.isFinite(price.completionPerM) && price.completionPerM >= 0;
  if (!usable) return { costUsd: null, unavailable: "no_price_for_model" };
  if (totals.promptTokens + totals.completionTokens !== totals.tokens) {
    return { costUsd: null, unavailable: "token_split_unavailable" };
  }
  const promptCost = (totals.promptTokens / 1_000_000) * price.promptPerM;
  const completionCost = (totals.completionTokens / 1_000_000) * price.completionPerM;
  return { costUsd: Number((promptCost + completionCost).toFixed(6)) };
}

export type EvalStep =
  | { kind: "tool"; tool: string; args?: unknown; expectError?: string }
  | { kind: "message"; text: string }
  /**
   * C9: one project check at this point of the transcript, with the exit status it must report.
   * `expect: "fail"` asserts the check is RED here, so a repair task records the failure it repaired; a green
   * check where the task demanded red is a defect (the run never saw the failure it claims to have fixed).
   */
  | { kind: "check"; command: string; expect: "pass" | "fail" };

/** One finding a recorded self-review answer must produce, matched against the real parsed verdict. */
export interface EvalSelfReviewExpectation {
  category: SelfReviewFindingCategory;
  severity?: SelfReviewSeverity;
  /** `null`/absent means "any file"; a path must be one the run actually changed. */
  file?: string | null;
}

export type EvalVerification =
  /** A file holds a value in the final state. */
  | { type: "file_contains"; path: string; contains: string }
  /** A command exits 0 in the final state. */
  | { type: "command_succeeds"; command: string }
  /** The mirror of `command_succeeds`: the command must still fail (a run may not report a fix it did not make). */
  | { type: "command_fails"; command: string }
  /**
   * C14: the run's change set (files / added lines / removed lines) is exactly what the task declares.
   * Counted with the same line rule as `renderChangeDiff`, so a task cannot declare a change set the review
   * text the reviewer was shown would contradict. `files` is required: "nothing changed" must not be able to
   * satisfy a change-set claim by omission.
   */
  | { type: "diff_stats"; expect: { files: number; linesAdded?: number; linesRemoved?: number } }
  /** The real C9 test-integrity guard's verdict over the run's change set. */
  | { type: "test_integrity"; expect: "flagged" | "clean"; kinds?: readonly TestIntegrityKind[] }
  /** The real C9 self-review pass over the run's change set and a recorded provider answer. */
  | { type: "self_review"; answer: string; expect: readonly EvalSelfReviewExpectation[] }
  /** The run's recorded checks replayed through the real C9 verification loop. */
  | { type: "repair_loop"; maxAttempts: number; expect: { repairs: number; stopCode?: string } };

export interface EvalTask {
  id: string;
  title: string;
  intent: CodeIntent;
  /**
   * C14: which of the seven corpus kinds this task covers, and which language its source fixture is written
   * in. Both are optional so every schema-1/2 task stays valid verbatim; the corpus suite asserts that every
   * task in the shipped fixture declares them, so the coverage claim is countable instead of asserted in prose.
   */
  taskType?: EvalTaskKind;
  language?: EvalLanguage;
  /** The request the run was given, when it is not the same as `title`. The self-review reads it as the goal. */
  goal?: string;
  /** Initial repository state; the runner may only change these files through tools. */
  files: Record<string, string>;
  script: EvalStep[];
  /** One verification (C6) or a list of them (C9); a list holds only when every entry holds. */
  verify: EvalVerification | readonly EvalVerification[];
  /** Upper bound so a looping agent fails the task instead of hanging CI. */
  maxSteps?: number;
}

export interface EvalTaskResult {
  id: string;
  ok: boolean;
  steps: number;
  toolCalls: number;
  /** C9: how many `check` steps ran inside the transcript (counted apart from tool calls, not added to them). */
  checks: number;
  /** C14: the model turns the executed transcript prefix represents (see `evalTurnIndexes`). */
  turns: number;
  failures: number;
  tokens: number;
  durationMs: number;
  /** C14: the change set the run left, counted from the task's initial files and the final workspace. */
  diffStats: EvalDiffStats;
  /** C14: computed from the run's tokens and the injected price. `null` means "not computable", never "free". */
  costUsd: number | null;
  /** Present exactly when `costUsd` is `null`, and names which of the two situations it is. */
  costUnavailable?: EvalCostUnavailableReason;
  reason?: string;
}

export interface EvalReport {
  schemaVersion: number;
  mode: "recorded" | "live";
  tasks: EvalTaskResult[];
  totals: {
    tasks: number;
    passed: number;
    failed: number;
    steps: number;
    turns: number;
    checks: number;
    tokens: number;
    durationMs: number;
    diffStats: EvalDiffStats;
    /**
     * The sum of the tasks whose cost could be computed. `null` when **no** task could be priced (a `0` here
     * would read as "the whole suite was free"), and `costUnavailableTasks` always states how many of the
     * totals are missing, so a partial sum can never be mistaken for the whole.
     */
    costUsd: number | null;
    costUnavailableTasks: number;
  };
}

/** One `check` step's outcome, kept for the `repair_loop` verification. */
export interface EvalRecordedCheck {
  tool: string;
  state: Exclude<VerificationCheckState, "approval_required" | "unavailable">;
}

export interface EvalHarnessDeps {
  /**
   * Executes one tool call through the real runtime. Errors are returned, never thrown, matching the runtime.
   * `turn` is the transcript's own turn number for this step, so a runtime that scopes anything to a turn
   * (read-before-write tracking, checkpointing) sees the real boundaries instead of one flat turn.
   */
  invokeTool(input: { tool: string; args?: unknown; toolCallId: string; step: number; turn: number }): Promise<{ ok: boolean; error?: { code?: string } }>;
  /** Runs a project check in the workspace (in CI this simulates the project's test runner). */
  runCommand(command: string): Promise<{ exitCode: number; output?: string }>;
  /** Current repository state, used by file-based and change-set verification. */
  files(): Record<string, string>;
  /**
   * Token usage of the last model interaction, when the caller can provide it. The split is optional: without
   * it a price cannot be applied (see `computeEvalCost`), which is reported rather than rounded.
   */
  usage?(): { tokens: number; promptTokens?: number; completionTokens?: number };
  /**
   * C14: the price of the model this suite is driven with, from the project's existing price configuration
   * (`configuredModelPricing`). Absent — or `null` — means no price is known for it, and the report says so.
   */
  price?(): EvalTokenPrice | null;
  /** Only used in live mode. */
  liveModel?: (input: { task: EvalTask; transcript: EvalStep[] }) => Promise<EvalStep[]>;
  now?(): number;
}

export class CodeEvalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeEvalError";
  }
}

/** Live eval is opt-in; anything other than the exact "1" keeps the deterministic recorded mode. */
export function resolveEvalMode(env: Record<string, string | undefined>): "recorded" | "live" {
  return env.NPATI_CODE_EVAL_LIVE === "1" ? "live" : "recorded";
}

/**
 * C14: which model turn each step of a transcript belongs to; `0` marks a step that is not a turn.
 *
 * The transcript records what the model emitted and what the loop ran, but not where one model turn ended —
 * so the turn structure is **derived** by a stated rule rather than guessed per task:
 *
 *  - a maximal run of consecutive `tool` steps is ONE turn: that is the turn which issued those calls (in
 *    parallel, up to the profile's `maxParallelToolCalls`), and running them is the loop's job;
 *  - a `message` step that closes a tool run belongs to that run (a real turn ends with text and calls
 *    together), while a message that does not is a turn which issued no tool call;
 *  - a `check` step is issued by the verification loop, not by the model, so it is never a turn — but it does
 *    end the turn before it, because the model is shown the check's result and answers in a new turn.
 *
 * The number is a **lower bound on model calls**: a transcript cannot express two model turns whose calls
 * happen to be adjacent. That is the honest direction for a metric — it never claims more turns than the
 * recording proves.
 */
export function evalTurnIndexes(script: readonly EvalStep[]): number[] {
  const indexes: number[] = [];
  let turn = 0;
  let previousWasTool = false;
  for (const step of script) {
    if (step.kind === "check") {
      indexes.push(0);
      previousWasTool = false;
      continue;
    }
    if (step.kind === "tool" && previousWasTool) {
      // The next call of the same turn: running the calls is the loop's job, not a new model turn.
      indexes.push(turn);
      continue;
    }
    if (step.kind === "message" && previousWasTool) {
      // The text that closes a tool run: the same turn, not a new one.
      indexes.push(turn);
      previousWasTool = false;
      continue;
    }
    turn += 1;
    indexes.push(turn);
    previousWasTool = step.kind === "tool";
  }
  return indexes;
}

/** C14: the number of model turns in a transcript prefix — the last turn index it reached, or zero. */
export function countEvalTurns(script: readonly EvalStep[]): number {
  const indexes = evalTurnIndexes(script);
  return indexes.length ? indexes[indexes.length - 1]! : 0;
}

export interface EvalFixture {
  schemaVersion: number;
  description?: string;
  tasks: EvalTask[];
}

/** CI gate: a report is green only when every task passed and the suite was not empty. */
export function evalReportIsGreen(report: EvalReport): boolean {
  return report.totals.tasks > 0 && report.totals.failed === 0;
}
