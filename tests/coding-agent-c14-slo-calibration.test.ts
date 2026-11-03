import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODE_EVAL_SCHEMA_VERSION,
  EVAL_LANGUAGES,
  EVAL_TASK_KINDS,
  type EvalLanguage,
  type EvalReport,
  type EvalTask,
  type EvalTaskKind,
  type EvalTaskResult,
} from "../apps/agent-api/src/code-eval-harness";
import {
  SLO_CALIBRATION_SCHEMA_VERSION,
  SLO_GROUPED_QUANTITIES,
  SLO_MEASURED_QUANTITIES,
  SLO_PERCENTILE_METHOD,
  SLO_QUANTITY_UNITS,
  buildSloCalibration,
  distributionOf,
  medianOf,
  nearestRankPercentile,
  notMeasuredSloTargets,
  proposeSloThresholds,
  type ProposedThreshold,
  type SloDistribution,
} from "../apps/agent-api/src/code-slo-calibration";
import { CODE_PERCENTILE_METHOD } from "../apps/agent-api/src/code-percentile";
import {
  CODE_ANOMALY_MAX_COST_MULTIPLIER,
  CODE_ANOMALY_MAX_POPULATION_SAMPLES,
  CODE_ANOMALY_MAX_TOOL_ERROR_RATE,
  CODE_ANOMALY_MAX_TURN_MULTIPLIER,
  CODE_ANOMALY_RULES,
  DEFAULT_CODE_ANOMALY_THRESHOLDS,
  anomalyPopulationFrom,
  codeRunAnomalyFactsFromSummary,
  evaluateCodeRunAnomaly,
  resolveCodeAnomalyThresholds,
  type CodeAnomalyPopulation,
  type CodeAnomalyVerdict,
  type CodeRunAnomalyFacts,
} from "../apps/agent-api/src/code-anomaly-detection";
import { DEFAULT_CODE_AGENT_LIMITS } from "../apps/agent-api/src/code-agent-config";

/**
 * C14 (owner decision 4) security-gate suite: **SLO calibration** and the anomaly detector it configures.
 *
 * The owner's instruction was to stop restating R1's starting numbers and calibrate them against a real run,
 * and to mark everything the corpus cannot measure as `not_measured` instead of inventing a value. This suite
 * therefore asserts three things that a prose table cannot:
 *
 *  1. **The percentile rule is stated, not implied.** `nearest_rank` never interpolates, so every median and
 *     p95 is a value some sample really produced; an empty sample answers `null` with a reason and **never**
 *     `0`, and a two-sample group's p95 IS its maximum (which is why a population floor exists at all).
 *  2. **`measured`, `not_measured` and `proposed` are three different answers.** Removing one source of
 *     measurement degrades exactly the thresholds derived from it and leaves the others standing; removing the
 *     report degrades *all* of them to `not_measured`. A threshold that no measurement supports can therefore
 *     never read as calibrated.
 *  3. **A rule that did not run never clears a run.** With no population and no tool calls the anomaly verdict
 *     is `unavailable` with `anomalous: null` — not `false` — and a population below the floor (where a p95 is a
 *     disguised maximum) is refused rather than used.
 *
 * The numbers in this suite are synthetic on purpose: this is the arithmetic under the calibration, and the
 * **real** corpus measurement is pinned by the suite that really runs the corpus
 * (`tests/coding-agent-c6-eval.test.ts`), which also asserts that the shipped defaults equal the values this
 * calibration proposes.
 */

// ---------------------------------------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------------------------------------

function result(id: string, overrides: Partial<EvalTaskResult> = {}): EvalTaskResult {
  return {
    id,
    ok: true,
    steps: 3,
    toolCalls: 2,
    checks: 0,
    turns: 1,
    failures: 0,
    tokens: 83,
    durationMs: 4,
    diffStats: { files: 1, linesAdded: 1, linesRemoved: 1 },
    costUsd: 0.000489,
    ...overrides,
  };
}

function taskOf(id: string, taskType: EvalTaskKind, language: EvalLanguage): EvalTask {
  return {
    id,
    title: id,
    intent: "EDIT_CODE",
    taskType,
    language,
    files: { "src/a.js": "export const a = 1;\n" },
    script: [{ kind: "message", text: "done" }],
    verify: { type: "file_contains", path: "src/a.js", contains: "a = 1" },
  };
}

/** The report shape `runEvalSuite` produces, rebuilt from results so a synthetic sample is still a real report. */
function reportOf(results: readonly EvalTaskResult[]): EvalReport {
  const sum = (pick: (result: EvalTaskResult) => number) => results.reduce((total, entry) => total + pick(entry), 0);
  const priced = results.filter((entry) => entry.costUsd !== null);
  return {
    schemaVersion: CODE_EVAL_SCHEMA_VERSION,
    mode: "recorded",
    tasks: [...results],
    totals: {
      tasks: results.length,
      passed: results.filter((entry) => entry.ok).length,
      failed: results.filter((entry) => !entry.ok).length,
      steps: sum((entry) => entry.steps),
      turns: sum((entry) => entry.turns),
      checks: sum((entry) => entry.checks),
      tokens: sum((entry) => entry.tokens),
      durationMs: sum((entry) => entry.durationMs),
      diffStats: {
        files: sum((entry) => entry.diffStats.files),
        linesAdded: sum((entry) => entry.diffStats.linesAdded),
        linesRemoved: sum((entry) => entry.diffStats.linesRemoved),
      },
      costUsd: priced.length ? Number(priced.reduce((total, entry) => total + (entry.costUsd ?? 0), 0).toFixed(6)) : null,
      costUnavailableTasks: results.length - priced.length,
    },
  };
}

