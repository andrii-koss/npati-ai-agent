import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CostTelemetry, configuredModelPricing } from "../apps/agent-api/src/cost-telemetry";
import {
  CODE_EVAL_SCHEMA_VERSION,
  EVAL_COST_UNAVAILABLE_REASONS,
  EVAL_LANGUAGES,
  EVAL_TASK_KINDS,
  computeEvalCost,
  countEvalTurns,
  diffStatsFor,
  evalTurnIndexes,
  loadEvalFixture,
  loadEvalTasks,
  runEvalSuite,
  type EvalHarnessDeps,
  type EvalTask,
  type EvalVerification,
} from "../apps/agent-api/src/code-eval-harness";
import {
  CODE_EVAL_PROFILE_QUALITY_REASONS,
  CODE_EVAL_PROFILE_SCENARIOS,
  CODE_EVAL_PROFILE_SUBJECTS,
  buildCodeEvalProfileReport,
} from "../apps/agent-api/src/code-eval-profile-report";
import {
  DEFAULT_CODE_MODEL_PROFILES,
  modelProfileFallbackTrace,
  resolveModelProfile,
  type CodeModelProfile,
} from "../apps/agent-api/src/code-model-profiles";

/**
 * C14 (owner decision 1): the eval **scoring** and the comparative **profile** report.
 *
 * Two things are measured here and one is refused, and keeping them apart is the point:
 *
 * 1. **Scoring is a computation.** `diffStats`, `turns` and `costUsd` are derived from state the harness
 *    already holds (the change set between the task's initial files and the final workspace, the executed
 *    transcript prefix, the usage the caller reports). Each one is asserted in both directions: a real change
 *    set and a false declaration, a computed price and an unknown one — `null` with a reason, never `0`.
 * 2. **The profile report is conformance, not quality.** Its table is re-derived from the real
 *    `resolveModelProfile` for every subject and scenario, so "which profile drives which model, and why" is a
 *    measurement. Its quality column is `not_run` **by construction** — a per-profile pass rate needs a live
 *    model, which this flow does not call — and the suite fails if a numeric quality field ever appears.
 * 3. **The recorded suite reads no profile at all**, which is why it must never report a per-profile result.
 *    That is pinned as a source guard over the harness, not as a promise in prose.
 *
 * The suite uses a minimal in-memory deps object because the scoring layer is what it measures. The **real**
 * tool path (`CodeToolRuntime`, canonical executors, the C3 write engine) is exercised by
 * `tests/coding-agent-c6-eval.test.ts` over the same 33-task corpus, so this is not a second harness: it is the
 * arithmetic unit under the numbers that suite reports.
 */

function fixturePath(): string {
  return `${import.meta.dirname}/fixtures/coding-agent-eval/tasks.json`;
}

function loadFixtureTasks(): EvalTask[] {
  return loadEvalFixture(JSON.parse(readFileSync(fixturePath(), "utf8"))).tasks;
}

/** The model whose price the project's own table really knows; the unknown-model case uses `null`. */
const PRICED_MODEL = "anthropic/claude-3-5-sonnet";
/** USD per step with the split this suite reports: 30 prompt at 3.0/M + 10 completion at 15.0/M. */
const STEP_COST_USD = 0.00024;

const scoringTask: EvalTask = {
  id: "scoring-two-file-change",
  title: "Change two files so the scoring layer has something to count",
  intent: "EDIT_CODE",
  taskType: "multi_file",
  language: "javascript",
  files: { "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 2;\n" },
  script: [
    { kind: "tool", tool: "code.fs.read", args: { path: "src/a.js" } },
    { kind: "tool", tool: "code.fs.write", args: { path: "src/a.js", content: "export const a = 11;\n" } },
    { kind: "tool", tool: "code.fs.read", args: { path: "src/b.js" } },
    { kind: "tool", tool: "code.fs.write", args: { path: "src/b.js", content: "export const b = 22;\n" } },
    { kind: "message", text: "Both constants moved." },
  ],
  verify: { type: "diff_stats", expect: { files: 2, linesAdded: 2, linesRemoved: 2 } },
};

