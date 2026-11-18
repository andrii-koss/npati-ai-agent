/**
 * C14 (owner decision 4) — **SLO calibration**: the numbers the eval corpus really produced, the R1 targets the
 * corpus cannot produce, and the thresholds that follow from the first group.
 *
 * The owner's instruction was explicit: do not restate the R1 starting reference as if it had been calibrated.
 * Run the evals, take the real p95/median, and justify the budgets and thresholds with those numbers — and where
 * no number exists, say so instead of choosing one. This module is that separation, made mechanical, because a
 * prose table cannot be re-run and cannot fail:
 *
 *  1. **measured** — a quantity the corpus produces per task (`steps`, `turns`, `tool_calls`, `checks`,
 *     `tokens`, `cost_usd`, the three change-set counters, and the harness's wall clock). Each is a distribution
 *     over the sampled tasks with its `sampleSize`, `observationCount` and `source`, exactly like the step-3
 *     metrics: an empty sample has `sampleSize: 0`, every statistic `null` and a non-empty `unavailable` reason —
 *     **never `0`**, because `0 turns` reads as a measured fact and "we sampled nothing" does not.
 *  2. **not_measured** — an R1 SLO target the corpus has no source for (sandbox start, queue wait, tool error
 *     rate, recovery rate, provider fallback, run latency, approvals share, quota use, and the production
 *     per-run cost median the R1 cost alert is defined against). Each names **why** and where a real measurement
 *     would have to come from. These keep their R1 reference values in `docs/audit/coding-agent/PLAN.md` and are
 *     reported here as unconfirmed; nothing in this module invents a number for them.
 *  3. **proposed** — a threshold derived from a measured statistic with an explicitly stated headroom, or R1's
 *     own reference value **with the effect it has on the measured population** reported beside it. A proposal
 *     whose measurement is missing degrades to `not_measured` with a reason: a threshold that no measurement
 *     supports must not become "green by default".
 *
 * Two properties of the percentile rule are load-bearing and are stated rather than implied:
 *
 *  - the statistic is the **nearest-rank** percentile over the sorted sample. With 33 samples the 95th
 *    percentile is the 32nd value, never an interpolation between the 32nd and the 33rd, so a p95 is always a
 *    number some task really produced. For a small corpus that is the honest choice: an interpolated p95 would
 *    be a value nothing measured, and a `type: "linear"` p95 on a 2-sample group would be a fiction dressed as
 *    a statistic;
 *  - `sampleSize` is where the statistic came from and `observationCount` is how many items were looked at, so
 *    a p95 over 3 of 33 tasks (the rest reporting no price, say) is visible as such instead of reading as the
 *    whole corpus.
 *
 * The corpus is a **floor**, not a forecast, and every proposal says so: a corpus task is a 3-line fixture with
 * 2-7 tool calls, so a corpus maximum understates a real repository task by construction. That is why the
 * proposals below confirm the existing shipped defaults rather than replacing them with much smaller numbers
 * read off a toy distribution.
 */

import {
  EVAL_LANGUAGES,
  EVAL_TASK_KINDS,
  type EvalLanguage,
  type EvalReport,
  type EvalTask,
  type EvalTaskKind,
  type EvalTaskResult,
} from "./code-eval-harness";
import { CODE_PERCENTILE_METHOD, medianOf, nearestRankPercentile } from "./code-percentile";

/**
 * The persisted format of a calibration report (rule 13: a persisted format is versioned). The version moves
 * when a field a reader depends on changes shape, not when a new quantity is added to the measured list.
 */
export const SLO_CALIBRATION_SCHEMA_VERSION = 1;

/**
 * The one percentile rule. Named in the report so a reader can re-derive every number in it from the sample,
 * which is the whole point of a calibration artifact. The rule itself lives in `code-percentile.ts` and is
 * re-exported here because this module is where a reader looks for it.
 */
export const SLO_PERCENTILE_METHOD = CODE_PERCENTILE_METHOD;
export { medianOf, nearestRankPercentile };

