/**
 * C14 (owner decision 3) — the Coding Agent metrics aggregation.
 *
 * Six numbers the owner asked for: **success rate, average turns, failed edit rate, approvals share, tool error
 * rate and cost/run**. Every one of them is computed from data the system **already** records, through two
 * narrow read ports over the rows that exist — no new table, no new column, no second record of what a run did:
 *
 * | metric              | source (field/event)                                                                     |
 * |---------------------|------------------------------------------------------------------------------------------|
 * | `success_rate`      | `code_run_states.status` (terminal `completed` ÷ (`completed` + `failed`))                 |
 * | `avg_turns`         | `code_run_states.details.estimate.turns` (the runner summary written with the terminal state) |
 * | `failed_edit_rate`  | `code_activity_events` `kind='code_tool_activity'` where `payload.ok === false` and `payload.tool` is a file-editing tool |
 * | `approvals_share`   | `code_activity_events` `kind='policy_decision'` where `payload.decision === 'require_approval'` |
 * | `tool_error_rate`   | `code_activity_events` `kind='code_tool_activity'` where `payload.ok === false`            |
 * | `cost_per_run`      | `code_run_states.details.estimate.costUsd` (the runner's own estimate, marked as such)     |
 *
 * Three rules decide the *shape* of every answer, and they are the reason this module exists as its own unit
 * rather than as a `COUNT(*)` somewhere:
 *
 * 1. **A metric with no source is `unavailable` with a reason — never `0`.** `0 %` reads as "nothing failed" and
 *    `$0.00` reads as "this was free"; both are claims the data does not support. `sampleSize` is `0` exactly
 *    when `value` is `null`, and `unavailable` is always non-empty then, so a reader can never mistake an
 *    absence for a measurement. The one deliberate exception is `success_rate: 0` when runs finished and none
 *    completed — that is a measurement ("every finished run failed"), and it carries a non-zero `sampleSize`.
 * 2. **A metric that mixes estimates with measurements says so.** `cost_per_run` and `avg_turns` come from the
 *    runner's persisted summary, which the loop fills from provider usage when it has it and from per-call
 *    constants when it does not; both carry `estimated: true` and name their source, exactly like
 *    `code-session-usage.ts` does. Nothing here re-derives a second number from that estimate.
 * 3. **A sample that hit its cap is reported as truncated.** `listCodeActivityEvents` returns at most `limit`
 *    rows, so the activity-derived metrics are rates **over the returned window**; `truncated: true` says the
 *    window was not the whole history, and `eventLimit` says what the cap was. Silently presenting a capped
 *    sample as a total would be the same lie as reporting an unknown price as `0`.
 *
 * The ports are narrow on purpose (the `CodeSessionUsageSourcePort` pattern): the aggregation is unit-testable
 * against synthetic rows with no Postgres, and a deployment that wires no reader gets `unavailable`, not zeros.
 */

/**
 * The metric names, in the order a report should show them.
 */

import type { CodeRunStateStatus } from "@npati/workspace";

/** The metric names, in the order a report should show them. */
export const CODE_METRIC_KINDS = [
  "success_rate",
  "avg_turns",
  "failed_edit_rate",
  "approvals_share",
  "tool_error_rate",
  "cost_per_run",
] as const;

export type CodeMetricKind = (typeof CODE_METRIC_KINDS)[number];

export type CodeMetricUnit = "ratio" | "turns" | "usd";

/**
 * One metric. `value === null` is the ONLY representation of "we could not measure this", and it is always
 * paired with a non-empty `unavailable` reason and `sampleSize === 0`. `source` names the field or event family
 * the number was computed from, so a reader never has to guess where it came from.
 */
export interface CodeMetricView {
  kind: CodeMetricKind;
  value: number | null;
  unit: CodeMetricUnit;
  /** File (or store table) and field/event the number was computed from. Part of the answer, not a comment. */
  source: string;
  /** How many observed items contributed — runs for the run metrics, events for the activity metrics. */
  sampleSize: number;
  /** Total observed items the metric applies to, including ones that carried nothing usable. */
  observationCount: number;
  /** `true` when the value is derived from the runner's summary rather than from provider metering. */
  estimated?: true;
  /** Present exactly when `value` is `null`; says why nothing could be measured. */
  unavailable?: string;
}