/**
 * The same three tool shapes the corpus uses (`read`, `write`, `edit`) over a plain map, plus a deterministic
 * 40-token split per call. Anything else is refused with a code, so a task cannot quietly "succeed" here on a
 * tool this fake does not implement — the difference would show up as a failed task, not as a passed one.
 */
function scoringHarness(task: EvalTask, options: { model?: string | null } = {}) {
  const state: Record<string, string> = { ...task.files };
  const model = options.model === undefined ? PRICED_MODEL : options.model;
  const deps: EvalHarnessDeps = {
    invokeTool: async ({ tool, args }) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const path = typeof input.path === "string" ? input.path : "";
      if (tool === "code.fs.read") return { ok: true };
      if (tool === "code.fs.write" && typeof input.content === "string") {
        state[path] = input.content;
        return { ok: true };
      }
      if (tool === "code.fs.edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
        const current = state[path];
        if (current === undefined || !current.includes(input.old_string)) return { ok: false, error: { code: "not_a_file" } };
        state[path] = current.replace(input.old_string, input.new_string);
        return { ok: true };
      }
      return { ok: false, error: { code: "unknown_tool" } };
    },
    runCommand: async () => ({ exitCode: 0, output: "scoring harness: no command" }),
    files: () => state,
    usage: () => {
      const promptTokens = 30;
      const completionTokens = 10;
      return { tokens: promptTokens + completionTokens, promptTokens, completionTokens };
    },
    price: () => (model === null ? null : configuredModelPricing(model)),
  };
  return { state, deps };
}

async function runScoringTask(task: EvalTask = scoringTask, options: { model?: string | null } = {}) {
  const harness = scoringHarness(task, options);
  const report = await runEvalSuite([task], harness.deps);
  return { report, result: report.tasks[0]!, state: harness.state };
}

/** The same task with one verification swapped, used for the negative controls. */
function withVerification(task: EvalTask, verification: EvalVerification): EvalTask {
  return { ...task, verify: verification };
}