/** The corpus quantities that are measured per task. Metadata about the corpus is not one of them. */
export const SLO_MEASURED_QUANTITIES = [
  "steps",
  "turns",
  "tool_calls",
  "checks",
  "tokens",
  "cost_usd",
  "diff_files",
  "diff_lines_added",
  "diff_lines_removed",
  "duration_ms",
] as const;
export type SloQuantity = (typeof SLO_MEASURED_QUANTITIES)[number];

export type SloUnit = "count" | "tokens" | "usd" | "ms";

/** Fixed units, so a reader never has to infer whether `cost_usd` is dollars or cents. */
export const SLO_QUANTITY_UNITS: Record<SloQuantity, SloUnit> = {
  steps: "count",
  turns: "count",
  tool_calls: "count",
  checks: "count",
  tokens: "tokens",
  cost_usd: "usd",
  diff_files: "count",
  diff_lines_added: "count",
  diff_lines_removed: "count",
  duration_ms: "ms",
};

/**
 * The quantities broken down by task kind and language. Deliberately shorter than
 * `SLO_MEASURED_QUANTITIES`: a group of two tasks has no meaningful p95 for a counter nobody alerts on, and
 * printing ten distributions per group would bury the four that matter.
 */
export const SLO_GROUPED_QUANTITIES = ["steps", "turns", "tokens", "cost_usd"] as const;
export type SloGroupedQuantity = (typeof SLO_GROUPED_QUANTITIES)[number];

/**
 * One measured quantity over one sample. `null` in every statistic means the sample was empty, and then
 * `unavailable` is present and non-empty. A statistic is never `0` standing in for "not measured".
 */
export interface SloDistribution {
  quantity: SloQuantity;
  unit: SloUnit;
  percentileMethod: typeof SLO_PERCENTILE_METHOD;
  /** Items that reported the quantity (for `cost_usd`: the tasks the price table could price). */
  sampleSize: number;
  /** Items the sample was drawn from, including ones that carried nothing usable. */
  observationCount: number;
  median: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  sum: number | null;
  /** The field the numbers came from, part of the answer rather than a comment. */
  source: string;
  /**
   * `false` when the number exists but must not be used as an SLO measurement; `note` then says why. The
   * harness's wall clock is the case this field exists for: it is a real measurement of the wrong thing.
   */
  usableForSlo: boolean;
  note?: string;
  /** Present exactly when `sampleSize` is `0`; says why nothing could be measured. */
  unavailable?: string;
}

/** One group's distributions, for the two breakdown axes the corpus declares metadata for. */
export interface SloTaskTypeGroup {
  taskType: EvalTaskKind;
  sampleSize: number;
  distributions: SloDistribution[];
}

export interface SloLanguageGroup {
  language: EvalLanguage;
  sampleSize: number;
  distributions: SloDistribution[];
}

/** An R1 SLO target the corpus cannot measure. `source` names where a real measurement has to come from. */
export interface NotMeasuredSlo {
  code: string;
  /** The R1 target as R1 states it, so the reference value stays visible and stays unconfirmed. */
  target: string;
  unit: string;
  /** Why the corpus has no sample for it — grounded in what the corpus actually does, not in a shrug. */
  reason: string;
  source: string;
}

/** The statistic a proposal was derived from. `min_group_size` is a sample *shape*, not a value. */
export type SloStatistic = "median" | "p95" | "max" | "sum" | "min_group_size";

export interface SloProposalBasis {
  quantity: SloQuantity;
  statistic: SloStatistic;
  /** The measured statistic the threshold was derived from or is applied to. */
  measured: number;
  sampleSize: number;
  /** The factor applied to `measured` to obtain `value`. `1` means "no headroom beyond the measurement". */
  headroomMultiplier: number;
}

/**
 * What a threshold does on the measured population: how many of the sampled items cross it. This is how a
 * threshold whose value is R1's reference (rather than the corpus's number) still gets checked *against* the
 * corpus instead of being restated — a reference that flags every task and one that flags none are both
 * visible here.
 */