function distribution(calibration: ReturnType<typeof buildSloCalibration>, quantity: SloDistribution["quantity"]): SloDistribution {
  const found = calibration.overall.find((entry) => entry.quantity === quantity);
  if (!found) throw new Error(`no distribution for ${quantity}`);
  return found;
}

function proposal(calibration: ReturnType<typeof buildSloCalibration>, target: string): ProposedThreshold {
  const found = calibration.proposed.find((entry) => entry.target === target);
  if (!found) throw new Error(`no proposal for ${target}`);
  return found;
}

function proposedValue(calibration: ReturnType<typeof buildSloCalibration>, target: string): number {
  const found = proposal(calibration, target);
  if (found.status !== "proposed") throw new Error(`proposal ${target} is ${found.status}: ${found.reason}`);
  return found.value;
}

function population(input: { costMedian: number | null; costN: number; turnsP95: number | null; turnsN: number }): CodeAnomalyPopulation {
  return {
    cost: { median: input.costMedian, sampleSize: input.costN, source: "synthetic population" },
    turns: { p95: input.turnsP95, sampleSize: input.turnsN, source: "synthetic population" },
  };
}

function facts(overrides: Partial<CodeRunAnomalyFacts> = {}): CodeRunAnomalyFacts {
  return { runId: "run-1", turns: 1, tokens: 83, toolCalls: 2, toolErrors: 0, costUsd: 0.000489, ...overrides };
}

const CODES = (verdict: CodeAnomalyVerdict) => verdict.findings.map((finding) => finding.code);

/**
 * Reads a repository source file without depending on the process CWD. Two candidates are tried — the CWD (how
 * `npm test` and `npm run security-gate` are invoked) and the test directory's parent — and a miss throws rather
 * than scanning nothing, which is the defect the corpus suite's `import.meta.dirname` comment warns about.
 */
function readSource(relative: string): string {
  const candidates = [path.join(process.cwd(), relative), path.join(import.meta.dirname, "..", relative)];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`source file not found: ${relative}`);
  return readFileSync(found, "utf8");
}

// ---------------------------------------------------------------------------------------------------------
// 1. The percentile rule
// ---------------------------------------------------------------------------------------------------------