/** A bounded read of run rows and Activity rows for **one** tenant. Two reads, no writes. */
export interface CodeMetricsSourcePort {
  /**
   * The tenant's run rows. `companyId` is a required string with no system scope, so this read cannot be widened
   * into another tenant's history; the statuses and window are optional filters the store applies.
   *
   * `startedBefore` is declared even though the aggregation itself only narrows the window from the left today:
   * the port is a pass-through to the store read, and a pass-through that silently drops a bound it was handed is
   * the defect the window assertions exist to catch. Keeping the field here means the adapter cannot lose it
   * without the type checker saying so.
   */
  listRuns(input: {
    companyId: string;
    statuses?: readonly CodeRunStateStatus[];
    startedAfter?: Date;
    startedBefore?: Date;
    limit?: number;
  }): Promise<Array<{ status: string; startedAt: Date; details: Record<string, unknown> }>>;
  /** The tenant's Activity rows, newest first, bounded by `limit` (the store caps it as well). */
  listActivityEvents(input: { companyId: string; limit?: number }): Promise<Array<{ kind: string; payload: Record<string, unknown> }>>;
}

export interface CodeMetricsReport {
  companyId: string;
  /** When the aggregation ran (injected clock, so a test can pin it). */
  generatedAt: string;
  /** Counts of the run rows the run-derived metrics saw, by status. Statuses with no runs are absent. */
  runs: { total: number; byStatus: Record<string, number> };
  /** `true` when the Activity read returned exactly its limit, i.e. the sample is a window, not the history. */
  truncated: boolean;
  eventLimit: number;
  /** Events that carried no usable `ok`/`decision` field, counted rather than silently dropped. */
  activityEventsWithoutOutcome: number;
  metrics: CodeMetricView[];
}

export interface CollectCodeMetricsInput {
  companyId: string;
  /** Optional window start; applied to the run read (the Activity read is bounded by `limit` instead). */
  since?: Date | null;
  /** Run rows to read; clamped by the store. */
  runLimit?: number;
  /** Activity rows to read; clamped by the store. */
  eventLimit?: number;
}

/** `code_run_states.status` values that state an outcome. `running` is deliberately not one. */
const TERMINAL_SUCCESS: CodeRunStateStatus = "completed";
const TERMINAL_FAILURE: CodeRunStateStatus = "failed";
const TERMINAL_STATUSES: readonly CodeRunStateStatus[] = [TERMINAL_SUCCESS, TERMINAL_FAILURE, "cancelled", "interrupted"];

/** The five file-editing tools of the canonical registry (`code-tool-schemas.json`). Reads are not edits. */
const EDIT_TOOL = /\.(?:write|edit|apply_patch|move|delete)$/;
/** `code_tool_activity` payload key that states whether the tool call succeeded. */
const TOOL_OUTCOME_KEY = "ok";
/** `policy_decision` payload key carrying the verdict. */
const DECISION_KEY = "decision";
const REQUIRE_APPROVAL = "require_approval";

/**
 * Reads one number out of a run's `details` bag. Written as a walk over `unknown` on purpose: the bag is
 * JSON from the store, so every level is checked instead of asserted, and anything malformed is treated as
 * "not recorded" rather than coerced to `0`.
 */
function readRunEstimate(details: Record<string, unknown>): { turns: number | null; costUsd: number | null } {
  const raw = details?.estimate;
  if (!raw || typeof raw !== "object") return { turns: null, costUsd: null };
  const bag = raw as Record<string, unknown>;
  const turns = typeof bag.turns === "number" && Number.isFinite(bag.turns) && bag.turns >= 0 ? bag.turns : null;
  const costUsd = typeof bag.costUsd === "number" && Number.isFinite(bag.costUsd) && bag.costUsd >= 0 ? bag.costUsd : null;
  return { turns, costUsd };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Number((sum / values.length).toFixed(6));
}

