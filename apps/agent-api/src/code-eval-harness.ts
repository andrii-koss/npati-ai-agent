/**
 * C6 — minimal, deterministic eval harness for the coding agent.
 *
 * Purpose: prove that the loop + real tool path can fix, add, refactor and test small repositories, and do
 * it in CI **without network, without Docker and without a real model**.
 *
 * Design decisions:
 * - Tasks are data (`tests/fixtures/coding-agent-eval/tasks.json`), not code, so adding a task never touches
 *   the harness.
 * - The "model" is a SCRIPTED sequence of steps (tool calls and messages). It is deterministic, which is the
 *   whole point: a failing task means the harness/tool path is broken, not that the model had a bad day.
 * - Tools are executed through an injected `invokeTool` port. Tests wire it to the REAL `CodeToolRuntime`
 *   (with an in-memory sandbox port), so the eval exercises the production tool path, its schema validation,
 *   its flags and its error envelope — not a mock of everything.
 * - Verification is declared per task and is evaluated AFTER the run, so a task cannot pass by merely
 *   claiming success. A task may declare one verification (the C6 shape) or a list of them (C9); a list
 *   holds only when **every** entry holds.
 * - Live model runs are opt-in (`NPATI_CODE_EVAL_LIVE=1`) and REFUSE to run when no live model is injected:
 *   silently reusing recorded answers would make the live number a lie.
 *
 * C9 (owner requirement 5) extension — additive, schema 1 -> 2:
 *
 * The C6 vocabulary (`file_contains`, `command_succeeds`) can only describe *the end state* of a repository.
 * The C9 verification loop, the test-integrity guard and the self-review make claims about **how** a run got
 * there, so the corpus needs three more things and nothing more:
 *
 * 1. A `check` step: one project check *at a point in the transcript* with the exit status it must report.
 *    That is what makes "the check was red, the agent repaired, then it was green" a recorded fact instead of
 *    the transcript's story — a task that claims a repair it never made fails on the red check it skipped.
 * 2. Verification kinds that judge the **change set** rather than one file: `test_integrity` (the real C9
 *    guard), `self_review` (the real C9 review pass over a RECORDED provider answer — the answer is data in
 *    the task, exactly like a C6b replay bundle, so CI needs no provider and no `NPATI_CODE_EVAL_LIVE`), and
 *    `repair_loop` (the run's own recorded check outcomes replayed through the real C9 state machine).
 * 3. `command_fails`: the mirror of `command_succeeds`, for the negative controls — a run that did **not** fix
 *    the cause must not be reported as if it had.
 *
 * None of these builds a second runner. Every new verification is a pure function of the ports the harness
 * already has (`files()`, `runCommand()`) plus the recorded check outcomes, and the loop is never *driven*
 * here: it is only asked what it decided about checks that really happened.
 *
 * C14 (owner decision 1) extension — additive, schema 2 -> 3:
 *
 * The corpus grew from one-language, single-file edits to seven task kinds across four programming languages
 * plus JSON configuration, so the report needs three more numbers and one more verification, and nothing else:
 *
 * 1. `diffStats` (files / added lines / removed lines) — the change set the run really left, counted with the
 *    same line rule `renderChangeDiff` already uses, so the metric and the review text cannot disagree.
 * 2. `turns` — the model turns the transcript represents. A maximal run of consecutive `tool` steps is ONE
 *    turn that issued those calls (the profile's `maxParallelToolCalls` is about exactly that); a `message`
 *    that does not close a tool run is a turn that issued none; a `check` is issued by the loop, never by the
 *    model, so it forms no turn of its own. The same function decides the `turn` the tool port is called
 *    with, so the number in the report is the number the tool path saw.
 * 3. `costUsd` — **computed** from the run's tokens and a price the caller injects from the project's existing
 *    price configuration (`configuredModelPricing`). When no price is known the answer is `null` with a
 *    reason, never a generic default row dressed up as this model's price, and never `0`.
 * 4. The `diff_stats` verification kind: the change set must be exactly what the task declares. It is the
 *    only verification that can fail a task which made the *right* edit while also making a wrong one — which
 *    is what makes the multi-file and migration tasks (where "one file changed" is not the goal) checkable.
 *
 * The same rule as C9 applies: this is not a second runner and not a second corpus. The three numbers are
 * derived from state the harness already holds (`changedFiles`, the executed script prefix, the usage port),
 * and the one new verification reads the same change set the C9 guards read.
 */