export interface SloProposedEffect {
  crossed: number;
  sampleSize: number;
  /** `crossed / sampleSize`, rounded like every other ratio in the codebase. */
  share: number;
}

/**
 * A threshold, either derived from a measurement or refused for want of one. `basis` distinguishes the two
 * provenances of `value`, because "3x median" is an R1 decision *checked* against the corpus, not a number the
 * corpus produced.
 */
export type ProposedThreshold =
  | {
      target: string;
      status: "proposed";
      value: number;
      unit: string;
      basis: "measured" | "r1_reference";
      appliedTo: SloProposalBasis | null;
      measuredEffect: SloProposedEffect | null;
      note: string;
    }
  | {
      target: string;
      status: "not_measured";
      value: null;
      unit: string;
      reason: string;
      note: string;
    };

export interface SloCalibrationCorpus {
  tasks: number;
  passed: number;
  failed: number;
  steps: number;
  turns: number;
  checks: number;
  tokens: number;
  toolCalls: number;
  costUsd: number | null;
  costUnavailableTasks: number;
  diffStats: { files: number; linesAdded: number; linesRemoved: number };
}

export interface SloCalibrationReport {
  schemaVersion: number;
  mode: "recorded";
  percentileMethod: typeof SLO_PERCENTILE_METHOD;
  /** The eval aggregate the measurement was taken from, so the source of every number below is checkable. */
  corpus: SloCalibrationCorpus;
  /** Task results with no matching task, and therefore no kind or language: counted, never grouped silently. */
  unjoinedResults: number;
  overall: SloDistribution[];
  byTaskType: SloTaskTypeGroup[];
  byLanguage: SloLanguageGroup[];
  /** R1 targets with no corpus source. Kept beside the measurement so the split cannot be read past. */
  notMeasured: NotMeasuredSlo[];
  proposed: ProposedThreshold[];
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Builds one distribution. `values` holds only the items that reported the quantity; `observationCount` is how
 * many items were looked at, so a partial sample stays visible in the answer instead of reading as the whole.
 */
export function distributionOf(
  quantity: SloQuantity,
  values: readonly number[],
  options: {
    source: string;
    observationCount?: number;
    unavailable?: string;
    usableForSlo?: boolean;
    note?: string;
  },
): SloDistribution {
  const usable = values.filter((value) => Number.isFinite(value));
  const observationCount = options.observationCount ?? values.length;
  const usableForSlo = options.usableForSlo ?? true;
  if (!usable.length) {
    return {
      quantity,
      unit: SLO_QUANTITY_UNITS[quantity],
      percentileMethod: SLO_PERCENTILE_METHOD,
      sampleSize: 0,
      observationCount,
      median: null,
      p95: null,
      min: null,
      max: null,
      sum: null,
      source: options.source,
      usableForSlo,
      ...(options.note ? { note: options.note } : {}),
      unavailable: options.unavailable ?? `no_task_reported_${quantity}`,
    };
  }
  const sorted = [...usable].sort((left, right) => left - right);
  return {
    quantity,
    unit: SLO_QUANTITY_UNITS[quantity],
    percentileMethod: SLO_PERCENTILE_METHOD,
    sampleSize: usable.length,
    observationCount,
    median: round(medianOf(usable)!),
    p95: round(nearestRankPercentile(usable, 95)!),
    min: round(sorted[0]!),
    max: round(sorted[sorted.length - 1]!),
    sum: round(usable.reduce((total, value) => total + value, 0)),
    source: options.source,
    usableForSlo,
    ...(options.note ? { note: options.note } : {}),
  };
}

/** The measured values of one quantity across the results, plus how many results reported one. */
function valuesFor(results: readonly EvalTaskResult[], quantity: SloQuantity): { values: number[]; observations: number } {
  const values: number[] = [];
  for (const result of results) {
    switch (quantity) {
      case "steps":
        values.push(result.steps);
        break;
      case "turns":
        values.push(result.turns);
        break;
      case "tool_calls":
        values.push(result.toolCalls);
        break;
      case "checks":
        values.push(result.checks);
        break;
      case "tokens":
        values.push(result.tokens);
        break;
      case "cost_usd":
        // A task nobody could price is not a task that cost nothing: it is left out of the sample and counted
        // by the caller as an unpriced observation, exactly like the step-3 `cost_per_run` metric.
        if (result.costUsd !== null && Number.isFinite(result.costUsd)) values.push(result.costUsd);
        break;
      case "diff_files":
        values.push(result.diffStats.files);
        break;
      case "diff_lines_added":
        values.push(result.diffStats.linesAdded);
        break;
      case "diff_lines_removed":
        values.push(result.diffStats.linesRemoved);
        break;
      case "duration_ms":
        values.push(result.durationMs);
        break;
    }
  }
  return { values, observations: results.length };
}

/** The `source` string of an overall distribution: the harness field, and the run that filled it. */
function sourceOf(quantity: SloQuantity, report: EvalReport): string {
  const field: Record<SloQuantity, string> = {
    steps: "steps",
    turns: "turns",
    tool_calls: "toolCalls",
    checks: "checks",
    tokens: "tokens",
    cost_usd: "costUsd",
    diff_files: "diffStats.files",
    diff_lines_added: "diffStats.linesAdded",
    diff_lines_removed: "diffStats.linesRemoved",
    duration_ms: "durationMs",
  };
  return `runEvalSuite() -> EvalTaskResult.${field[quantity]} over ${report.totals.tasks} corpus tasks`;
}

/**
 * The note that keeps the harness's wall clock out of an SLO. The number is real and is reported; it is the
 * *interpretation* that would be wrong, so the refusal travels with the distribution instead of with a comment
 * in a report.
 */
const DURATION_NOTE =
  "process wall clock of an in-process, hermetic simulator (no sandbox, no network, no provider), and the "
  + "corpus suite deliberately does not pin it. It is a measurement of the harness, not of run latency.";

function distributionsFor(results: readonly EvalTaskResult[], report: EvalReport, quantities: readonly SloQuantity[]): SloDistribution[] {
  return quantities.map((quantity) => {
    const { values, observations } = valuesFor(results, quantity);
    const missing = quantity === "cost_usd" && values.length < observations
      ? `no_price_for_${observations - values.length}_of_${observations}_tasks`
      : undefined;
    return distributionOf(quantity, values, {
      source: sourceOf(quantity, report),
      observationCount: observations,
      ...(missing ? { unavailable: missing } : {}),
      ...(quantity === "duration_ms" ? { usableForSlo: false, note: DURATION_NOTE } : {}),
    });
  });
}

/**
 * The R1 SLO targets the corpus has no source for, in the order R1 lists them.
 *
 * Every `reason` names the mechanism, not a preference: the corpus runs no sandbox (`docker-sandbox-provider`
 * is not on the eval path), enqueues nothing (`CodeRunQueue` is not exercised by it), records no interrupted
 * run, calls no provider, pre-approves writes in its harness, and reports a wall clock rather than a latency.
 */
export function notMeasuredSloTargets(): NotMeasuredSlo[] {
  return [
    {
      code: "slo.sandbox_start_cold_p95",
      target: "sandbox startup p95 <= 20 s (cold)",
      unit: "seconds",
      reason:
        "the corpus executes every tool call in process: `docker-sandbox-provider.ts` is not on the eval path, "
        + "so no sandbox is started and no cold-start duration exists to sample",
      source: "the sandbox provider's own start timing (C1b), recorded per sandbox start",
    },
    {
      code: "slo.sandbox_start_warm_p95",
      target: "sandbox startup p95 <= 5 s (warm)",
      unit: "seconds",
      reason: "same as the cold start: the corpus starts no sandbox at all, warm or cold",
      source: "the sandbox provider's own start timing (C1b), recorded per sandbox start",
    },
    {
      code: "slo.queue_wait_p95",
      target: "queue wait p95 <= 30 s",
      unit: "seconds",
      reason:
        "the corpus drives `runEvalSuite` directly and never enqueues a run, so `CodeRunQueue` wait times are "
        + "absent from it (its bounds are covered by the c10 run-queue suites, which assert behaviour, not latency)",
      source: "queue wait measured where a run is enqueued and dequeued (`code-run-queue.ts`)",
    },
    {
      code: "slo.tool_error_rate",
      target: "tool error rate <= 5 %",
      unit: "ratio",
      reason:
        "a corpus task whose tool call fails for a reason the transcript did not declare is a FAILING task by "
        + "construction, so the shipped corpus contains no failing-call sample at all (0 of 80 calls, and no "
        + "`expectError` step in any of the 33 tasks). The observed rate is therefore 0 by design, not measured",
      source: "`code_activity_events` where `kind='code_tool_activity'` and `payload.ok=false` (step-3 metric)",
    },
    {
      code: "slo.recovery_success_rate",
      target: "recovery success >= 95 %",
      unit: "ratio",
      reason: "the corpus contains no interrupted run to recover, so there is no denominator for the rate",
      source: "interrupted runs and their recovery outcome (C6a reaper / C10 resume)",
    },
    {
      code: "slo.provider_fallback_rate",
      target: "alert when provider fallback rate > 20 % per hour",
      unit: "ratio",
      reason:
        "the corpus is a RECORDED transcript: it makes no provider call, so no fallback can occur in it "
        + "(`NPATI_CODE_EVAL_LIVE=1` would be needed, and the recorded suite refuses to pretend it ran one)",
      source: "provider routing outcomes per hour (provider fallback telemetry)",
    },
    {
      code: "slo.run_latency_p95",
      target: "p95 run latency",
      unit: "seconds",
      reason:
        "the corpus reports `durationMs`, but it is the process wall clock of a hermetic simulator with no "
        + "provider and no sandbox; the corpus suite states that it is not pinned because wall-clock time is not "
        + "a property of the corpus, so it cannot calibrate a latency SLO",
      source: "the run's own elapsed time in a real deployment (run lease/heartbeat records)",
    },
    {
      code: "slo.cost_per_run_alert",
      target: "alert when cost per run > 3x the median",
      unit: "usd",
      reason:
        "the median this rule is defined against is the median of PRODUCTION runs (`code_run_states.details."
        + "estimate.costUsd`); the corpus measures authored 2-7-call fixtures with a synthetic token split, so it "
        + "measures the shape of the rule, not the population it will run against",
      source: "`code_run_states.details.estimate.costUsd` (step-3 `cost_per_run` metric)",
    },
    {
      code: "slo.approvals_share",
      target: "share of approvals",
      unit: "ratio",
      reason:
        "the corpus harness pre-approves writes (`canonicalWriteExecutors({ approved: true })`) and measures the "
        + "loop, not the approval flow, so it records no `policy_decision` at all",
      source: "`code_activity_events` where `kind='policy_decision'` (step-3 `approvals_share` metric)",
    },
    {
      code: "slo.quota_utilization",
      target: "quota use",
      unit: "ratio",
      reason:
        "the corpus never draws on a session budget, so it records no consumption to compare with a limit; the "
        + "budget adapter's own enforcement is covered by the C12 quota suites",
      source: "`A2AQuotaManager` consumption against the configured session budget",
    },
  ];
}

/** The measured statistic of one quantity, or `null` when the sample was empty. */
function statisticOf(overall: readonly SloDistribution[], quantity: SloQuantity, statistic: SloStatistic): { value: number; sampleSize: number } | null {
  const distribution = overall.find((entry) => entry.quantity === quantity);
  if (!distribution) return null;
  if (statistic === "min_group_size") return null; // a group shape, handled by the caller
  const value = distribution[statistic];
  if (value === null) return null;
  return { value, sampleSize: distribution.sampleSize };
}

/** How many of a quantity's sampled values cross `threshold` — the measured effect of a proposed threshold. */
function effectOf(overall: readonly SloDistribution[], quantity: SloQuantity, threshold: number, values: readonly number[]): SloProposedEffect {
  const crossed = values.filter((value) => value > threshold).length;
  const sampleSize = overall.find((entry) => entry.quantity === quantity)?.sampleSize ?? values.length;
  return { crossed, sampleSize, share: sampleSize > 0 ? round(crossed / sampleSize) : 0 };
}

/**
 * The thresholds the measurement supports, and the ones it does not.
 *
 * Three rules of construction:
 *  - a limit that a run must not exceed is derived from the measured **maximum** (a p95 would cut off the
 *    largest legitimate task), an *alert* from the median or the p95;
 *  - the headroom factor is stated per entry and is never silent, so "40 turns" can be read as "4x the largest
 *    transcript the corpus contains" rather than as a number with no provenance;
 *  - a value whose measurement is missing comes back `not_measured` with the reason, which is the only
 *    behaviour that stops an uncalibrated threshold from looking calibrated.
 */
export function proposeSloThresholds(
  overall: readonly SloDistribution[],
  groups: readonly SloTaskTypeGroup[],
  sampleValues: { cost_usd: readonly number[]; turns: readonly number[]; steps: readonly number[] },
): ProposedThreshold[] {
  const proposed: ProposedThreshold[] = [];
  const notMeasured = (target: string, unit: string, reason: string, note: string): ProposedThreshold => ({
    target,
    status: "not_measured",
    value: null,
    unit,
    reason,
    note,
  });

  // 1. The step limit a run may not exceed. The shipped default is 40; the corpus's largest transcript is 10
  //    steps, so 40 is exactly 4x the measured maximum — the default is confirmed as sufficient for the corpus,
  //    and the corpus cannot confirm it for a real repository (which is why the value is not lowered to 4x10
  //    minus anything: it already IS 4x10).
  const stepsMax = statisticOf(overall, "steps", "max");
  proposed.push(
    stepsMax
      ? {
          target: "code.agent.maxStepsPerRun",
          status: "proposed",
          value: round(stepsMax.value * 4),
          unit: "steps",
          basis: "measured",
          appliedTo: { quantity: "steps", statistic: "max", measured: stepsMax.value, sampleSize: stepsMax.sampleSize, headroomMultiplier: 4 },
          measuredEffect: null,
          note:
            "4x the largest transcript measured (a limit must clear the largest legitimate run, not the p95). "
            + "The shipped default is exactly this number. A corpus task is a 3-line fixture, so this confirms "
            + "the default is above everything the corpus contains and does not bound a production repository.",
        }
      : notMeasured(
          "code.agent.maxStepsPerRun",
          "steps",
          "steps_not_measured",
          "no task reported a step count, so no step limit can be derived from the corpus",
        ),
  );

  // 2. The cost alert. R1 fixes the multiplier at 3x the median; the corpus cannot supply the median the rule
  //    will run against (that is a production population), but it CAN say what the rule does to a measured
  //    population — which is how a restated reference becomes a checked one.
  const costMedian = statisticOf(overall, "cost_usd", "median");
  const costMax = statisticOf(overall, "cost_usd", "max");
  const costEffect = costMedian ? effectOf(overall, "cost_usd", costMedian.value * 3, sampleValues.cost_usd) : null;
  proposed.push(
    costMedian && costMax && costEffect
      ? {
          target: "code.anomaly.costMedianMultiplier",
          status: "proposed",
          value: 3,
          unit: "multiple_of_median",
          basis: "r1_reference",
          appliedTo: { quantity: "cost_usd", statistic: "median", measured: costMedian.value, sampleSize: costMedian.sampleSize, headroomMultiplier: 3 },
          measuredEffect: costEffect,
          note:
            `R1's multiplier, kept, with the measured effect reported: on the corpus it flags `
            + `${costEffect.crossed} of ${costMedian.sampleSize} tasks, and the largest measured task is `
            + `${round(costMax.value / costMedian.value)}x the median. A rule that fires on the single largest `
            + `corpus task is discriminating rather than arbitrary, but the median it compares against must come `
            + `from production rows (see slo.cost_per_run_alert).`,
        }
      : notMeasured(
          "code.anomaly.costMedianMultiplier",
          "multiple_of_median",
          "cost_not_measured",
          "no task could be priced, so the alert's effect on a measured population is unknown and its multiplier is not checked",
        ),
  );

  // 3. The turn alert. No R1 number exists, so the measurement supplies it: alert above the measured p95, i.e.
  //    a multiplier of 1 against the p95. The effect on the corpus is reported for the same reason as above.
  const turnsP95 = statisticOf(overall, "turns", "p95");
  proposed.push(
    turnsP95
      ? {
          target: "code.anomaly.turnP95Multiplier",
          status: "proposed",
          value: 1,
          unit: "multiple_of_p95",
          basis: "measured",
          appliedTo: { quantity: "turns", statistic: "p95", measured: turnsP95.value, sampleSize: turnsP95.sampleSize, headroomMultiplier: 1 },
          measuredEffect: effectOf(overall, "turns", turnsP95.value * 1, sampleValues.turns),
          note:
            "R1 sets no turn alert, so the measured p95 supplies it: a multiplier of 1 places the alert exactly "
            + "at the 95th percentile (by definition ~5% of runs) instead of at an invented multiple. Headroom "
            + "above the p95 is not added, because the corpus p95 is a floor for a production run and inflating "
            + "it further would only make the alert quieter.",
        }
      : notMeasured(
          "code.anomaly.turnP95Multiplier",
          "multiple_of_p95",
          "turns_not_measured",
          "no task reported a turn count, so the alert cannot be placed on a measured percentile",
        ),
  );

  // 4. The population floor. At n=2 the nearest-rank p95 IS the maximum (rank = ceil(0.95*2) = 2), so a p95
  //    threshold over a group of two is a disguised maximum. The floor is therefore derived from the smallest
  //    group the corpus actually contains, not chosen for comfort.
  const smallestGroup = groups.reduce<number | null>((smallest, group) => {
    if (group.sampleSize === 0) return smallest;
    return smallest === null ? group.sampleSize : Math.min(smallest, group.sampleSize);
  }, null);
  proposed.push(
    smallestGroup !== null
      ? {
          target: "code.anomaly.minPopulationSamples",
          status: "proposed",
          value: Math.max(2, Math.ceil(smallestGroup * 2.5)),
          unit: "samples",
          basis: "measured",
          appliedTo: { quantity: "turns", statistic: "min_group_size", measured: smallestGroup, sampleSize: groups.length, headroomMultiplier: 2.5 },
          measuredEffect: null,
          note:
            `the smallest task-kind group the corpus contains has ${smallestGroup} tasks, and at that size the `
            + `nearest-rank p95 equals the maximum — so a p95-based alert over such a group would be a maximum in `
            + `disguise. The floor is set at 2.5x that group size, and a population below it makes the rule `
            + `report "not evaluated" instead of "not anomalous".`,
        }
      : notMeasured(
          "code.anomaly.minPopulationSamples",
          "samples",
          "no_grouped_sample",
          "no task kind carried a sample, so the smallest usable population size cannot be derived",
        ),
  );

  // 5. The tool-error alert. This is the entry the whole measured/not_measured split exists for: R1 has a
  //    number (5%), and the corpus has no sample, so the number stays an unconfirmed reference.
  proposed.push(
    notMeasured(
      "code.anomaly.toolErrorRate",
      "ratio",
      "tool_error_rate_not_measured",
      "R1's 5% is retained as an unconfirmed starting reference: the corpus contains no failing tool call to "
      + "measure a rate over (see slo.tool_error_rate), so neither 5% nor any other value can be justified by it.",
    ),
  );

  // 6. Run duration and budgets. The corpus has a wall clock and a per-task cost three orders of magnitude below
  //    the shipped budget; both are floors, and dressing a floor up as a budget would be the invented number the
  //    owner's instruction forbids.
  proposed.push(
    notMeasured(
      "code.agent.maxRunMinutes",
      "minutes",
      "run_latency_not_measured",
      "the corpus's `durationMs` is the wall clock of a hermetic in-process simulator (see slo.run_latency_p95), "
      + "so no minute budget can be derived from it; R1's starting value stands unconfirmed.",
    ),
  );
  proposed.push(
    notMeasured(
      "code.runBudget.maxTokens",
      "tokens",
      "production_budget_not_measured",
      "the corpus measures 2-7-call fixtures (max 308 tokens against a 100000-token budget), which is a floor "
      + "for a real repository task and cannot justify or refute the budget.",
    ),
  );
  proposed.push(
    notMeasured(
      "code.runBudget.maxCostUsd",
      "usd",
      "production_budget_not_measured",
      "the corpus's costliest task costs a fraction of a cent against a 1.00 USD budget, for the same reason as "
      + "the token budget: the corpus is a floor, not a production sample.",
    ),
  );
  proposed.push(
    notMeasured(
      "code.agent.maxChangedFiles",
      "files",
      "production_scope_not_measured",
      "the corpus's change sets are 1-4 fixture files; a scope warning for a real repository (the shipped 25) "
      + "cannot be calibrated from them and stays a starting reference.",
    ),
  );

  return proposed;
}

export interface BuildSloCalibrationInput {
  /** The real report `runEvalSuite` produced. The measurement is never re-derived from the fixture text. */
  report: EvalReport;
  /** The corpus the report was produced from, used only for the kind/language axes (joined by task id). */
  tasks?: readonly EvalTask[];
}

/**
 * The calibration. Pure: the same report and tasks give byte-identical output, so the suite that runs the corpus
 * can pin the numbers and a reader can re-derive them.
 */
export function buildSloCalibration(input: BuildSloCalibrationInput): SloCalibrationReport {
  const results = input.report.tasks;
  const taskById = new Map<string, EvalTask>();
  for (const task of input.tasks ?? []) taskById.set(task.id, task);
  let unjoinedResults = 0;
  for (const result of results) if (!taskById.has(result.id)) unjoinedResults += 1;

  const overall = distributionsFor(results, input.report, SLO_MEASURED_QUANTITIES);

  const byTaskType: SloTaskTypeGroup[] = EVAL_TASK_KINDS.map((taskType) => {
    const group = results.filter((result) => taskById.get(result.id)?.taskType === taskType);
    return {
      taskType,
      sampleSize: group.length,
      distributions: distributionsFor(group, input.report, SLO_GROUPED_QUANTITIES),
    };
  });

  const byLanguage: SloLanguageGroup[] = EVAL_LANGUAGES.map((language) => {
    const group = results.filter((result) => taskById.get(result.id)?.language === language);
    return {
      language,
      sampleSize: group.length,
      distributions: distributionsFor(group, input.report, SLO_GROUPED_QUANTITIES),
    };
  });

  const sampleValues = {
    cost_usd: valuesFor(results, "cost_usd").values,
    turns: valuesFor(results, "turns").values,
    steps: valuesFor(results, "steps").values,
  };

  return {
    schemaVersion: SLO_CALIBRATION_SCHEMA_VERSION,
    mode: "recorded",
    percentileMethod: SLO_PERCENTILE_METHOD,
    corpus: {
      tasks: input.report.totals.tasks,
      passed: input.report.totals.passed,
      failed: input.report.totals.failed,
      steps: input.report.totals.steps,
      turns: input.report.totals.turns,
      checks: input.report.totals.checks,
      tokens: input.report.totals.tokens,
      toolCalls: results.reduce((sum, result) => sum + result.toolCalls, 0),
      costUsd: input.report.totals.costUsd,
      costUnavailableTasks: input.report.totals.costUnavailableTasks,
      diffStats: input.report.totals.diffStats,
    },
    unjoinedResults,
    overall,
    byTaskType,
    byLanguage,
    notMeasured: notMeasuredSloTargets(),
    proposed: proposeSloThresholds(overall, byTaskType, sampleValues),
  };
}