function runMetric(
  kind: CodeMetricKind,
  input: {
    value: number | null;
    unavailable: string;
    sampleSize: number;
    observationCount: number;
    source: string;
    unit: CodeMetricUnit;
    estimated?: true;
  },
): CodeMetricView {
  return {
    kind,
    value: input.value,
    unit: input.unit,
    source: input.source,
    sampleSize: input.sampleSize,
    observationCount: input.observationCount,
    ...(input.estimated ? { estimated: true as const } : {}),
    ...(input.value === null ? { unavailable: input.unavailable } : {}),
  };
}

/**
 * The aggregation. Two reads, six metrics, and no `0` standing in for "unknown" anywhere.
 *
 * A read that throws is not an empty result: the caller gets `unavailable: "metrics_source_unreadable"` for the
 * metrics that read feeds, because "the store was down" and "there were no runs" must not look the same.
 */
export async function collectCodeMetrics(
  source: CodeMetricsSourcePort,
  input: CollectCodeMetricsInput,
  now: () => Date = () => new Date(),
): Promise<CodeMetricsReport> {
  const eventLimit = Math.max(1, Math.min(input.eventLimit ?? 500, 1000));
  const runLimit = input.runLimit ?? 500;

  // Reading is separated from deriving on purpose: a read that throws must not be confused with a read that
  // returned nothing, so the failure is carried as its own flag into every metric the read feeds.
  const runRead: { items: Array<{ status: string; startedAt: Date; details: Record<string, unknown> }>; failed: boolean } = { items: [], failed: false };
  try {
    runRead.items = await source.listRuns({
      companyId: input.companyId,
      statuses: TERMINAL_STATUSES,
      ...(input.since ? { startedAfter: input.since } : {}),
      limit: runLimit,
    });
  } catch {
    runRead.failed = true;
  }

  const activityRead: { items: Array<{ kind: string; payload: Record<string, unknown> }>; failed: boolean } = { items: [], failed: false };
  try {
    activityRead.items = await source.listActivityEvents({ companyId: input.companyId, limit: eventLimit });
  } catch {
    activityRead.failed = true;
  }

  const runs = runRead.items;
  const events = activityRead.items;

  const byStatus: Record<string, number> = {};
  const turnsValues: number[] = [];
  const costValues: number[] = [];
  let completed = 0;
  let failed = 0;

  for (const run of runs) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    if (run.status === TERMINAL_SUCCESS) completed += 1;
    if (run.status === TERMINAL_FAILURE) failed += 1;
    const estimate = readRunEstimate(run.details ?? {});
    if (estimate.turns !== null) turnsValues.push(estimate.turns);
    if (estimate.costUsd !== null) costValues.push(estimate.costUsd);
  }

  let toolEvents = 0;
  let toolErrors = 0;
  let editEvents = 0;
  let editFailures = 0;
  let approvalDecisions = 0;
  let approvalRequests = 0;
  let eventsWithoutOutcome = 0;
  let toolEventsWithoutOutcome = 0;

  for (const event of events) {
    const payload = event.payload ?? {};
    if (event.kind === "code_tool_activity") {
      toolEvents += 1;
      const outcome = payload[TOOL_OUTCOME_KEY];
      if (typeof outcome !== "boolean") {
        // The payload does not state an outcome. Counting it as a success would understate the error rate, so it
        // is counted separately and left out of both numerator and denominator.
        eventsWithoutOutcome += 1;
        toolEventsWithoutOutcome += 1;
        continue;
      }
      const tool = typeof payload.tool === "string" ? payload.tool : "";
      const isEdit = EDIT_TOOL.test(tool);
      if (isEdit) editEvents += 1;
      if (outcome === false) {
        toolErrors += 1;
        if (isEdit) editFailures += 1;
      }
      continue;
    }
    if (event.kind === "policy_decision") {
      const decision = payload[DECISION_KEY];
      if (typeof decision !== "string") {
        eventsWithoutOutcome += 1;
        continue;
      }
      approvalDecisions += 1;
      if (decision === REQUIRE_APPROVAL) approvalRequests += 1;
    }
  }

  const runObservation = runs.length;
  const finishedRuns = completed + failed;
  const toolObservation = toolEvents - toolEventsWithoutOutcome;
  const runsUnreadable = runRead.failed;
  const eventsUnreadable = activityRead.failed;

  const runReadFailure = "metrics_source_unreadable";
  const metrics: CodeMetricView[] = [
    runMetric("success_rate", {
      value: runsUnreadable || finishedRuns === 0 ? null : Number((completed / finishedRuns).toFixed(6)),
      unavailable: runsUnreadable ? runReadFailure : "no_finished_runs_in_window",
      // The denominator is the finished runs, not every run: a cancelled or still-running run is not evidence
      // either way, so it is excluded from the rate and visible in `runs.byStatus` instead.
      sampleSize: runsUnreadable ? 0 : finishedRuns,
      observationCount: runObservation,
      source: "code_run_states.status (completed / (completed + failed))",
      unit: "ratio",
    }),
    runMetric("avg_turns", {
      value: runsUnreadable ? null : mean(turnsValues),
      unavailable: runsUnreadable ? runReadFailure : "no_run_recorded_a_turn_count",
      sampleSize: turnsValues.length,
      observationCount: runObservation,
      source: "code_run_states.details.estimate.turns",
      unit: "turns",
      estimated: true,
    }),
    runMetric("failed_edit_rate", {
      value: eventsUnreadable ? null : editEvents > 0 ? Number((editFailures / editEvents).toFixed(6)) : null,
      unavailable: eventsUnreadable ? "metrics_source_unreadable" : "no_edit_tool_events_in_window",
      sampleSize: eventsUnreadable ? 0 : editEvents,
      observationCount: eventsUnreadable ? 0 : toolEvents,
      source: "code_activity_events kind=code_tool_activity (payload.tool is an editing tool, payload.ok=false)",
      unit: "ratio",
    }),
    runMetric("approvals_share", {
      value: eventsUnreadable ? null : approvalDecisions > 0 ? Number((approvalRequests / approvalDecisions).toFixed(6)) : null,
      unavailable: eventsUnreadable ? "metrics_source_unreadable" : "no_policy_decisions_in_window",
      sampleSize: eventsUnreadable ? 0 : approvalDecisions,
      observationCount: eventsUnreadable ? 0 : events.length,
      source: "code_activity_events kind=policy_decision (payload.decision='require_approval')",
      unit: "ratio",
    }),
    runMetric("tool_error_rate", {
      value: eventsUnreadable ? null : toolObservation > 0 ? Number((toolErrors / toolObservation).toFixed(6)) : null,
      unavailable: eventsUnreadable ? "metrics_source_unreadable" : "no_tool_activity_events_in_window",
      sampleSize: eventsUnreadable ? 0 : toolObservation,
      observationCount: eventsUnreadable ? 0 : toolEvents,
      source: "code_activity_events kind=code_tool_activity (payload.ok=false / readable tool events)",
      unit: "ratio",
    }),
    runMetric("cost_per_run", {
      value: runsUnreadable ? null : mean(costValues),
      unavailable: runsUnreadable ? runReadFailure : "no_run_recorded_a_cost",
      // The mean is over the runs that recorded a cost: dividing a known total by a run count that includes runs
      // with no recorded price would invent a cheaper number, which is the defect this module exists to avoid.
      sampleSize: costValues.length,
      observationCount: runObservation,
      source: "code_run_states.details.estimate.costUsd",
      unit: "usd",
      estimated: true,
    }),
  ];

  return {
    companyId: input.companyId,
    generatedAt: now().toISOString(),
    runs: { total: runObservation, byStatus },
    truncated: !eventsUnreadable && events.length >= eventLimit,
    eventLimit,
    activityEventsWithoutOutcome: eventsWithoutOutcome,
    metrics,
  };
}