import type { CodeIntent } from "@npati/shared";
import {
  SELF_REVIEW_FINDING_CATEGORIES,
  SELF_REVIEW_SEVERITIES,
  createSelfReview,
  type SelfReviewFindingCategory,
  type SelfReviewSeverity,
} from "./code-self-review";
import {
  analyzeTestIntegrity,
  describeTestIntegrity,
  type TestChangeInput,
  type TestIntegrityKind,
} from "./code-test-integrity-guard";
import {
  createVerificationLoop,
  type VerificationCheckState,
  type VerificationDecision,
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

export async function runEvalSuite(
  tasks: readonly EvalTask[],
  deps: EvalHarnessDeps,
  options: { mode?: "recorded" | "live"; env?: Record<string, string | undefined> } = {},
): Promise<EvalReport> {
  const mode = options.mode ?? resolveEvalMode(options.env ?? {});
  if (mode === "live" && !deps.liveModel) {
    // Fail closed: a live run without a live model must not quietly degrade into the recorded answers.
    throw new CodeEvalError("eval_live_model_missing", "Live eval requested but no live model is injected", 503);
  }
  if (!tasks.length) throw new CodeEvalError("eval_no_tasks", "Eval suite has no tasks", 400);

  const now = deps.now ?? (() => Date.now());
  const results: EvalTaskResult[] = [];

  for (const task of tasks) {
    const started = now();
    const maxSteps = task.maxSteps ?? 40;
    let steps = 0;
    let toolCalls = 0;
    let checks = 0;
    let failures = 0;
    let tokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let reason: string | undefined;
    const checkOutcomes: EvalRecordedCheck[] = [];

    const script: EvalStep[] = mode === "live" ? await deps.liveModel!({ task, transcript: task.script }) : task.script;
    // The turn each step belongs to, derived once from the transcript that will actually run (in live mode the
    // model's own transcript), so the number in the report and the number the tool port sees are the same one.
    const turnIndexes = evalTurnIndexes(script);

    for (const step of script) {
      if (steps >= maxSteps) {
        reason = `max_steps_exceeded:${maxSteps}`;
        break;
      }
      steps += 1;
      if (step.kind === "message") continue;
      if (step.kind === "check") {
        // A check is a verification command, not a tool call, so it is counted on its own: folding it into
        // `toolCalls` would make the two metrics mean the same thing and neither of them true.
        checks += 1;
        const outcome = await deps.runCommand(step.command);
        const passed = outcome.exitCode === 0;
        checkOutcomes.push({ tool: step.command, state: passed ? "passed" : "failed" });
        if (step.expect === "pass" && !passed) {
          failures += 1;
          reason = `check_failed:${step.command}:${outcome.exitCode}`;
          break;
        }
        if (step.expect === "fail" && passed) {
          // The transcript claims to have seen a failure that did not happen. That is a defect in the task,
          // not a pass, for the same reason an absent `expectError` failure is.
          failures += 1;
          reason = `check_unexpectedly_passed:${step.command}`;
          break;
        }
        continue;
      }
      toolCalls += 1;
      const result = await deps.invokeTool({
        tool: step.tool,
        args: step.args,
        toolCallId: `${task.id}-${steps}`,
        step: steps,
        turn: turnIndexes[steps - 1] ?? 0,
      });
      if (step.expectError) {
        // Negative steps assert the tool path refuses; a success here is a defect, not a pass.
        if (result.ok) {
          failures += 1;
          reason = `expected_error_missing:${step.tool}`;
          break;
        }
        if (result.error?.code !== step.expectError) {
          failures += 1;
          reason = `unexpected_error_code:${result.error?.code ?? "none"}!=${step.expectError}`;
          break;
        }
      } else if (!result.ok) {
        failures += 1;
        reason = `tool_failed:${step.tool}:${result.error?.code ?? "unknown"}`;
        break;
      }
      const usage = deps.usage?.();
      tokens += usage?.tokens ?? 0;
      promptTokens += usage?.promptTokens ?? 0;
      completionTokens += usage?.completionTokens ?? 0;
    }

    if (!reason) {
      const verified = await verifyTask(task, deps, checkOutcomes);
      if (!verified.ok) reason = verified.reason;
    }

    // Both of these read state the harness already holds: the final workspace (through `files()`) and the
    // executed prefix of the transcript. Neither is a second measurement of something else.
    const diffStats = diffStatsFor(changedFiles(task.files, deps.files()));
    const cost = computeEvalCost({ tokens, promptTokens, completionTokens }, deps.price?.() ?? null);

    results.push({
      id: task.id,
      ok: !reason,
      steps,
      toolCalls,
      checks,
      turns: countEvalTurns(script.slice(0, steps)),
      failures,
      tokens,
      durationMs: Math.max(0, now() - started),
      diffStats,
      costUsd: cost.costUsd,
      ...(cost.unavailable ? { costUnavailable: cost.unavailable } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  const passed = results.filter((result) => result.ok).length;
  const priced = results.filter((result) => result.costUsd !== null);
  return {
    schemaVersion: CODE_EVAL_SCHEMA_VERSION,
    mode,
    tasks: results,
    totals: {
      tasks: results.length,
      passed,
      failed: results.length - passed,
      steps: results.reduce((sum, result) => sum + result.steps, 0),
      turns: results.reduce((sum, result) => sum + result.turns, 0),
      checks: results.reduce((sum, result) => sum + result.checks, 0),
      tokens: results.reduce((sum, result) => sum + result.tokens, 0),
      durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
      diffStats: {
        files: results.reduce((sum, result) => sum + result.diffStats.files, 0),
        linesAdded: results.reduce((sum, result) => sum + result.diffStats.linesAdded, 0),
        linesRemoved: results.reduce((sum, result) => sum + result.diffStats.linesRemoved, 0),
      },
      // A sum over the priced tasks only, and `null` when there are none: reporting `0` for a suite nobody
      // could price would be the same lie as inventing a price.
      costUsd: priced.length ? Number(priced.reduce((sum, result) => sum + (result.costUsd ?? 0), 0).toFixed(6)) : null,
      costUnavailableTasks: results.length - priced.length,
    },
  };
}

/** A task holds only when every verification it declares holds; the first failure names itself. */
async function verifyTask(
  task: EvalTask,
  deps: EvalHarnessDeps,
  checkOutcomes: readonly EvalRecordedCheck[],
): Promise<{ ok: boolean; reason?: string }> {
  const verifications = Array.isArray(task.verify) ? task.verify : [task.verify];
  for (const verification of verifications) {
    const result = await runVerification(verification, task, deps, checkOutcomes);
    if (!result.ok) return result;
  }
  return { ok: true };
}

async function runVerification(
  verification: EvalVerification,
  task: EvalTask,
  deps: EvalHarnessDeps,
  checkOutcomes: readonly EvalRecordedCheck[],
): Promise<{ ok: boolean; reason?: string }> {
  switch (verification.type) {
    case "file_contains": {
      const content = deps.files()[verification.path];
      if (content === undefined) return { ok: false, reason: `verify_missing_file:${verification.path}` };
      if (!content.includes(verification.contains)) return { ok: false, reason: `verify_content_mismatch:${verification.path}` };
      return { ok: true };
    }
    case "command_succeeds": {
      const result = await deps.runCommand(verification.command);
      if (result.exitCode !== 0) return { ok: false, reason: `verify_command_failed:${verification.command}:${result.exitCode}` };
      return { ok: true };
    }
    case "command_fails": {
      const result = await deps.runCommand(verification.command);
      if (result.exitCode === 0) return { ok: false, reason: `verify_command_unexpectedly_passed:${verification.command}` };
      return { ok: true };
    }
    case "diff_stats": {
      const stats = diffStatsFor(changedFiles(task.files, deps.files()));
      if (stats.files !== verification.expect.files) {
        return { ok: false, reason: `verify_diff_stats_files:${stats.files}!=${verification.expect.files}` };
      }
      if (verification.expect.linesAdded !== undefined && stats.linesAdded !== verification.expect.linesAdded) {
        return { ok: false, reason: `verify_diff_stats_lines_added:${stats.linesAdded}!=${verification.expect.linesAdded}` };
      }
      if (verification.expect.linesRemoved !== undefined && stats.linesRemoved !== verification.expect.linesRemoved) {
        return { ok: false, reason: `verify_diff_stats_lines_removed:${stats.linesRemoved}!=${verification.expect.linesRemoved}` };
      }
      return { ok: true };
    }
    case "test_integrity": {
      const verdict = analyzeTestIntegrity(changedFiles(task.files, deps.files()));
      if (verification.expect === "flagged" && !verdict.flagged) {
        // The task says the change weakened the suite and the real guard does not agree: the task is wrong,
        // which is exactly the direction that must not be silently tolerated.
        return { ok: false, reason: "verify_test_integrity_not_flagged" };
      }
      if (verification.expect === "clean" && verdict.flagged) {
        const kinds = [...new Set(verdict.findings.map((finding) => finding.kind))].join(",");
        return { ok: false, reason: `verify_test_integrity_flagged:${kinds}` };
      }
      for (const kind of verification.kinds ?? []) {
        if (!verdict.findings.some((finding) => finding.kind === kind)) {
          return { ok: false, reason: `verify_test_integrity_kind_missing:${kind}` };
        }
      }
      return { ok: true };
    }
    case "self_review": {
      const changes = changedFiles(task.files, deps.files());
      if (!changes.length) return { ok: false, reason: "verify_self_review_no_change" };
      const changedPaths = changes.map((change) => change.path);
      for (const expected of verification.expect) {
        // A recorded answer may only be asserted about a file the run really changed. Without this, a task
        // could "prove" the review found something by asserting a finding about a file nobody touched.
        if (expected.file && !changedPaths.includes(expected.file)) {
          return { ok: false, reason: `verify_self_review_file_not_changed:${expected.file}` };
        }
      }
      const finalDiff = renderChangeDiff(changes);
      const state = createSelfReview({
        input: {
          originalGoal: task.goal ?? task.title,
          // The corpus runs have no plan; the review is told so rather than shown an invented one.
          approvedPlan: null,
          finalDiff,
          changedFiles: changes.map((change) => ({ path: change.path, tool: "code.fs.write", status: change.status })),
          verification: describeRecordedChecks(checkOutcomes),
          testIntegrity: describeTestIntegrity(analyzeTestIntegrity(changes)),
        },
      });
      const request = state.request();
      // The provider answer is RECORDED in the task: the real review state machine runs, the model does not.
      const verdict = await state.execute({
        reviewRequest: request,
        chat: async () => ({ ok: true as const, content: verification.answer }),
      });
      if (!verdict.ran) return { ok: false, reason: `verify_self_review_not_run:${verdict.reason ?? "unknown"}` };
      for (const expected of verification.expect) {
        const matched = verdict.findings.some((finding) =>
          finding.category === expected.category
          && (expected.severity === undefined || finding.severity === expected.severity)
          && (expected.file === undefined || finding.file === expected.file));
        if (!matched) {
          return { ok: false, reason: `verify_self_review_finding_missing:${expected.category}@${expected.file ?? "any"}` };
        }
        // The review must have been shown the file it reported on, or the finding came from nowhere.
        if (expected.file && !request.promptText.includes(expected.file)) {
          return { ok: false, reason: `verify_self_review_file_not_in_prompt:${expected.file}` };
        }
      }
      return { ok: true };
    }
    case "repair_loop": {
      if (!checkOutcomes.length) {
        // Nothing to replay: a budget task with no recorded check would otherwise "prove" that zero repairs
        // exhaust nothing.
        return { ok: false, reason: "verify_repair_loop_no_checks" };
      }
      const loop = createVerificationLoop({
        maxRepairAttempts: verification.maxAttempts,
        requestedTools: [...new Set(checkOutcomes.map((check) => check.tool))],
      });
      let repairs = 0;
      let stopCode: string | undefined;
      for (const check of checkOutcomes) {
        loop.record([{ tool: check.tool, state: check.state }]);
        const decision: VerificationDecision = loop.decide();
        if (decision.decision === "repair") {
          repairs += 1;
          continue;
        }
        // `complete` and `stop` both end the run's loop; a later failure cannot reopen it by itself.
        if (decision.decision === "stop") stopCode = decision.code;
        break;
      }
      if (repairs !== verification.expect.repairs) {
        return { ok: false, reason: `verify_repair_loop_repairs:${repairs}!=${verification.expect.repairs}` };
      }
      if (verification.expect.stopCode !== undefined && stopCode !== verification.expect.stopCode) {
        return { ok: false, reason: `verify_repair_loop_stop_code:${stopCode ?? "none"}!=${verification.expect.stopCode}` };
      }
      return { ok: true };
    }
  }
}

/**
 * The change set between the task's initial files and the workspace's final state, in the shape the C9
 * guards take. Content is passed (not a scraped diff) because the guards are strictly more reliable that way.
 */
export function changedFiles(before: Record<string, string>, after: Record<string, string>): TestChangeInput[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: TestChangeInput[] = [];
  for (const path of paths) {
    const from = before[path];
    const to = after[path];
    if (from === to) continue;
    changes.push({
      path,
      status: from === undefined ? "added" : to === undefined ? "deleted" : "modified",
      before: from ?? "",
      after: to ?? "",
    });
  }
  return changes;
}

/**
 * C14: the lines one change added and removed, by the single rule this module uses for both the review text
 * and the `diffStats` metric.
 *
 * It is deliberately a **set** difference over non-empty lines, not a longest-common-subsequence diff: a line
 * moved inside a file counts as neither added nor removed, and blank lines are not counted at all. That is
 * weaker than `git diff --numstat` and is stated as such — the metric exists to catch a run that changed the
 * wrong set of files, not to reproduce a diff algorithm.
 */
function changeLines(change: TestChangeInput): { removed: string[]; added: string[] } {
  const before = (change.before ?? "").split("\n").filter(Boolean);
  const after = (change.after ?? "").split("\n").filter(Boolean);
  return {
    removed: before.filter((line) => !after.includes(line)),
    added: after.filter((line) => !before.includes(line)),
  };
}

/** C14: the change set as the three numbers a reader compares (`files`, added lines, removed lines). */
export function diffStatsFor(changes: readonly TestChangeInput[]): EvalDiffStats {
  const stats: EvalDiffStats = { files: changes.length, linesAdded: 0, linesRemoved: 0 };
  for (const change of changes) {
    const lines = changeLines(change);
    stats.linesAdded += lines.added.length;
    stats.linesRemoved += lines.removed.length;
  }
  return stats;
}

/** A bounded, line-oriented rendering of the change set, used only as review input text. */
export function renderChangeDiff(changes: readonly TestChangeInput[], limit = 20_000): string {
  const blocks = changes.map((change) => {
    const lines = changeLines(change);
    return [
      `--- a/${change.path}`,
      `+++ b/${change.path}`,
      ...lines.removed.map((line) => `-${line}`),
      ...lines.added.map((line) => `+${line}`),
    ].join("\n");
  });
  const text = blocks.join("\n");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The verification line the self-review is shown: what the run's own checks reported, nothing more. */
function describeRecordedChecks(checks: readonly EvalRecordedCheck[]): string {
  if (!checks.length) return "(verification did not run)";
  return checks.map((check) => `${check.tool}: ${check.state}`).join("; ");
}

const VERIFICATION_TYPES = new Set([
  "file_contains",
  "command_succeeds",
  "command_fails",
  "diff_stats",
  "test_integrity",
  "self_review",
  "repair_loop",
]);

function invalid(message: string, details?: Record<string, unknown>): CodeEvalError {
  return new CodeEvalError("eval_fixture_invalid", message, 400, details);
}

const CATEGORY_SET = new Set<string>(SELF_REVIEW_FINDING_CATEGORIES);
const SEVERITY_SET = new Set<string>(SELF_REVIEW_SEVERITIES);
/** The C14 coverage vocabularies, as sets, so a fixture typo is refused instead of counted as coverage. */
const TASK_KIND_SET = new Set<string>(EVAL_TASK_KINDS);
const LANGUAGE_SET = new Set<string>(EVAL_LANGUAGES);

/**
 * Rejects a malformed verification instead of skipping it. Every C9 kind is checked here as well, so a typo in
 * a fixture fails the suite loudly rather than producing a task that quietly verifies nothing.
 */
function validateVerification(value: unknown, where: string): void {
  if (!value || typeof value !== "object") throw invalid(`${where}: verification must be an object`);
  const raw = value as Record<string, unknown>;
  const type = typeof raw.type === "string" ? raw.type : "";
  if (!VERIFICATION_TYPES.has(type)) throw invalid(`${where}: unknown verification type '${String(raw.type)}'`);
  switch (type) {
    case "file_contains":
      if (typeof raw.path !== "string" || !raw.path || typeof raw.contains !== "string") {
        throw invalid(`${where}: file_contains needs a path and a contains string`);
      }
      return;
    case "command_succeeds":
    case "command_fails":
      if (typeof raw.command !== "string" || !raw.command) throw invalid(`${where}: ${type} needs a command`);
      return;
    case "diff_stats": {
      const expected = raw.expect;
      if (!expected || typeof expected !== "object") throw invalid(`${where}: diff_stats needs an expect object`);
      const numbers = expected as Record<string, unknown>;
      // `files` is required even when it is zero, so "the change set is exactly this" can never be satisfied
      // by leaving the field out — the shape a task would use to make a wrong change set pass.
      if (typeof numbers.files !== "number" || !Number.isInteger(numbers.files) || numbers.files < 0) {
        throw invalid(`${where}: diff_stats needs a non-negative integer files count`);
      }
      for (const key of ["linesAdded", "linesRemoved"]) {
        const value = numbers[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
          throw invalid(`${where}: diff_stats ${key} must be a non-negative integer when present`);
        }
      }
      return;
    }
    case "test_integrity":
      if (raw.expect !== "flagged" && raw.expect !== "clean") throw invalid(`${where}: test_integrity expect must be flagged or clean`);
      if (raw.kinds !== undefined && (!Array.isArray(raw.kinds) || raw.kinds.some((kind) => typeof kind !== "string"))) {
        throw invalid(`${where}: test_integrity kinds must be an array of finding kinds`);
      }
      return;
    case "self_review": {
      if (typeof raw.answer !== "string" || !raw.answer) throw invalid(`${where}: self_review needs a recorded answer`);
      if (!Array.isArray(raw.expect) || !raw.expect.length) throw invalid(`${where}: self_review needs at least one expected finding`);
      for (const entry of raw.expect) {
        if (!entry || typeof entry !== "object") throw invalid(`${where}: self_review expectations must be objects`);
        const expected = entry as Record<string, unknown>;
        if (typeof expected.category !== "string" || !CATEGORY_SET.has(expected.category)) {
          throw invalid(`${where}: unknown self_review finding category '${String(expected.category)}'`);
        }
        if (expected.severity !== undefined && (typeof expected.severity !== "string" || !SEVERITY_SET.has(expected.severity))) {
          throw invalid(`${where}: unknown self_review severity '${String(expected.severity)}'`);
        }
        if (expected.file !== undefined && expected.file !== null && typeof expected.file !== "string") {
          throw invalid(`${where}: self_review expectation file must be a path or null`);
        }
      }
      return;
    }
    case "repair_loop": {
      const expected = (raw.expect ?? {}) as Record<string, unknown>;
      if (typeof raw.maxAttempts !== "number" || !Number.isInteger(raw.maxAttempts) || raw.maxAttempts < 0) {
        throw invalid(`${where}: repair_loop needs a non-negative integer maxAttempts`);
      }
      if (typeof expected.repairs !== "number" || !Number.isInteger(expected.repairs) || expected.repairs < 0) {
        throw invalid(`${where}: repair_loop needs an expected repair count`);
      }
      if (expected.stopCode !== undefined && typeof expected.stopCode !== "string") {
        throw invalid(`${where}: repair_loop stopCode must be a string when present`);
      }
      return;
    }
  }
}

function validateStep(value: unknown, where: string): void {
  if (!value || typeof value !== "object") throw invalid(`${where}: step must be an object`);
  const step = value as Record<string, unknown>;
  if (step.kind === "message") {
    if (typeof step.text !== "string") throw invalid(`${where}: a message step needs text`);
    return;
  }
  if (step.kind === "tool") {
    if (typeof step.tool !== "string" || !step.tool) throw invalid(`${where}: a tool step needs a tool name`);
    return;
  }
  if (step.kind === "check") {
    if (typeof step.command !== "string" || !step.command) throw invalid(`${where}: a check step needs a command`);
    if (step.expect !== "pass" && step.expect !== "fail") throw invalid(`${where}: a check step needs expect pass or fail`);
    return;
  }
  throw invalid(`${where}: unknown step kind '${String(step.kind)}'`);
}

/**
 * Loads an already parsed fixture set and rejects malformed tasks instead of skipping them silently.
 * A schema-1 task stays valid here by construction: every C9 kind is optional and additive.
 */
export function loadEvalTasks(raw: unknown): EvalTask[] {
  if (!Array.isArray(raw)) throw new CodeEvalError("eval_fixture_invalid", "Eval fixture must be an array of tasks", 400);
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new CodeEvalError("eval_fixture_invalid", `Task #${index} is not an object`, 400);
    const task = entry as Partial<EvalTask>;
    if (!task.id || !task.title || !task.intent || !task.files || !Array.isArray(task.script) || !task.verify) {
      throw new CodeEvalError("eval_fixture_invalid", `Task #${index} is missing required fields`, 400, { id: task.id });
    }
    const where = `Task ${task.id}`;
    task.script.forEach((step, stepIndex) => validateStep(step, `${where} step #${stepIndex}`));
    const verifications = Array.isArray(task.verify) ? task.verify : [task.verify];
    if (!verifications.length) throw invalid(`${where} declares no verification`);
    verifications.forEach((verification, verificationIndex) => validateVerification(verification, `${where} verification #${verificationIndex}`));
    if (task.goal !== undefined && typeof task.goal !== "string") throw invalid(`${where}: goal must be a string when present`);
    // C14: both are optional (a schema-1/2 task stays valid verbatim) but a *present* value must be from the
    // closed vocabulary — a typo would otherwise be counted as coverage for a kind nothing covers.
    if (task.taskType !== undefined && !TASK_KIND_SET.has(task.taskType)) {
      throw invalid(`${where}: unknown taskType '${String(task.taskType)}'`);
    }
    if (task.language !== undefined && !LANGUAGE_SET.has(task.language)) {
      throw invalid(`${where}: unknown language '${String(task.language)}'`);
    }
    if (task.maxSteps !== undefined && (typeof task.maxSteps !== "number" || !Number.isInteger(task.maxSteps) || task.maxSteps < 1)) {
      throw invalid(`${where}: maxSteps must be a positive integer when present`);
    }
    return task as EvalTask;
  });
}

export interface EvalFixture {
  schemaVersion: number;
  description?: string;
  tasks: EvalTask[];
}

/**
 * Loads a whole fixture, including its version. A fixture written for a NEWER schema is refused instead of
 * being read with the fields this build happens to understand — the failure mode that silently drops a
 * verification is worse than a load error. An older fixture keeps working, which is the point of versioning
 * the format additively.
 */
export function loadEvalFixture(raw: unknown): EvalFixture {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CodeEvalError("eval_fixture_invalid", "Eval fixture must be an object with a schemaVersion and tasks", 400);
  }
  const fixture = raw as { schemaVersion?: unknown; description?: unknown; tasks?: unknown };
  const version = fixture.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new CodeEvalError("eval_fixture_invalid", "Eval fixture must declare an integer schemaVersion", 400);
  }
  if (version < EVAL_FIXTURE_MIN_SCHEMA_VERSION || version > CODE_EVAL_SCHEMA_VERSION) {
    throw new CodeEvalError("eval_fixture_version_unsupported", `Eval fixture schemaVersion ${version} is not supported`, 400, {
      supported: [EVAL_FIXTURE_MIN_SCHEMA_VERSION, CODE_EVAL_SCHEMA_VERSION],
    });
  }
  return {
    schemaVersion: version,
    ...(typeof fixture.description === "string" ? { description: fixture.description } : {}),
    tasks: loadEvalTasks(fixture.tasks),
  };
}

/** CI gate: a report is green only when every task passed and the suite was not empty. */
export function evalReportIsGreen(report: EvalReport): boolean {
  return report.totals.tasks > 0 && report.totals.failed === 0;
}
