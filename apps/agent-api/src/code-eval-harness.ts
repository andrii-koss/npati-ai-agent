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
 * change-set verifications were added (rule 13: a persisted format is versioned). The change is **additive**:
 * a schema-1 task — `file_contains`/`command_succeeds` over tool and message steps — is a valid schema-2 task,
 * which is why the eight original C6 tasks did not have to move.
 */
export const CODE_EVAL_SCHEMA_VERSION = 2;
/** The oldest fixture this build still reads. A newer fixture is refused rather than guessed at. */
export const EVAL_FIXTURE_MIN_SCHEMA_VERSION = 1;

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
  failures: number;
  tokens: number;
  durationMs: number;
  reason?: string;
}

export interface EvalReport {
  schemaVersion: number;
  mode: "recorded" | "live";
  tasks: EvalTaskResult[];
  totals: { tasks: number; passed: number; failed: number; steps: number; checks: number; tokens: number; durationMs: number };
}

/** One `check` step's outcome, kept for the `repair_loop` verification. */
export interface EvalRecordedCheck {
  tool: string;
  state: Exclude<VerificationCheckState, "approval_required" | "unavailable">;
}

export interface EvalHarnessDeps {
  /** Executes one tool call through the real runtime. Errors are returned, never thrown, matching the runtime. */
  invokeTool(input: { tool: string; args?: unknown; toolCallId: string; step: number }): Promise<{ ok: boolean; error?: { code?: string } }>;
  /** Runs a project check in the workspace (in CI this simulates the project's test runner). */
  runCommand(command: string): Promise<{ exitCode: number; output?: string }>;
  /** Current repository state, used by file-based and change-set verification. */
  files(): Record<string, string>;
  /** Token usage of the last model interaction, when the caller can provide it. */
  usage?(): { tokens: number };
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
    let reason: string | undefined;
    const checkOutcomes: EvalRecordedCheck[] = [];

    const script: EvalStep[] = mode === "live" ? await deps.liveModel!({ task, transcript: task.script }) : task.script;

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
      const result = await deps.invokeTool({ tool: step.tool, args: step.args, toolCallId: `${task.id}-${steps}`, step: steps });
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
      tokens += deps.usage?.().tokens ?? 0;
    }

    if (!reason) {
      const verified = await verifyTask(task, deps, checkOutcomes);
      if (!verified.ok) reason = verified.reason;
    }

    results.push({
      id: task.id,
      ok: !reason,
      steps,
      toolCalls,
      checks,
      failures,
      tokens,
      durationMs: Math.max(0, now() - started),
      ...(reason ? { reason } : {}),
    });
  }

  const passed = results.filter((result) => result.ok).length;
  return {
    schemaVersion: CODE_EVAL_SCHEMA_VERSION,
    mode,
    tasks: results,
    totals: {
      tasks: results.length,
      passed,
      failed: results.length - passed,
      steps: results.reduce((sum, result) => sum + result.steps, 0),
      checks: results.reduce((sum, result) => sum + result.checks, 0),
      tokens: results.reduce((sum, result) => sum + result.tokens, 0),
      durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
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

/** A bounded, line-oriented rendering of the change set, used only as review input text. */
export function renderChangeDiff(changes: readonly TestChangeInput[], limit = 20_000): string {
  const blocks = changes.map((change) => {
    const before = (change.before ?? "").split("\n").filter(Boolean);
    const after = (change.after ?? "").split("\n").filter(Boolean);
    const removed = before.filter((line) => !after.includes(line)).map((line) => `-${line}`);
    const added = after.filter((line) => !before.includes(line)).map((line) => `+${line}`);
    return [`--- a/${change.path}`, `+++ b/${change.path}`, ...removed, ...added].join("\n");
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
  "test_integrity",
  "self_review",
  "repair_loop",
]);

function invalid(message: string, details?: Record<string, unknown>): CodeEvalError {
  return new CodeEvalError("eval_fixture_invalid", message, 400, details);
}

const CATEGORY_SET = new Set<string>(SELF_REVIEW_FINDING_CATEGORIES);
const SEVERITY_SET = new Set<string>(SELF_REVIEW_SEVERITIES);

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
