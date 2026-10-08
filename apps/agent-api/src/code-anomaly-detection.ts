/**
 * C14 (owner decision 4) — **anomaly detection** over the run facts the system already records.
 *
 * The rule this module exists to enforce is not "detect anomalies"; it is "**never call a run normal when the
 * rule that would have caught it never ran**". Three rules are evaluated against two kinds of threshold:
 *
 * | rule                        | threshold                                              | source                          |
 * |-----------------------------|--------------------------------------------------------|---------------------------------|
 * | `cost_above_median_multiple`| `population.cost.median * costMedianMultiplier`         | population statistic + config   |
 * | `turns_above_p95_multiple`  | `population.turns.p95 * turnP95Multiplier`              | population statistic + config   |
 * | `tool_error_rate_above_threshold` | `toolErrorRate` (absolute)                        | config only                     |
 *
 * A rule whose input is missing does **not** silently pass. It is reported in `notEvaluated` with a reason, and
 * the verdict says what happened: `evaluated` (every rule ran), `partially_evaluated` (at least one ran, at
 * least one did not) or `unavailable` (no rule could run). `anomalous` is `null` exactly in the last case — an
 * unmeasurable run is neither anomalous nor normal, and `false` there would be the "green by default" defect
 * this shape is built to prevent.
 *
 * There is **no second ledger**. The run facts are `CodingAgentRunSummary`'s own fields — the same numbers the
 * runner persists as `code_run_states.details.estimate` and that the step-3 metrics aggregate — plus the
 * `code_tool_activity` failure count that the step-3 `tool_error_rate` metric already derives from Activity.
 * Nothing here re-counts a tool call, re-prices a token or opens a table.
 *
 * The thresholds are configuration, never literals in a rule: the defaults below are the values the corpus
 * calibration proposed (`code-slo-calibration.ts`), and the eval suite asserts that the two agree, so a default
 * cannot drift away from the measurement it claims to come from. Two of them the corpus could not calibrate
 * (`toolErrorRate`, which has no failing-call sample, and the multiplier that is R1's own reference) and they
 * say so in their own documentation instead of pretending otherwise.
 */

import type { CodingAgentRunSummary } from "./coding-agent-runner";
import { medianOf, nearestRankPercentile } from "./code-percentile";

/**
 * The thresholds, all configuration. They are the *shape* of the rule, not a population statistic: the
 * population (median cost, p95 turns) is passed in per evaluation, because it belongs to the data and not to
 * the deployment.
 */
export interface CodeAnomalyThresholds {
  /**
   * A run costing more than this multiple of the population's median cost is anomalous. Default 3 is R1 item 8's
   * own reference ("alert when cost per run > 3x the median"); the calibration reports the effect it has on the
   * measured corpus rather than claiming the corpus produced the multiplier.
   */
  costMedianMultiplier: number;
  /**
   * A run whose turn count exceeds this multiple of the population's p95 is anomalous. R1 sets no turn alert, so
   * the default (1) places the alert exactly on the measured p95 — a stated ~5% alert rate instead of an
   * invented multiple. No headroom above the p95 is added: the corpus p95 is a floor for a production run, and
   * inflating it further would only silence the alert.
   */
  turnP95Multiplier: number;
  /**
   * A run whose tool error rate exceeds this is anomalous. Default 0.05 is R1 item 8's reference and is
   * **unconfirmed by the corpus**: a corpus task whose tool call fails without declaring `expectError` is a
   * failing task by construction, so the shipped corpus contains no failing-call sample at all.
   */
  toolErrorRate: number;
  /**
   * The population size below which a population statistic is not used. At n=2 the nearest-rank p95 equals the
   * maximum, so a p95 threshold over two samples is a maximum in disguise; the calibration derived the default
   * (5) from the smallest task-kind group the corpus actually contains (2 tasks).
   */
  minPopulationSamples: number;
}