describe("security-gate: C14 SLO calibration — the percentile rule is nearest-rank and never invents a value", () => {
  it("answers null for an empty sample, and a statistic is never 0 standing in for 'not measured'", () => {
    expect(nearestRankPercentile([], 95)).toBeNull();
    expect(medianOf([])).toBeNull();
    const empty = distributionOf("turns", [], { source: "synthetic", observationCount: 7 });
    expect(empty.sampleSize).toBe(0);
    expect(empty.observationCount).toBe(7);
    expect(empty.median).toBeNull();
    expect(empty.p95).toBeNull();
    expect(empty.min).toBeNull();
    expect(empty.max).toBeNull();
    expect(empty.sum).toBeNull();
    expect(empty.unavailable).toBe("no_task_reported_turns");
    // The failure mode this guards: a `0` in any statistic would read as "every run used zero turns", which is
    // a measurement, while the truth is that nothing was measured.
    const serialized = JSON.parse(JSON.stringify(empty)) as Record<string, unknown>;
    for (const statistic of ["median", "p95", "min", "max", "sum"]) {
      expect(serialized[statistic]).toBeNull();
      expect(serialized[statistic]).not.toBe(0);
    }
  });

  it("does not interpolate: the median of two samples is one of them, and their p95 is their maximum", () => {
    expect(medianOf([1, 2])).toBe(1); // not 1.5
    expect(nearestRankPercentile([1, 2], 95)).toBe(2);
    // The fact the population floor rests on: at n=2 the nearest-rank p95 IS the maximum, so a p95 threshold
    // over two samples is a maximum wearing a percentile's name.
    const sample = [4, 9];
    expect(nearestRankPercentile(sample, 95)).toBe(Math.max(...sample));
    expect(nearestRankPercentile(sample, 50)).toBe(4);
  });

  it("places the statistic at the nearest rank of the ascending sample", () => {
    const sample = Array.from({ length: 20 }, (_, index) => index + 1); // 1..20
    expect(medianOf(sample)).toBe(10); // rank ceil(0.5 * 20) = 10
    expect(nearestRankPercentile(sample, 95)).toBe(19); // rank ceil(0.95 * 20) = 19, not the maximum
    expect(nearestRankPercentile(sample, 100)).toBe(20);
    // Order of the input cannot matter: the rule sorts first.
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(nearestRankPercentile([20, 1], 50)).toBe(1);
  });

  it("refuses a percentile outside (0, 100] and drops entries that are not numbers", () => {
    for (const bad of [0, -1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(nearestRankPercentile([1, 2, 3], bad)).toBeNull();
    }
    expect(medianOf([1, Number.NaN, 3])).toBe(1); // the NaN is dropped, not sorted into the middle
    expect(distributionOf("tokens", [Number.NaN], { source: "synthetic" }).unavailable).toBe("no_task_reported_tokens");
  });

  it("names the one rule in every answer, so a reader can re-derive each number", () => {
    expect(SLO_PERCENTILE_METHOD).toBe("nearest_rank");
    expect(CODE_PERCENTILE_METHOD).toBe(SLO_PERCENTILE_METHOD);
    const measured = distributionOf("tokens", [1, 2, 3], { source: "synthetic" });
    expect(measured.percentileMethod).toBe(SLO_PERCENTILE_METHOD);
    expect(measured.p95).toBe(3);
    // Every measured quantity has a unit, and the units are a closed set.
    for (const quantity of SLO_MEASURED_QUANTITIES) {
      expect(["count", "tokens", "usd", "ms"]).toContain(SLO_QUANTITY_UNITS[quantity]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. measured · not_measured · proposed
// ---------------------------------------------------------------------------------------------------------

describe("security-gate: C14 SLO calibration — measured, not_measured and proposed stay apart", () => {
  const tasks = [
    taskOf("a", "bug_fix", "javascript"),
    taskOf("b", "bug_fix", "javascript"),
    taskOf("c", "feature", "python"),
    taskOf("d", "multi_file", "go"),
    taskOf("e", "tests", "typescript"),
  ];
  const results = [
    result("a", { steps: 3, turns: 1, tokens: 83, costUsd: 0.000489, diffStats: { files: 1, linesAdded: 1, linesRemoved: 1 } }),
    result("b", { steps: 5, turns: 2, tokens: 170, costUsd: 0.00099, diffStats: { files: 2, linesAdded: 3, linesRemoved: 1 } }),
    result("c", { steps: 3, turns: 1, tokens: 83, costUsd: 0.000489, diffStats: { files: 1, linesAdded: 2, linesRemoved: 0 } }),
    // The one nobody could price: it belongs to `observationCount`, not to `sampleSize`. Its cost is the largest
    // in the sample, so the R1 cost multiple has something to flag.
    result("d", { steps: 6, turns: 1, tokens: 215, costUsd: 0.0018, diffStats: { files: 3, linesAdded: 6, linesRemoved: 0 } }),
    // This one nobody could price: it belongs to `observationCount`, not to `sampleSize`.
    result("e", { steps: 10, turns: 4, tokens: 308, costUsd: null, diffStats: { files: 4, linesAdded: 8, linesRemoved: 7 } }),
  ];

  it("measures the report it was handed, and keeps a partial sample visible as a partial sample", () => {
    const calibration = buildSloCalibration({ report: reportOf(results), tasks });
    expect(calibration.schemaVersion).toBe(SLO_CALIBRATION_SCHEMA_VERSION);
    expect(calibration.mode).toBe("recorded");
    expect(calibration.corpus).toEqual({
      tasks: 5,
      passed: 5,
      failed: 0,
      steps: 27,
      turns: 9,
      checks: 0,
      tokens: 859,
      toolCalls: 10,
      costUsd: 0.003768,
      costUnavailableTasks: 1,
      diffStats: { files: 11, linesAdded: 20, linesRemoved: 9 },
    });

    const steps = distribution(calibration, "steps");
    expect(steps.median).toBe(5); // nearest rank at 50% of [3,3,5,6,10]
    expect(steps.p95).toBe(10);
    expect(steps.max).toBe(10);
    expect(steps.sum).toBe(27);
    expect(steps.sampleSize).toBe(5);
    expect(steps.source).toContain("EvalTaskResult.steps");

    const turns = distribution(calibration, "turns");
    expect(turns.median).toBe(1);
    expect(turns.p95).toBe(4);

    // Four of five tasks were priced: the p95 is over four, and the fifth is visible in `observationCount`.
    const cost = distribution(calibration, "cost_usd");
    expect(cost.sampleSize).toBe(4);
    expect(cost.observationCount).toBe(5);
    expect(cost.median).toBe(0.000489);
    expect(cost.p95).toBe(0.0018);

    // The change set is measured too, and its three counters are separate answers.
    expect(distribution(calibration, "diff_files").max).toBe(4);
    expect(distribution(calibration, "diff_lines_added").sum).toBe(20);
    expect(distribution(calibration, "diff_lines_removed").p95).toBe(7);
  });

  it("groups by task kind and language, with every vocabulary key present and no unjoined result hidden", () => {
    const calibration = buildSloCalibration({ report: reportOf(results), tasks });
    expect(calibration.unjoinedResults).toBe(0);
    expect(calibration.byTaskType.map((group) => group.taskType)).toEqual([...EVAL_TASK_KINDS]);
    expect(calibration.byLanguage.map((group) => group.language)).toEqual([...EVAL_LANGUAGES]);
    const bugFix = calibration.byTaskType.find((group) => group.taskType === "bug_fix")!;
    expect(bugFix.sampleSize).toBe(2);
    expect(bugFix.distributions.map((entry) => entry.quantity)).toEqual([...SLO_GROUPED_QUANTITIES]);
    expect(bugFix.distributions.find((entry) => entry.quantity === "tokens")!.max).toBe(170);
    // A kind with no task is present as an empty group, so a gap reads as `sampleSize: 0` rather than as absence.
    const empty = calibration.byTaskType.find((group) => group.taskType === "dependency_migration")!;
    expect(empty.sampleSize).toBe(0);
    expect(empty.distributions.every((entry) => entry.median === null && entry.unavailable !== undefined)).toBe(true);

    const unjoined = buildSloCalibration({ report: reportOf([...results, result("ghost")]), tasks });
    expect(unjoined.unjoinedResults).toBe(1);
    expect(unjoined.byTaskType.reduce((sum, group) => sum + group.sampleSize, 0)).toBe(results.length);
  });

  it("keeps the harness's wall clock out of the SLO, however real the number is", () => {
    const calibration = buildSloCalibration({ report: reportOf(results), tasks });
    const duration = distribution(calibration, "duration_ms");
    expect(duration.sampleSize).toBe(5);
    expect(duration.usableForSlo).toBe(false);
    expect(duration.note).toContain("wall clock");
    // …and nothing is proposed from it: the refusal is not decorative.
    for (const entry of calibration.proposed) {
      if (entry.status === "proposed" && entry.appliedTo) expect(entry.appliedTo.quantity).not.toBe("duration_ms");
    }
  });

  it("derives the step limit and the alert thresholds from measured statistics, with the headroom stated", () => {
    const calibration = buildSloCalibration({ report: reportOf(results), tasks });
    const steps = proposal(calibration, "code.agent.maxStepsPerRun");
    if (steps.status !== "proposed") throw new Error("the step limit was not proposed");
    // 4x the measured maximum (10), never a p95: a limit has to clear the largest legitimate run.
    expect(steps.value).toBe(40);
    expect(steps.basis).toBe("measured");
    expect(steps.appliedTo).toEqual({ quantity: "steps", statistic: "max", measured: 10, sampleSize: 5, headroomMultiplier: 4 });
    // The calibration only proposes a value: no turn limit ships by default.
    expect(DEFAULT_CODE_AGENT_LIMITS.maxStepsPerRun).toBe(0);

    const cost = proposal(calibration, "code.anomaly.costMedianMultiplier");
    if (cost.status !== "proposed") throw new Error("the cost multiplier was not proposed");
    // R1's own reference is kept, and what it DOES to the measured population is reported beside it.
    expect(cost.value).toBe(3);
    expect(cost.basis).toBe("r1_reference");
    expect(cost.appliedTo?.measured).toBe(0.000489);
    expect(cost.measuredEffect?.crossed).toBe(1); // only the 0.0018 task is above 3 x 0.000489 = 0.001467
    expect(cost.measuredEffect?.sampleSize).toBe(4);
    expect(cost.measuredEffect?.share).toBe(0.25);

    const turns = proposal(calibration, "code.anomaly.turnP95Multiplier");
    if (turns.status !== "proposed") throw new Error("the turn multiplier was not proposed");
    expect(turns.value).toBe(1);
    expect(turns.basis).toBe("measured");
    expect(turns.appliedTo?.measured).toBe(4);
    expect(turns.measuredEffect?.crossed).toBe(0); // nothing exceeds the measured p95 here

    // The population floor comes from the smallest group the sample really contains (one task per kind here),
    // never from a comfortable round number.
    const floor = proposal(calibration, "code.anomaly.minPopulationSamples");
    if (floor.status !== "proposed") throw new Error("the population floor was not proposed");
    expect(floor.value).toBe(3); // ceil(1 * 2.5), and never below 2
    expect(floor.appliedTo).toEqual({ quantity: "turns", statistic: "min_group_size", measured: 1, sampleSize: 7, headroomMultiplier: 2.5 });
    expect(floor.note).toContain("nearest-rank p95 equals the maximum");
    // With a group of two — the shape the shipped corpus has — the very same rule gives the shipped default.
    const withPairs = buildSloCalibration({
      report: reportOf(results),
      tasks: [taskOf("a", "bug_fix", "javascript"), taskOf("b", "bug_fix", "javascript"), taskOf("c", "feature", "python"), taskOf("d", "feature", "python"), taskOf("e", "feature", "python")],
    });
    const pairedFloor = withPairs.proposed.find((entry) => entry.target === "code.anomaly.minPopulationSamples")!;
    expect(pairedFloor.status === "proposed" ? pairedFloor.value : 0).toBe(DEFAULT_CODE_ANOMALY_THRESHOLDS.minPopulationSamples);
  });

  it("degrades exactly the thresholds whose measurement was removed, and only those", () => {
    const unpriced = results.map((entry) => ({ ...entry, costUsd: null }));
    const calibration = buildSloCalibration({ report: reportOf(unpriced), tasks });
    const cost = distribution(calibration, "cost_usd");
    expect(cost.sampleSize).toBe(0);
    expect(cost.median).toBeNull();
    expect(cost.unavailable).toBe("no_price_for_5_of_5_tasks");
    // The cost-derived threshold is refused…
    const costProposal = proposal(calibration, "code.anomaly.costMedianMultiplier");
    expect(costProposal.status).toBe("not_measured");
    expect(costProposal.value).toBeNull();
    expect(costProposal.status === "not_measured" ? costProposal.reason : "").toBe("cost_not_measured");
    // …while the thresholds that read something else keep their measured values.
    expect(proposedValue(calibration, "code.agent.maxStepsPerRun")).toBe(40);
    expect(proposedValue(calibration, "code.anomaly.turnP95Multiplier")).toBe(1);
  });

  it("turns every proposal into not_measured when there is no measurement at all", () => {
    const calibration = buildSloCalibration({ report: reportOf([]), tasks: [] });
    expect(calibration.corpus.tasks).toBe(0);
    for (const entry of calibration.overall) {
      expect(entry.sampleSize).toBe(0);
      expect(entry.median).toBeNull();
      expect(entry.p95).toBeNull();
      expect(typeof entry.unavailable).toBe("string");
      expect((entry.unavailable ?? "").length).toBeGreaterThan(0);
    }
    expect(calibration.byTaskType.every((group) => group.sampleSize === 0)).toBe(true);
    expect(calibration.proposed.length).toBeGreaterThan(0);
    // Not one threshold survives without a measurement: this is the "green by default" case, refused.
    for (const entry of calibration.proposed) {
      expect(entry.status).toBe("not_measured");
      expect(entry.value).toBeNull();
      expect(entry.status === "not_measured" ? entry.reason.length : 0).toBeGreaterThan(0);
    }
    // The R1 targets the corpus cannot measure stay listed even when the corpus is empty.
    expect(calibration.notMeasured.length).toBe(notMeasuredSloTargets().length);
  });

  it("states which R1 targets the corpus cannot measure, and why — never with a number in their place", () => {
    const targets = notMeasuredSloTargets();
    const codes = targets.map((entry) => entry.code);
    expect(codes).toEqual([
      "slo.sandbox_start_cold_p95",
      "slo.sandbox_start_warm_p95",
      "slo.queue_wait_p95",
      "slo.tool_error_rate",
      "slo.recovery_success_rate",
      "slo.provider_fallback_rate",
      "slo.run_latency_p95",
      "slo.cost_per_run_alert",
      "slo.approvals_share",
      "slo.quota_utilization",
    ]);
    for (const entry of targets) {
      // A reason names the mechanism and a source names where the number would come from; neither is a shrug.
      expect(entry.reason.length).toBeGreaterThan(40);
      expect(entry.source.length).toBeGreaterThan(10);
      expect(entry.target.length).toBeGreaterThan(5);
      expect(entry.unit.length).toBeGreaterThan(0);
      // The shape is closed: there is nowhere for an invented measurement to live. Every field is text, so a
      // numeric statistic cannot be smuggled into a target the corpus cannot measure; the R1 reference value may
      // (and must) appear inside `target`, which is exactly where an unconfirmed number belongs.
      expect(Object.keys(entry).sort()).toEqual(["code", "reason", "source", "target", "unit"]);
      for (const value of Object.values(entry)) expect(typeof value).toBe("string");
    }
    // The one the whole split exists for: R1's 5% has no sample to confirm it.
    const toolError = targets.find((entry) => entry.code === "slo.tool_error_rate")!;
    expect(toolError.reason).toContain("expectError");
    expect(toolError.target).toContain("5");

    const calibration = buildSloCalibration({ report: reportOf([result("a")]), tasks: [taskOf("a", "bug_fix", "javascript")] });
    for (const target of ["code.anomaly.toolErrorRate", "code.agent.maxRunMinutes", "code.runBudget.maxTokens", "code.runBudget.maxCostUsd", "code.agent.maxChangedFiles"]) {
      const entry = proposal(calibration, target);
      expect(entry.status).toBe("not_measured");
      expect(entry.value).toBeNull();
    }
    // R1's 5% is still the shipped threshold — unconfirmed, not discarded.
    expect(DEFAULT_CODE_ANOMALY_THRESHOLDS.toolErrorRate).toBe(0.05);
  });

  it("has one vocabulary of outcomes, so a proposal is either a number with a basis or a refusal with a reason", () => {
    const calibration = buildSloCalibration({ report: reportOf(results), tasks });
    expect(calibration.proposed.map((entry) => entry.target)).toEqual([
      "code.agent.maxStepsPerRun",
      "code.anomaly.costMedianMultiplier",
      "code.anomaly.turnP95Multiplier",
      "code.anomaly.minPopulationSamples",
      "code.anomaly.toolErrorRate",
      "code.agent.maxRunMinutes",
      "code.runBudget.maxTokens",
      "code.runBudget.maxCostUsd",
      "code.agent.maxChangedFiles",
    ]);
    for (const entry of calibration.proposed) {
      if (entry.status === "proposed") {
        expect(Number.isFinite(entry.value)).toBe(true);
        expect(["measured", "r1_reference"]).toContain(entry.basis);
        expect(entry.note.length).toBeGreaterThan(30);
      } else {
        expect(entry.value).toBeNull();
        expect(entry.reason.length).toBeGreaterThan(0);
        expect(entry.note.length).toBeGreaterThan(30);
      }
    }
    // The calibration is a pure function of its input: the same report gives byte-identical output.
    expect(buildSloCalibration({ report: reportOf(results), tasks })).toEqual(calibration);
  });

  it("proposes from an explicit distribution, so the rule can be exercised without a corpus", () => {
    const groups = buildSloCalibration({ report: reportOf(results), tasks }).byTaskType;
    const proposed = proposeSloThresholds(
      [distributionOf("steps", [2, 3], { source: "synthetic" })],
      groups,
      { cost_usd: [], turns: [], steps: [2, 3] },
    );
    expect(proposed.find((entry) => entry.target === "code.agent.maxStepsPerRun")).toEqual({
      target: "code.agent.maxStepsPerRun",
      status: "proposed",
      value: 12, // 4 x the measured maximum (3)
      unit: "steps",
      basis: "measured",
      appliedTo: { quantity: "steps", statistic: "max", measured: 3, sampleSize: 2, headroomMultiplier: 4 },
      measuredEffect: null,
      note: expect.stringContaining("4x the largest transcript"),
    });
    // The targets whose measurement is absent are refusals in the same call.
    const cost = proposed.find((entry) => entry.target === "code.anomaly.costMedianMultiplier")!;
    expect(cost.status).toBe("not_measured");
    expect(cost.status === "not_measured" ? cost.reason : "").toBe("cost_not_measured");
  });

  it("reads the harness's own report rather than the fixture text", () => {
    const source = readSource("apps/agent-api/src/code-slo-calibration.ts");
    // A calibration that parsed the corpus JSON itself would be a second runner and could disagree with the run.
    expect(source).not.toMatch(/readFileSync|node:fs/);
    expect(source).toMatch(/from "\.\/code-eval-harness"/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. Anomaly detection
// ---------------------------------------------------------------------------------------------------------

describe("security-gate: C14 anomaly detection — a run is never cleared by a rule that did not run", () => {
  const healthy = population({ costMedian: 0.000489, costN: 33, turnsP95: 3, turnsN: 33 });

  it("clears a run that is inside every measured threshold, and says which rules ran", () => {
    const verdict = evaluateCodeRunAnomaly(facts({ costUsd: 0.000489, turns: 3, toolCalls: 20, toolErrors: 1 }), healthy);
    expect(verdict.status).toBe("evaluated");
    expect(verdict.anomalous).toBe(false);
    expect(verdict.findings).toEqual([]);
    expect(verdict.notEvaluated).toEqual([]);
    expect(verdict.rulesEvaluated).toBe(CODE_ANOMALY_RULES.length);
  });

  it("fires on the measured cost threshold and not on the run that sits exactly on it", () => {
    const onThreshold = evaluateCodeRunAnomaly(facts({ costUsd: 0.001467 }), healthy); // 3 x 0.000489
    expect(onThreshold.anomalous).toBe(false);
    expect(CODES(onThreshold)).toEqual([]);

    const above = evaluateCodeRunAnomaly(facts({ costUsd: 0.001764 }), healthy);
    expect(above.status).toBe("evaluated");
    expect(above.anomalous).toBe(true);
    expect(CODES(above)).toEqual(["cost_above_median_multiple"]);
    expect(above.findings[0]!.observed).toBe(0.001764);
    expect(above.findings[0]!.threshold).toBe(0.001467);
    expect(above.findings[0]!.statistic).toEqual({ quantity: "cost_usd", name: "median", value: 0.000489, sampleSize: 33 });
  });

  it("fires above the measured p95 turns and not at it", () => {
    expect(evaluateCodeRunAnomaly(facts({ turns: 3 }), healthy).anomalous).toBe(false);
    const above = evaluateCodeRunAnomaly(facts({ turns: 4 }), healthy);
    expect(above.anomalous).toBe(true);
    expect(CODES(above)).toEqual(["turns_above_p95_multiple"]);
    expect(above.findings[0]!.threshold).toBe(3);
    expect(above.findings[0]!.statistic).toEqual({ quantity: "turns", name: "p95", value: 3, sampleSize: 33 });
  });

  it("fires above the configured tool error rate and not at it, with no population involved", () => {
    expect(evaluateCodeRunAnomaly(facts({ toolCalls: 20, toolErrors: 1 }), healthy).anomalous).toBe(false);
    const above = evaluateCodeRunAnomaly(facts({ toolCalls: 20, toolErrors: 2 }), healthy);
    expect(above.anomalous).toBe(true);
    expect(CODES(above)).toEqual(["tool_error_rate_above_threshold"]);
    expect(above.findings[0]!.observed).toBe(0.1);
    expect(above.findings[0]!.threshold).toBe(0.05);
    expect(above.findings[0]!.statistic).toBeNull();
  });

  it("refuses to judge a run when no rule could run: unavailable, and anomalous is null rather than false", () => {
    const empty = population({ costMedian: null, costN: 0, turnsP95: null, turnsN: 0 });
    const verdict = evaluateCodeRunAnomaly(facts({ costUsd: 9, turns: 99, toolCalls: 0, toolErrors: 0 }), empty);
    expect(verdict.status).toBe("unavailable");
    // The whole point: a run nothing could be compared against is NOT reported as normal.
    expect(verdict.anomalous).toBeNull();
    expect(verdict.rulesEvaluated).toBe(0);
    expect(verdict.findings).toEqual([]);
    expect(verdict.notEvaluated.map((entry) => entry.code)).toEqual([
      "cost_above_median_multiple",
      "turns_above_p95_multiple",
      "tool_error_rate_above_threshold",
    ]);
    expect(verdict.notEvaluated.map((entry) => entry.reason)).toEqual([
      "no_population_cost",
      "no_population_turns",
      "run_recorded_no_tool_calls",
    ]);
    for (const skip of verdict.notEvaluated) expect(skip.source.length).toBeGreaterThan(0);
  });

  it("refuses a population below the floor, because at that size a p95 is a maximum in disguise", () => {
    const tooSmall = population({ costMedian: 0.000489, costN: 2, turnsP95: 3, turnsN: 2 });
    const verdict = evaluateCodeRunAnomaly(facts({ costUsd: 999, turns: 99, toolCalls: 4, toolErrors: 0 }), tooSmall);
    // Two of three rules are refused even though both statistics are real numbers…
    expect(verdict.notEvaluated.map((entry) => entry.reason)).toEqual([
      "population_below_min_samples",
      "population_below_min_samples",
    ]);
    // …so the verdict is partial, not a clean bill of health.
    expect(verdict.status).toBe("partially_evaluated");
    expect(verdict.rulesEvaluated).toBe(1);
    expect(verdict.anomalous).toBe(false);
    // A stricter deployment (a floor of 2) would judge them, which is what makes the floor load-bearing.
    const allowed = evaluateCodeRunAnomaly(facts({ costUsd: 999, turns: 99 }), tooSmall, { ...DEFAULT_CODE_ANOMALY_THRESHOLDS, minPopulationSamples: 2 });
    expect(allowed.status).toBe("evaluated");
    expect(CODES(allowed)).toEqual(["cost_above_median_multiple", "turns_above_p95_multiple"]);
  });

  it("skips the cost rule for a run that recorded no cost, instead of reading it as free", () => {
    const verdict = evaluateCodeRunAnomaly(facts({ costUsd: null }), healthy);
    expect(verdict.status).toBe("partially_evaluated");
    expect(verdict.notEvaluated.map((entry) => entry.code)).toEqual(["cost_above_median_multiple"]);
    expect(verdict.notEvaluated[0]!.reason).toBe("run_recorded_no_cost");
    expect(verdict.anomalous).toBe(false);
    // A run that really is anomalous stays anomalous even with one rule missing.
    const alsoHigh = evaluateCodeRunAnomaly(facts({ costUsd: null, turns: 9 }), healthy);
    expect(alsoHigh.anomalous).toBe(true);
    expect(alsoHigh.status).toBe("partially_evaluated");
    expect(CODES(alsoHigh)).toEqual(["turns_above_p95_multiple"]);
  });

  it("builds the population with the shared rule, counting only the runs that reported a value", () => {
    const built = anomalyPopulationFrom({ costUsd: [0.001, null, 0.002, Number.NaN], turns: [1, 2, 3, 4], source: "synthetic window" });
    expect(built.cost.sampleSize).toBe(2);
    expect(built.cost.median).toBe(medianOf([0.001, 0.002]));
    expect(built.turns.sampleSize).toBe(4);
    expect(built.turns.p95).toBe(nearestRankPercentile([1, 2, 3, 4], 95));
    expect(built.cost.source).toContain("synthetic window");
    // Nothing to build from is `null` with a zero sample, never `0`.
    const empty = anomalyPopulationFrom({ costUsd: [null], turns: [], source: "synthetic window" });
    expect(empty.cost.median).toBeNull();
    expect(empty.cost.sampleSize).toBe(0);
    expect(empty.turns.p95).toBeNull();
    expect(empty.turns.sampleSize).toBe(0);
    // Whichever rule the two modules use, it is the same one.
    expect(built.cost.median).toBe(nearestRankPercentile([0.001, 0.002], 50));
  });

  it("maps the existing run summary onto the facts, and refuses a counter that cannot be true", () => {
    const mapped = codeRunAnomalyFactsFromSummary("run-7", { turns: 2, tokens: 170, toolCalls: 4, costUsd: 0.00099 }, 1);
    expect(mapped).toEqual({ runId: "run-7", turns: 2, tokens: 170, toolCalls: 4, toolErrors: 1, costUsd: 0.00099 });
    // A missing price stays missing; a negative or impossible error count is not allowed to lower the rate.
    expect(codeRunAnomalyFactsFromSummary("run-8", { turns: 1, tokens: 1, toolCalls: 3, costUsd: Number.NaN }, -5).costUsd).toBeNull();
    expect(codeRunAnomalyFactsFromSummary("run-8", { turns: 1, tokens: 1, toolCalls: 3, costUsd: Number.NaN }, -5).toolErrors).toBe(0);
    expect(codeRunAnomalyFactsFromSummary("run-9", { turns: 1, tokens: 1, toolCalls: 3, costUsd: 0 }, 7).toolErrors).toBe(3);
    expect(codeRunAnomalyFactsFromSummary("run-9", { turns: 1, tokens: 1, toolCalls: 3, costUsd: 0 }, 7).costUsd).toBe(0);
  });

  it("reads its thresholds from configuration, clamps them, and matches the values the calibration proposes", () => {
    expect(resolveCodeAnomalyThresholds({})).toEqual(DEFAULT_CODE_ANOMALY_THRESHOLDS);
    expect(DEFAULT_CODE_ANOMALY_THRESHOLDS.costMedianMultiplier).toBe(3); // R1 item 8
    expect(DEFAULT_CODE_ANOMALY_THRESHOLDS.toolErrorRate).toBe(0.05); // R1 item 8, unconfirmed by the corpus
    const parsed = resolveCodeAnomalyThresholds({
      NPATI_CODE_ANOMALY_COST_MULTIPLIER: "4",
      NPATI_CODE_ANOMALY_TURN_MULTIPLIER: "2",
      NPATI_CODE_ANOMALY_TOOL_ERROR_RATE: "0.01",
      NPATI_CODE_ANOMALY_MIN_POPULATION: "10",
    });
    expect(parsed).toEqual({ costMedianMultiplier: 4, turnP95Multiplier: 2, toolErrorRate: 0.01, minPopulationSamples: 10 });
    // A typo, a zero or a negative value falls back to the default rather than removing the bound.
    expect(resolveCodeAnomalyThresholds({ NPATI_CODE_ANOMALY_COST_MULTIPLIER: "abc" }).costMedianMultiplier).toBe(3);
    expect(resolveCodeAnomalyThresholds({ NPATI_CODE_ANOMALY_TURN_MULTIPLIER: "0" }).turnP95Multiplier).toBe(1);
    expect(resolveCodeAnomalyThresholds({ NPATI_CODE_ANOMALY_TOOL_ERROR_RATE: "-1" }).toolErrorRate).toBe(0.05);
    // …and a configured value can tighten or loosen an alert but never past the hard ceiling.
    const clamped = resolveCodeAnomalyThresholds({
      NPATI_CODE_ANOMALY_COST_MULTIPLIER: String(CODE_ANOMALY_MAX_COST_MULTIPLIER + 1),
      NPATI_CODE_ANOMALY_TURN_MULTIPLIER: String(CODE_ANOMALY_MAX_TURN_MULTIPLIER + 1),
      NPATI_CODE_ANOMALY_TOOL_ERROR_RATE: String(CODE_ANOMALY_MAX_TOOL_ERROR_RATE + 1),
      NPATI_CODE_ANOMALY_MIN_POPULATION: String(CODE_ANOMALY_MAX_POPULATION_SAMPLES + 1),
    });
    expect(clamped).toEqual({
      costMedianMultiplier: CODE_ANOMALY_MAX_COST_MULTIPLIER,
      turnP95Multiplier: CODE_ANOMALY_MAX_TURN_MULTIPLIER,
      toolErrorRate: CODE_ANOMALY_MAX_TOOL_ERROR_RATE,
      minPopulationSamples: CODE_ANOMALY_MAX_POPULATION_SAMPLES,
    });
  });

  it("keeps the shipped defaults equal to the calibrated proposals, on the same synthetic measurement", () => {
    const tasks = [
      taskOf("a", "bug_fix", "javascript"),
      taskOf("b", "bug_fix", "javascript"),
      taskOf("c", "feature", "python"),
      taskOf("d", "feature", "python"),
      taskOf("e", "feature", "python"),
    ];
    const results = [
      result("a", { steps: 10, turns: 1, costUsd: 0.000489 }),
      result("b", { steps: 3, turns: 2, costUsd: 0.000489 }),
      result("c", { steps: 3, turns: 3, costUsd: 0.000489 }),
      result("d", { steps: 3, turns: 3, costUsd: 0.001467 }),
      result("e", { steps: 3, turns: 4, costUsd: 0.001764 }),
    ];
    const calibration = buildSloCalibration({ report: reportOf(results), tasks });
    // The proposal and the configuration are the same number, so a default cannot drift from its calibration.
    expect(proposedValue(calibration, "code.anomaly.turnP95Multiplier")).toBe(DEFAULT_CODE_ANOMALY_THRESHOLDS.turnP95Multiplier);
    expect(calibration.proposed.find((entry) => entry.target === "code.anomaly.costMedianMultiplier")!.status === "proposed"
      ? (calibration.proposed.find((entry) => entry.target === "code.anomaly.costMedianMultiplier") as { value: number }).value
      : 0).toBe(DEFAULT_CODE_ANOMALY_THRESHOLDS.costMedianMultiplier);

    // The thresholds that measurement proposes, applied to the very population it measured, discriminate: the
    // measured population's own extreme is flagged by neither rule (max turns 4 vs p95 4 is not "above p95"
    // after the multiplier, and the cost rule needs 3x the median).
    const built = anomalyPopulationFrom({ costUsd: results.map((entry) => entry.costUsd), turns: results.map((entry) => entry.turns), source: "synthetic" });
    const verdict = evaluateCodeRunAnomaly(
      codeRunAnomalyFactsFromSummary("run-synthetic", { turns: 4, tokens: 83, toolCalls: 2, costUsd: 0.001764 }, 0),
      built,
      resolveCodeAnomalyThresholds({}),
    );
    expect(built.cost.median).toBe(0.000489);
    // 0.001764 > 3 x 0.000489 = 0.001467, so the run IS flagged — a checked rule, not a silent one.
    expect(verdict.status).toBe("evaluated");
    expect(verdict.anomalous).toBe(true);
    expect(CODES(verdict)).toEqual(["cost_above_median_multiple"]);
  });

  it("keeps the runtime detector out of the eval harness, and both on the one percentile rule", () => {
    const anomaly = readSource("apps/agent-api/src/code-anomaly-detection.ts");
    // A per-run detector has no business pulling the eval harness (and its corpus) into the API's runtime graph.
    expect(anomaly).not.toMatch(/code-eval-harness/);
    expect(anomaly).toMatch(/from "\.\/code-percentile"/);
    const percentile = readSource("apps/agent-api/src/code-percentile.ts");
    expect(percentile).toContain(CODE_PERCENTILE_METHOD);
    // The calibration reads the same rule rather than defining a second one.
    expect(readSource("apps/agent-api/src/code-slo-calibration.ts")).toMatch(/from "\.\/code-percentile"/);
  });
});