describe("security-gate: C14 eval scoring — diffStats, turns and a cost that is computed or refused", () => {
  it("counts the run's change set, its turns and its tokens, and prices them from the project's price table", async () => {
    const { report, result } = await runScoringTask();
    if (!result.ok) throw new Error(`scoring task failed: ${result.reason ?? "unknown"}`);
    expect(result.steps).toBe(5);
    expect(result.toolCalls).toBe(4);
    expect(result.turns).toBe(1); // four consecutive tool calls are ONE turn that issued them
    expect(result.diffStats).toEqual({ files: 2, linesAdded: 2, linesRemoved: 2 });
    expect(result.tokens).toBe(4 * 40);
    // The price of `anthropic/claude-3-5-sonnet` in the project's table: 3.0 USD/M prompt, 15.0 USD/M completion.
    expect(result.costUsd).toBe(Number((4 * STEP_COST_USD).toFixed(6)));
    expect(result.costUnavailable).toBeUndefined();
    expect(report.totals.diffStats).toEqual({ files: 2, linesAdded: 2, linesRemoved: 2 });
    expect(report.totals.costUsd).toBe(result.costUsd);
    expect(report.totals.costUnavailableTasks).toBe(0);
    expect(report.schemaVersion).toBe(CODE_EVAL_SCHEMA_VERSION);
  });

  it("reports an unknown model as no cost at all, never as zero and never from the generic price row", async () => {
    const { report, result } = await runScoringTask(scoringTask, { model: null });
    expect(result.costUsd).toBeNull();
    expect(result.costUnavailable).toBe("no_price_for_model");
    // The total must not read as "this suite was free": no priced task means no sum.
    expect(report.totals.costUsd).toBeNull();
    expect(report.totals.costUnavailableTasks).toBe(1);
    // The distinction that makes the null honest: the *budget* path still answers a generic number, while the
    // metric path refuses to pretend that number is this model's price.
    expect(configuredModelPricing("acme/mystery-1")).toBeNull();
    expect(CostTelemetry.calculate("acme/mystery-1", { promptTokens: 30, completionTokens: 10, totalTokens: 40 }).totalCostUsd)
      .toBeGreaterThan(0);
  });

  it("refuses a price it cannot apply, and keeps 'free' distinguishable from 'unknown'", () => {
    const split = { tokens: 40, promptTokens: 30, completionTokens: 10 };
    expect(computeEvalCost(split, { promptPerM: 3, completionPerM: 15 })).toEqual({ costUsd: 0.00024 });
    // No price: unavailable, not zero.
    expect(computeEvalCost(split, null)).toEqual({ costUsd: null, unavailable: "no_price_for_model" });
    // A price that is not a price (NaN, negative, missing) is not silently treated as free.
    expect(computeEvalCost(split, { promptPerM: Number.NaN, completionPerM: 15 }).unavailable).toBe("no_price_for_model");
    expect(computeEvalCost(split, { promptPerM: 3, completionPerM: -1 }).unavailable).toBe("no_price_for_model");
    // A total without a split cannot be priced: the prompt rate understates and the completion rate overstates.
    expect(computeEvalCost({ tokens: 1000, promptTokens: 0, completionTokens: 0 }, { promptPerM: 3, completionPerM: 15 }))
      .toEqual({ costUsd: null, unavailable: "token_split_unavailable" });
    // A genuinely empty run with a known price costs zero, and that is a measurement rather than a refusal.
    expect(computeEvalCost({ tokens: 0, promptTokens: 0, completionTokens: 0 }, { promptPerM: 3, completionPerM: 15 }))
      .toEqual({ costUsd: 0 });
    // The vocabulary is closed, so a new reason cannot appear as free text.
    expect([...EVAL_COST_UNAVAILABLE_REASONS].sort()).toEqual(["no_price_for_model", "token_split_unavailable"]);
  });

  it("derives turns by a stated rule, and the message that closes a tool run is that same turn", () => {
    // A maximal run of consecutive tool calls is one turn; the closing text belongs to it.
    expect(evalTurnIndexes([
      { kind: "tool", tool: "code.fs.read" },
      { kind: "tool", tool: "code.fs.write" },
      { kind: "message", text: "done" },
    ])).toEqual([1, 1, 1]);
    expect(countEvalTurns([
      { kind: "tool", tool: "code.fs.read" },
      { kind: "tool", tool: "code.fs.write" },
      { kind: "message", text: "done" },
    ])).toBe(1);
    // A message that closes nothing is a turn that issued no tool call.
    expect(countEvalTurns([{ kind: "message", text: "I think it is fine." }])).toBe(1);
    // A `check` is issued by the loop, never by the model: it forms no turn, but it does end the one before it.
    expect(evalTurnIndexes([
      { kind: "check", command: "npm test", expect: "fail" },
      { kind: "tool", tool: "code.fs.read" },
      { kind: "check", command: "npm test", expect: "pass" },
      { kind: "tool", tool: "code.fs.read" },
      { kind: "message", text: "repaired" },
    ])).toEqual([0, 1, 0, 2, 2]);
    expect(countEvalTurns([])).toBe(0);
  });

  it("counts only the turns that really ran when a task stops early", async () => {
    const stopped: EvalTask = {
      ...scoringTask,
      maxSteps: 2,
      script: [
        { kind: "tool", tool: "code.fs.read", args: { path: "src/a.js" } },
        { kind: "message", text: "done for now" },
        { kind: "tool", tool: "code.fs.write", args: { path: "src/a.js", content: "export const a = 11;\n" } },
        { kind: "message", text: "and now this" },
      ],
      verify: { type: "file_contains", path: "src/a.js", contains: "export const a = 1;" },
    };
    const { result } = await runScoringTask(stopped);
    // Two steps ran (the read and the closing message) = one turn; the two steps that never ran are not counted.
    expect(result.reason).toContain("max_steps_exceeded");
    expect(result.steps).toBe(2);
    expect(result.turns).toBe(1);
    expect(countEvalTurns(stopped.script)).toBe(2);
    expect(result.diffStats).toEqual({ files: 0, linesAdded: 0, linesRemoved: 0 });
  });

  it("counts a set difference, so a line moved inside a file is neither added nor removed", () => {
    expect(diffStatsFor([
      { path: "src/new.js", status: "added", before: "", after: "export const a = 1;\nexport const b = 2;\n" },
      { path: "src/gone.js", status: "deleted", before: "export const c = 3;\n", after: "" },
      { path: "src/moved.js", status: "modified", before: "first\nsecond\n", after: "second\nfirst\n" },
      { path: "src/edited.js", status: "modified", before: "old\n", after: "new\n" },
    ])).toEqual({ files: 4, linesAdded: 3, linesRemoved: 2 });
  });

  it("fails a task whose declared change set is not the change set it made, in every direction", async () => {
    const wrongFiles = await runScoringTask(withVerification(scoringTask, { type: "diff_stats", expect: { files: 1 } }));
    expect(wrongFiles.result.ok).toBe(false);
    expect(wrongFiles.result.reason).toBe("verify_diff_stats_files:2!=1");

    const wrongAdded = await runScoringTask(withVerification(scoringTask, { type: "diff_stats", expect: { files: 2, linesAdded: 3 } }));
    expect(wrongAdded.result.ok).toBe(false);
    expect(wrongAdded.result.reason).toBe("verify_diff_stats_lines_added:2!=3");

    const wrongRemoved = await runScoringTask(withVerification(scoringTask, { type: "diff_stats", expect: { files: 2, linesRemoved: 3 } }));
    expect(wrongRemoved.result.ok).toBe(false);
    expect(wrongRemoved.result.reason).toBe("verify_diff_stats_lines_removed:2!=3");

    // "Nothing changed" cannot satisfy a change-set claim by omission: zero is a declaration like any other.
    const nothingChanged = await runScoringTask(withVerification(scoringTask, { type: "diff_stats", expect: { files: 0 } }));
    expect(nothingChanged.result.ok).toBe(false);
    expect(nothingChanged.result.reason).toBe("verify_diff_stats_files:2!=0");
  });

  it("rejects a malformed diff_stats declaration instead of skipping the verification", () => {
    const task = loadFixtureTasks()[0]!;
    expect(() => loadEvalTasks([{ ...task, verify: { type: "diff_stats", expect: {} } }])).toThrow(/eval_fixture_invalid/);
    expect(() => loadEvalTasks([{ ...task, verify: { type: "diff_stats", expect: { files: -1 } } }])).toThrow(/eval_fixture_invalid/);
    expect(() => loadEvalTasks([{ ...task, verify: { type: "diff_stats", expect: { files: 1, linesAdded: -1 } } }])).toThrow(/eval_fixture_invalid/);
    expect(() => loadEvalTasks([{ ...task, verify: { type: "diff_stats", expect: { files: 1.5 } } }])).toThrow(/eval_fixture_invalid/);
    expect(() => loadEvalTasks([{ ...task, verify: { type: "diff_stats" } }])).toThrow(/eval_fixture_invalid/);
  });

  it("rejects an unknown task kind or language instead of counting it as coverage", () => {
    const task = loadFixtureTasks()[0]!;
    // The metadata stays optional so older fixtures load verbatim, but a present value is from the closed set.
    expect(loadEvalTasks([{ ...task, taskType: undefined, language: undefined }])).toHaveLength(1);
    expect(() => loadEvalTasks([{ ...task, taskType: "bugfix" }])).toThrow(/eval_fixture_invalid/);
    expect(() => loadEvalTasks([{ ...task, language: "rust" }])).toThrow(/eval_fixture_invalid/);
    expect([...EVAL_TASK_KINDS].sort()).toEqual([
      "bug_fix",
      "build_repair",
      "dependency_migration",
      "feature",
      "multi_file",
      "refactor",
      "tests",
    ]);
  });

  it("still runs a schema-2 fixture, so growing the vocabulary to 3 stayed additive", async () => {
    const tasks = loadFixtureTasks();
    const legacy = loadEvalFixture({
      schemaVersion: 2,
      description: "C9 corpus, read by a schema-3 build",
      // Two C9-era tasks with no `check` step: this suite's deps are a scoring stub with no command simulator,
      // and the point here is the *schema* path, not the check path (`c6-eval` covers that over the real runtime).
      tasks: tasks.filter((task) => task.id === "write-unit-test" || task.id === "refactor-rename-parser"),
    });
    expect(legacy.schemaVersion).toBe(2);
    expect(legacy.tasks).toHaveLength(2);
    for (const task of legacy.tasks) {
      // The schema-2 tasks carry the C14 metadata, which the loader must simply ignore rather than refuse.
      const { result } = await runScoringTask(task);
      if (!result.ok) throw new Error(`schema-2 task ${task.id} failed: ${result.reason ?? "unknown"}`);
      expect(result.costUsd).not.toBeNull();
    }
    // A newer fixture than this build understands is still refused, which is what keeps "additive" honest.
    expect(() => loadEvalFixture({ schemaVersion: CODE_EVAL_SCHEMA_VERSION + 1, tasks: [] })).toThrow(/eval_fixture_version_unsupported/);
  });
});

