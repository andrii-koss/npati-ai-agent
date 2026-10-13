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

import {
  createSelfReview,
} from "./code-self-review";
import {
  analyzeTestIntegrity,
  describeTestIntegrity,
  type TestChangeInput,
} from "./code-test-integrity-guard";
import {
  createVerificationLoop,
  type VerificationDecision,
} from "./code-verification-loop";
import {
  CODE_EVAL_SCHEMA_VERSION,
  CodeEvalError,
  computeEvalCost,
  countEvalTurns,
  evalTurnIndexes,
  resolveEvalMode,
  type EvalDiffStats,
  type EvalHarnessDeps,
  type EvalRecordedCheck,
  type EvalReport,
  type EvalStep,
  type EvalTask,
  type EvalTaskResult,
  type EvalVerification,
} from "./code-eval-harness-types";

export * from "./code-eval-harness-types";
export * from "./code-eval-fixture-loader";

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
