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
 * - Verification is declared per task (`file_contains` or `command_succeeds`) and is evaluated AFTER the
 *   run, so a task cannot pass by merely claiming success.
 * - Live model runs are opt-in (`NPATI_CODE_EVAL_LIVE=1`) and REFUSE to run when no live model is injected:
 *   silently reusing recorded answers would make the live number a lie.
 */

import type { CodeIntent } from "@npati/shared";

export const CODE_EVAL_SCHEMA_VERSION = 1;

export type EvalStep =
  | { kind: "tool"; tool: string; args?: unknown; expectError?: string }
  | { kind: "message"; text: string };

export type EvalVerification =
  | { type: "file_contains"; path: string; contains: string }
  | { type: "command_succeeds"; command: string };

export interface EvalTask {
  id: string;
  title: string;
  intent: CodeIntent;
  /** Initial repository state; the runner may only change these files through tools. */
  files: Record<string, string>;
  script: EvalStep[];
  verify: EvalVerification;
  /** Upper bound so a looping agent fails the task instead of hanging CI. */
  maxSteps?: number;
}

export interface EvalTaskResult {
  id: string;
  ok: boolean;
  steps: number;
  toolCalls: number;
  failures: number;
  tokens: number;
  durationMs: number;
  reason?: string;
}

export interface EvalReport {
  schemaVersion: number;
  mode: "recorded" | "live";
  tasks: EvalTaskResult[];
  totals: { tasks: number; passed: number; failed: number; steps: number; tokens: number; durationMs: number };
}

export interface EvalHarnessDeps {
  /** Executes one tool call through the real runtime. Errors are returned, never thrown, matching the runtime. */
  invokeTool(input: { tool: string; args?: unknown; toolCallId: string; step: number }): Promise<{ ok: boolean; error?: { code?: string } }>;
  /** Runs a verification command in the workspace (in CI this simulates the project's test runner). */
  runCommand(command: string): Promise<{ exitCode: number; output?: string }>;
  /** Current repository state, used by file-based verification. */
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
    let failures = 0;
    let tokens = 0;
    let reason: string | undefined;

    const script: EvalStep[] = mode === "live" ? await deps.liveModel!({ task, transcript: task.script }) : task.script;

    for (const step of script) {
      if (steps >= maxSteps) {
        reason = `max_steps_exceeded:${maxSteps}`;
        break;
      }
      steps += 1;
      if (step.kind === "message") continue;
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
      const verified = await verifyTask(task, deps);
      if (!verified.ok) reason = verified.reason;
    }

    results.push({
      id: task.id,
      ok: !reason,
      steps,
      toolCalls,
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
      tokens: results.reduce((sum, result) => sum + result.tokens, 0),
      durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    },
  };
}

async function verifyTask(task: EvalTask, deps: EvalHarnessDeps): Promise<{ ok: boolean; reason?: string }> {
  if (task.verify.type === "file_contains") {
    const content = deps.files()[task.verify.path];
    if (content === undefined) return { ok: false, reason: `verify_missing_file:${task.verify.path}` };
    if (!content.includes(task.verify.contains)) return { ok: false, reason: `verify_content_mismatch:${task.verify.path}` };
    return { ok: true };
  }
  const result = await deps.runCommand(task.verify.command);
  if (result.exitCode !== 0) return { ok: false, reason: `verify_command_failed:${task.verify.command}:${result.exitCode}` };
  return { ok: true };
}

/** Loads an already parsed fixture set and rejects malformed tasks instead of skipping them silently. */
export function loadEvalTasks(raw: unknown): EvalTask[] {
  if (!Array.isArray(raw)) throw new CodeEvalError("eval_fixture_invalid", "Eval fixture must be an array of tasks", 400);
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new CodeEvalError("eval_fixture_invalid", `Task #${index} is not an object`, 400);
    const task = entry as Partial<EvalTask>;
    if (!task.id || !task.title || !task.intent || !task.files || !Array.isArray(task.script) || !task.verify) {
      throw new CodeEvalError("eval_fixture_invalid", `Task #${index} is missing required fields`, 400, { id: task.id });
    }
    return task as EvalTask;
  });
}

/** CI gate: a report is green only when every task passed and the suite was not empty. */
export function evalReportIsGreen(report: EvalReport): boolean {
  return report.totals.tasks > 0 && report.totals.failed === 0;
}