describe("security-gate: C14 comparative report per profile — conformance is measured, quality is not_run", () => {
  it("re-derives every resolution from the real resolver and says why the conservative profile was used", () => {
    const report = buildCodeEvalProfileReport({ tasks: loadFixtureTasks() });
    // The report is a measurement: every row must agree with a fresh call to the production resolver.
    const expected = CODE_EVAL_PROFILE_SCENARIOS.flatMap((scenario) => CODE_EVAL_PROFILE_SUBJECTS.map((subject) => {
      const resolved = resolveModelProfile({
        provider: subject.provider,
        model: subject.model,
        profiles: DEFAULT_CODE_MODEL_PROFILES,
        ...(scenario.enabledProfileIds === null ? {} : { enabledProfileIds: scenario.enabledProfileIds }),
      });
      return {
        scenario: scenario.id,
        provider: subject.provider,
        model: subject.model,
        ...modelProfileFallbackTrace(resolved, { enabledProfileIds: scenario.enabledProfileIds }),
      };
    }));
    expect(report.conformance).toEqual(expected);
    // …and the four resolution rules the subject list was chosen to expose are really the ones that happen.
    const chosen = (scenario: string, model: string): { profileId: string; matchedBy: string; fallbackReason: string | null } => {
      const row = report.conformance.find((entry) => entry.scenario === scenario && entry.model === model);
      if (!row) throw new Error(`no conformance row for ${scenario}/${model}`);
      return { profileId: row.profileId, matchedBy: row.matchedBy, fallbackReason: row.fallbackReason };
    };
    expect(chosen("registry_unfiltered", "gpt-4o").profileId).toBe("hosted-native-tools");
    expect(chosen("registry_unfiltered", "claude-3-5-haiku").profileId).toBe("hosted-native-tools-small-context");
    expect(chosen("registry_unfiltered", "claude-3-5-haiku").matchedBy).toBe("pattern");
    expect(chosen("registry_unfiltered", "llama3.1:8b").profileId).toBe("local-text-tools");
    // A model nothing knows: with no filter this is a genuine no-match, with nothing enabled it is the flag.
    expect(chosen("registry_unfiltered", "acme/mystery-1")).toEqual({ profileId: "conservative-default", matchedBy: "default", fallbackReason: "no_matching_profile" });
    expect(chosen("no_profile_enabled", "gpt-4o")).toEqual({ profileId: "conservative-default", matchedBy: "default", fallbackReason: "profile_flag_disabled" });
    // Which profile wins depends on what is enabled, and the report shows the winner rather than assuming it:
    // with the pattern profile outside the enabled subset, the broader provider profile is what drives the model.
    expect(chosen("flags_enabled_subset", "claude-3-5-haiku").profileId).toBe("hosted-native-tools");
    expect(chosen("flags_enabled_subset", "llama3.1:8b")).toEqual({ profileId: "local-text-tools", matchedBy: "provider", fallbackReason: null });
  });

  it("gives one row per profile and marks every one of them not_run, with no numeric quality field", () => {
    const report = buildCodeEvalProfileReport({ tasks: loadFixtureTasks() });
    const extra: CodeModelProfile = {
      id: "acme-rust-tools",
      match: { patterns: ["*rust*"] },
      toolCallingMode: "text",
      maxParallelToolCalls: 2,
      contextWindow: 32_000,
    };
    const withUnmatched = buildCodeEvalProfileReport({ tasks: loadFixtureTasks(), profiles: [...DEFAULT_CODE_MODEL_PROFILES, extra] });
    // A profile that matched nothing still gets a row: "no records" is shown, not omitted and not invented.
    const unmatchedRow = withUnmatched.profiles.find((row) => row.profileId === "acme-rust-tools");
    if (!unmatchedRow) throw new Error("the unmatched profile has no row");
    expect(unmatchedRow.matchedFor).toEqual([]);
    expect(unmatchedRow.quality).toEqual({ status: "not_run", reason: "live_run_not_performed" });
    expect(Object.keys(unmatchedRow.quality).sort()).toEqual(["reason", "status"]);
    // Every registry profile plus the conservative default, and none of them carries a quality number.
    expect(report.profiles.map((row) => row.profileId)).toEqual([
      ...DEFAULT_CODE_MODEL_PROFILES.map((profile) => profile.id),
      "conservative-default",
    ]);
    for (const row of [...report.profiles, unmatchedRow]) {
      expect(Object.keys(row.quality).sort()).toEqual(["reason", "status"]);
      expect(row.quality.status).toBe("not_run");
      expect(row.quality.reason).toBe(CODE_EVAL_PROFILE_QUALITY_REASONS[0]);
    }
    expect(report.profiles.find((row) => row.profileId === "conservative-default")?.source).toBe("conservative_default");
    // The whole table, pinned: the C14 documentation quotes exactly these strings, so prose cannot drift from
    // the run. Every entry is `<scenario>:<provider>/<model>` and was produced by the real resolver above.
    expect(report.profiles.map((row) => [row.profileId, row.matchedBy, row.matchedFor])).toEqual([
      [
        "hosted-native-tools",
        ["provider"],
        ["flags_enabled_subset:anthropic/claude-3-5-haiku", "flags_enabled_subset:openai/gpt-4o", "registry_unfiltered:openai/gpt-4o"],
      ],
      ["hosted-native-tools-small-context", ["pattern"], ["registry_unfiltered:anthropic/claude-3-5-haiku"]],
      ["local-text-tools", ["provider"], ["flags_enabled_subset:ollama/llama3.1:8b", "registry_unfiltered:ollama/llama3.1:8b"]],
      [
        "conservative-default",
        ["default"],
        [
          "flags_enabled_subset:-/acme/mystery-1",
          "no_profile_enabled:-/acme/mystery-1",
          "no_profile_enabled:anthropic/claude-3-5-haiku",
          "no_profile_enabled:ollama/llama3.1:8b",
          "no_profile_enabled:openai/gpt-4o",
          "registry_unfiltered:-/acme/mystery-1",
        ],
      ],
    ]);
    expect(report.quality.measured).toBe(false);
    expect(report.quality.refusal.code).toBe("eval_live_model_missing");
    expect(report.quality.requires).toContain("NPATI_CODE_EVAL_LIVE=1");
    // The statement lives in the report itself, so a reader of the JSON cannot miss it.
    expect(report.quality.note).toContain("never reads a model profile");
    // And the table really records which subjects each profile answered, measured rather than assumed.
    const hosted = report.profiles.find((row) => row.profileId === "hosted-native-tools");
    expect(hosted?.matchedFor).toContain("registry_unfiltered:openai/gpt-4o");
    expect(hosted?.matchedBy).toEqual(["provider"]);
  });

  it("counts the corpus by kind and language, and points at the per-task records instead of attributing them", () => {
    const tasks = loadFixtureTasks();
    const report = buildCodeEvalProfileReport({ tasks });
    expect(report.corpus.tasks).toBe(tasks.length);
    expect(report.corpus.tasks).toBeGreaterThanOrEqual(30);
    // Every kind and language key is present, zeros included, so a gap is visible as `0` rather than absent.
    expect(Object.keys(report.corpus.taskTypes).sort()).toEqual([...EVAL_TASK_KINDS].sort());
    expect(Object.keys(report.corpus.languages).sort()).toEqual([...EVAL_LANGUAGES].sort());
    expect(Object.values(report.corpus.taskTypes).reduce((sum, count) => sum + count, 0)).toBe(tasks.length);
    expect(Object.values(report.corpus.languages).reduce((sum, count) => sum + count, 0)).toBe(tasks.length);
    expect(report.corpus.taskTypes["dependency_migration"]).toBeGreaterThan(0);
    expect(report.corpus.languages.python).toBeGreaterThan(0);
    expect(report.corpus.languages.go).toBeGreaterThan(0);
    // The shipped corpus declares both fields on every task: no undeclared task can hide inside a total.
    expect(report.corpus.undeclaredTaskType).toBe(0);
    expect(report.corpus.undeclaredLanguage).toBe(0);
    // The per-task scores are keyed by TASK and are identical for every profile, so they are not attributed.
    expect(report.corpus.records.status).toBe("profile_independent");
    expect(report.corpus.records.reason).toContain("identical for every profile");
    expect(report.corpus.records.producedBy).toContain("runEvalSuite()");
    expect(report.corpus.records.assertedBy).toBe("tests/coding-agent-c6-eval.test.ts");
    // CI's artifact for the same suite is named exactly as the eval job writes it, and the report does not
    // pretend that file carries the scores.
    expect(report.corpus.records.ciArtifact).toBe("artifacts/coding-agent-eval-smoke-report.json");
  });

  it("is deterministic and carries the eval schema version, so the table in the documentation is reproducible", () => {
    const tasks = loadFixtureTasks();
    const first = buildCodeEvalProfileReport({ tasks });
    const second = buildCodeEvalProfileReport({ tasks });
    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe(CODE_EVAL_SCHEMA_VERSION);
    expect(first.mode).toBe("recorded");
    // The row shape is pinned, so a numeric quality field cannot be added later without failing this: the two
    // keys of `quality` are the whole vocabulary of "not measured here".
    for (const row of first.profiles) {
      expect(Object.keys(row).sort()).toEqual([
        "contextWindow",
        "matchedBy",
        "matchedFor",
        "maxParallelToolCalls",
        "profileId",
        "quality",
        "source",
        "toolCallingMode",
      ]);
    }
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("passRate");
    expect(serialized).not.toContain("successRate");
  });

  it("proves the recorded corpus suite reads no profile at all, which is why no result may be attached to one", () => {
    const source = readFileSync(`${import.meta.dirname}/../apps/agent-api/src/code-eval-harness.ts`, "utf8");
    // A profile is configuration the *runner* resolves; the eval harness must not consult one, or "task X passed
    // on profile Y" would become a claim about a number that never changed.
    expect(source).not.toMatch(/code-model-profiles/);
    expect(source).not.toMatch(/resolveModelProfile|modelProfileTrace|modelProfileFallbackTrace|enabledProfileIds/);
  });
});