/** The shipped defaults. Every one is either a measured proposal or an unconfirmed R1 reference — never a guess. */
export const DEFAULT_CODE_ANOMALY_THRESHOLDS: CodeAnomalyThresholds = {
  costMedianMultiplier: 3,
  turnP95Multiplier: 1,
  toolErrorRate: 0.05,
  minPopulationSamples: 5,
};

/**
 * Hard ceilings, in the same idiom as `code-run-quota.ts`: configuration may make an alert stricter or looser up
 * to a point, and a typo cannot remove the bound altogether (`0` would either alert on everything or, for a
 * rate, never fire at all).
 */
export const CODE_ANOMALY_MAX_COST_MULTIPLIER = 100;
export const CODE_ANOMALY_MAX_TURN_MULTIPLIER = 100;
export const CODE_ANOMALY_MAX_TOOL_ERROR_RATE = 1;
export const CODE_ANOMALY_MAX_POPULATION_SAMPLES = 1_000;

function positive(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads the thresholds from the environment, clamping every value. The keys mirror the config table. */
export function resolveCodeAnomalyThresholds(env: NodeJS.ProcessEnv = process.env): CodeAnomalyThresholds {
  return {
    costMedianMultiplier: Math.min(
      positive(env.NPATI_CODE_ANOMALY_COST_MULTIPLIER, DEFAULT_CODE_ANOMALY_THRESHOLDS.costMedianMultiplier),
      CODE_ANOMALY_MAX_COST_MULTIPLIER,
    ),
    turnP95Multiplier: Math.min(
      positive(env.NPATI_CODE_ANOMALY_TURN_MULTIPLIER, DEFAULT_CODE_ANOMALY_THRESHOLDS.turnP95Multiplier),
      CODE_ANOMALY_MAX_TURN_MULTIPLIER,
    ),
    toolErrorRate: Math.min(
      positive(env.NPATI_CODE_ANOMALY_TOOL_ERROR_RATE, DEFAULT_CODE_ANOMALY_THRESHOLDS.toolErrorRate),
      CODE_ANOMALY_MAX_TOOL_ERROR_RATE,
    ),
    minPopulationSamples: Math.min(
      positive(env.NPATI_CODE_ANOMALY_MIN_POPULATION, DEFAULT_CODE_ANOMALY_THRESHOLDS.minPopulationSamples),
      CODE_ANOMALY_MAX_POPULATION_SAMPLES,
    ),
  };
}

/** The three rules, as a closed vocabulary: a finding or a skip always names one of these. */
export const CODE_ANOMALY_RULES = [
  "cost_above_median_multiple",
  "turns_above_p95_multiple",
  "tool_error_rate_above_threshold",
] as const;
export type CodeAnomalyRule = (typeof CODE_ANOMALY_RULES)[number];

/**
 * The measured facts of one run. The first four are `CodingAgentRunSummary` fields (the ones the runner
 * persists as the run's `estimate`); `toolErrors` is the `code_tool_activity` failure count of the same run,
 * which is what the step-3 `tool_error_rate` metric counts. `costUsd` is `null` when the run recorded no cost —
 * never `0`, because "free" and "unknown" must stay distinguishable.
 */
export interface CodeRunAnomalyFacts {
  runId: string;
  turns: number;
  tokens: number;
  toolCalls: number;
  toolErrors: number;
  costUsd: number | null;
}

/**
 * The population a run is compared against. Both statistics are optional, and both carry their own
 * `sampleSize` and `source`, so a comparison can always be traced to the sample it used — and a missing or too
 * small sample is a refusal rather than a default.
 */
export interface CodeAnomalyPopulation {
  cost: { median: number | null; sampleSize: number; source: string };
  turns: { p95: number | null; sampleSize: number; source: string };
}

/** One rule that fired. `threshold` is the number the run was compared against, not a restatement of the rule. */
export interface CodeAnomalyFinding {
  code: CodeAnomalyRule;
  observed: number;
  threshold: number;
  /** The population statistic behind the threshold, absent when the threshold is absolute configuration. */
  statistic: { quantity: "cost_usd" | "turns"; name: "median" | "p95"; value: number; sampleSize: number } | null;
  detail: string;
}

/** One rule that could not run. A skip is a *result*, not an absence: it says the run was not cleared. */
export interface CodeAnomalySkipped {
  code: CodeAnomalyRule;
  reason: string;
  source: string;
}

export type CodeAnomalyStatus = "evaluated" | "partially_evaluated" | "unavailable";

export interface CodeAnomalyVerdict {
  runId: string;
  status: CodeAnomalyStatus;
  /** `null` exactly when no rule could run: an unmeasurable run is neither anomalous nor normal. */
  anomalous: boolean | null;
  findings: CodeAnomalyFinding[];
  notEvaluated: CodeAnomalySkipped[];
  /** How many of the three rules actually ran, so `status` is checkable without counting the arrays. */
  rulesEvaluated: number;
  thresholds: CodeAnomalyThresholds;
}

/**
 * Maps the run's own summary onto the facts this module judges. It exists so there is exactly one place that
 * says which summary field is which fact, and so no caller can invent a sixth number: `toolErrors` has to be
 * supplied from the Activity counter the step-3 metric already uses, because the run summary does not carry it.
 */
export function codeRunAnomalyFactsFromSummary(
  runId: string,
  summary: Pick<CodingAgentRunSummary, "turns" | "tokens" | "toolCalls" | "costUsd">,
  toolErrors: number,
): CodeRunAnomalyFacts {
  return {
    runId,
    turns: summary.turns,
    tokens: summary.tokens,
    toolCalls: summary.toolCalls,
    // A negative or non-finite counter is treated as "nothing recorded" rather than as a negative error count,
    // which would silently raise the observed rate below zero.
    toolErrors: Number.isFinite(toolErrors) && toolErrors > 0 ? Math.min(Math.trunc(toolErrors), summary.toolCalls) : 0,
    // `null` stays `null`; a non-finite number is not a price and is reported as "no cost recorded" instead of
    // being coerced into one.
    costUsd: summary.costUsd !== null && Number.isFinite(summary.costUsd) && summary.costUsd >= 0 ? summary.costUsd : null,
  };
}

function populationUsable(sampleSize: number, value: number | null, minSamples: number): boolean {
  return value !== null && Number.isFinite(value) && sampleSize >= minSamples;
}

/**
 * Judges one run against the two populations and the absolute rate threshold.
 *
 * Exported as a pure function on purpose: the rules, the refusals and the resulting `status` are decidable in a
 * unit test with no store, no runner and no clock, which is what makes "the rule really fires" and "the rule
 * really refuses" provable instead of plausible.
 */
export function evaluateCodeRunAnomaly(
  facts: CodeRunAnomalyFacts,
  population: CodeAnomalyPopulation,
  thresholds: CodeAnomalyThresholds = DEFAULT_CODE_ANOMALY_THRESHOLDS,
): CodeAnomalyVerdict {
  const findings: CodeAnomalyFinding[] = [];
  const notEvaluated: CodeAnomalySkipped[] = [];

  // Rule 1 — cost against the population median.
  const costThreshold = population.cost.median === null ? null : population.cost.median * thresholds.costMedianMultiplier;
  if (facts.costUsd === null) {
    notEvaluated.push({
      code: "cost_above_median_multiple",
      reason: "run_recorded_no_cost",
      source: "the run's own summary (`costUsd` is null: not priced, which is not the same as free)",
    });
  } else if (!populationUsable(population.cost.sampleSize, population.cost.median, thresholds.minPopulationSamples)) {
    notEvaluated.push({
      code: "cost_above_median_multiple",
      reason: population.cost.median === null ? "no_population_cost" : "population_below_min_samples",
      source: population.cost.source,
    });
  } else if (costThreshold !== null && facts.costUsd > costThreshold) {
    findings.push({
      code: "cost_above_median_multiple",
      observed: facts.costUsd,
      threshold: Number(costThreshold.toFixed(6)),
      statistic: { quantity: "cost_usd", name: "median", value: population.cost.median!, sampleSize: population.cost.sampleSize },
      detail: `cost ${facts.costUsd} exceeds ${thresholds.costMedianMultiplier}x the population median cost (${population.cost.median})`,
    });
  }

  // Rule 2 — turns against the population p95.
  const turnThreshold = population.turns.p95 === null ? null : population.turns.p95 * thresholds.turnP95Multiplier;
  if (!populationUsable(population.turns.sampleSize, population.turns.p95, thresholds.minPopulationSamples)) {
    notEvaluated.push({
      code: "turns_above_p95_multiple",
      reason: population.turns.p95 === null ? "no_population_turns" : "population_below_min_samples",
      source: population.turns.source,
    });
  } else if (turnThreshold !== null && facts.turns > turnThreshold) {
    findings.push({
      code: "turns_above_p95_multiple",
      observed: facts.turns,
      threshold: Number(turnThreshold.toFixed(6)),
      statistic: { quantity: "turns", name: "p95", value: population.turns.p95!, sampleSize: population.turns.sampleSize },
      detail: `turns ${facts.turns} exceed ${thresholds.turnP95Multiplier}x the population p95 turns (${population.turns.p95})`,
    });
  }

  // Rule 3 — the run's own tool error rate against absolute configuration. No population is involved, so this
  // rule runs whenever the run reported at least one tool call; its threshold is the entry the corpus could not
  // calibrate, and it is still enforced rather than skipped.
  if (facts.toolCalls <= 0) {
    notEvaluated.push({
      code: "tool_error_rate_above_threshold",
      reason: "run_recorded_no_tool_calls",
      source: "the run's own summary (`toolCalls`)",
    });
  } else {
    const rate = Number((facts.toolErrors / facts.toolCalls).toFixed(6));
    if (rate > thresholds.toolErrorRate) {
      findings.push({
        code: "tool_error_rate_above_threshold",
        observed: rate,
        threshold: thresholds.toolErrorRate,
        statistic: null,
        detail: `tool error rate ${rate} (${facts.toolErrors}/${facts.toolCalls}) exceeds the configured threshold ${thresholds.toolErrorRate}`,
      });
    }
  }

  const rulesEvaluated = CODE_ANOMALY_RULES.length - notEvaluated.length;
  const status: CodeAnomalyStatus = rulesEvaluated === CODE_ANOMALY_RULES.length
    ? "evaluated"
    : rulesEvaluated === 0
      ? "unavailable"
      : "partially_evaluated";

  return {
    runId: facts.runId,
    status,
    anomalous: rulesEvaluated === 0 ? null : findings.length > 0,
    findings,
    notEvaluated,
    rulesEvaluated,
    thresholds,
  };
}

/**
 * The population statistics of a set of runs, over the same fields the rules compare against. This is the one
 * place a population is built, so a caller cannot hand the rules a mean where a median is documented: the
 * nearest-rank rule is imported from `code-percentile.ts` — the same rule the SLO calibration uses — rather than
 * re-implemented here, and an empty or all-unpriced sample yields `null` with its `sampleSize`, never `0`.
 */
export function anomalyPopulationFrom(values: { costUsd: readonly (number | null)[]; turns: readonly number[]; source: string }): CodeAnomalyPopulation {
  const priced = values.costUsd.filter((value): value is number => value !== null && Number.isFinite(value));
  const turns = values.turns.filter((value) => Number.isFinite(value));
  return {
    cost: {
      median: medianOf(priced),
      sampleSize: priced.length,
      source: `${values.source} (costUsd of runs that recorded a price)`,
    },
    turns: {
      p95: nearestRankPercentile(turns, 95),
      sampleSize: turns.length,
      source: `${values.source} (turns of runs that recorded a turn count)`,
    },
  };
}
