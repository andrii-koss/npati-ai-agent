import type { CodeSessionUsage } from "./code-session-control-routes";

/**
 * C7: token/cost accounting for a code session, taken from data that already exists.
 *
 * Two sources, and the difference between them is the whole point of this module:
 *
 *  1. **Measured** — the C6b replay bundle records the provider response **per model step**, including the usage
 *     the provider itself reported (`response.usage: { promptTokens, completionTokens, totalTokens }`). When a step
 *     carries it, the numbers are the provider's, `estimated` is `false`, and the source names the bundle.
 *     Price is still unknown there: provider responses carry token counts, not prices, and inferring a price from a
 *     table we do not maintain would be a fabricated number. `costUsd` stays `null` with an explicit reason.
 *  2. **Estimated** — the runner's own run summary (turns, tool calls, changed files, tokens and cost) is persisted
 *     with the terminal run state. It is **not** metering: the loop adds the provider's usage when present and falls
 *     back to estimated per-call constants when it is not, so the value is reported with `estimated: true` and
 *     `source: "runner_summary_estimate"`. A future provider-metered value arrives as `estimated: false` with a
 *     different source, so a caller can already tell them apart (rule 13).
 *
 * Three answers stay distinguishable, and none of them is `0`: `null` means nothing was ever recorded for the
 * session, `{ unavailable }` means a source exists but could not produce a measurement (with the reason), and a
 * usage object carries numbers with a marker saying whether they were measured or estimated.
 */
export interface RunEstimateView {
  tokenCount: number;
  costUsd: number | null;
  turns: number;
  toolCalls: number;
  filesChanged: number;
  diffStats: { files: number; linesAdded: number; linesRemoved: number };
  estimated: true;
  source: string;
}

export interface CodeSessionUsageSourcePort {
  listBundles(input: { companyId: string; sessionId: string; limit?: number }): Promise<Array<{ id: string; runId: string }>>;
  listSteps(companyId: string, bundleId: string): Promise<Array<{ kind: string; payload: Record<string, unknown> }>>;
  /** Reads the persisted runner estimate of one run, if it recorded one. */
  loadRunEstimate?(companyId: string, runId: string): Promise<RunEstimateView | null>;
}

/** `{ unavailable }` means "we could not measure it"; `null` means "nothing was ever recorded for this session". */
export type CodeSessionUsageResult = CodeSessionUsage | { unavailable: string };

interface RecordedUsage {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

function readUsage(payload: Record<string, unknown>): RecordedUsage | null {
  const response = payload?.response;
  if (!response || typeof response !== "object") return null;
  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const value = usage as RecordedUsage;
  const numbers = [value.totalTokens, value.promptTokens, value.completionTokens];
  if (!numbers.some((entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0)) return null;
  return value;
}

function positive(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Sums the recorded usage of every run of a session, preferring provider-measured numbers and falling back to the
 * runner's persisted estimate. Returns `null` when the session has no run data at all, `{ unavailable: reason }`
 * when data exists but carries no usable measurement, and real totals otherwise.
 */
export async function collectCodeSessionUsage(
  source: CodeSessionUsageSourcePort,
  input: { companyId: string; sessionId: string; runId?: string | null; limit?: number },
): Promise<CodeSessionUsageResult | null> {
  let bundles: Array<{ id: string; runId: string }>;
  try {
    bundles = await source.listBundles({ companyId: input.companyId, sessionId: input.sessionId, limit: input.limit ?? 200 });
  } catch {
    return { unavailable: "usage_source_unreadable" };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let reportedTotal = 0;
  let stepsWithUsage = 0;
  const runIds = new Set<string>();

  for (const bundle of bundles) {
    runIds.add(bundle.runId);
    let steps: Array<{ kind: string; payload: Record<string, unknown> }>;
    try {
      steps = await source.listSteps(input.companyId, bundle.id);
    } catch {
      // A partially readable history must not be reported as a smaller but "complete" total.
      return { unavailable: "usage_source_unreadable" };
    }
    for (const step of steps) {
      if (step.kind !== "model_step") continue;
      const usage = readUsage(step.payload);
      if (!usage) continue;
      const prompt = positive(usage.promptTokens);
      const completion = positive(usage.completionTokens);
      const total = positive(usage.totalTokens);
      inputTokens += prompt;
      outputTokens += completion;
      reportedTotal += total > 0 ? total : prompt + completion;
      stepsWithUsage += 1;
    }
  }

  if (stepsWithUsage > 0) {
    const total = reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens;
    return {
      tokens: { input: inputTokens, output: outputTokens, total },
      costUsd: null,
      runs: runIds.size,
      source: "code_replay_bundle_usage",
      // Measured, not estimated — the marker is present on both paths so a caller never has to guess.
      estimated: false,
      aggregation: "session_from_model_steps",
      costStatus: "unavailable",
      costReason: "no_cost_source_for_code_runs",
    };
  }

  // No provider-measured usage: fall back to the runner's persisted estimate, clearly marked as such.
  if (source.loadRunEstimate) {
    const candidates = new Set<string>(runIds);
    if (input.runId) candidates.add(input.runId);
    let estimatedRuns = 0;
    let tokens = 0;
    let cost = 0;
    let costKnown = false;
    let turns = 0;
    let toolCalls = 0;
    let filesChanged = 0;
    const diffStats = { files: 0, linesAdded: 0, linesRemoved: 0 };
    for (const runId of candidates) {
      let estimate: RunEstimateView | null;
      try {
        estimate = await source.loadRunEstimate(input.companyId, runId);
      } catch {
        return { unavailable: "usage_source_unreadable" };
      }
      if (!estimate) continue;
      estimatedRuns += 1;
      tokens += positive(estimate.tokenCount);
      turns += estimate.turns;
      toolCalls += estimate.toolCalls;
      filesChanged += estimate.filesChanged;
      diffStats.files += estimate.diffStats.files;
      diffStats.linesAdded += estimate.diffStats.linesAdded;
      diffStats.linesRemoved += estimate.diffStats.linesRemoved;
      if (typeof estimate.costUsd === "number" && Number.isFinite(estimate.costUsd)) {
        cost += estimate.costUsd;
        costKnown = true;
      }
    }
    if (estimatedRuns > 0) {
      return {
        // The estimate is a single total: splitting it into input/output would be inventing a measurement, so those
        // stay `null` and only the total is reported.
        tokens: { input: null, output: null, total: tokens },
        costUsd: costKnown ? Number(cost.toFixed(6)) : null,
        runs: estimatedRuns,
        source: "runner_summary_estimate",
        estimated: true,
        aggregation: "session_from_runner_summaries",
        turns,
        toolCalls,
        filesChanged,
        diffStats,
        ...(costKnown ? { costStatus: "ok" as const, costReason: "cost_is_an_estimate_not_a_measurement" } : { costStatus: "unavailable" as const, costReason: "no_cost_source_for_code_runs" }),
      };
    }
  }

  if (bundles.length === 0) return null;
  return { unavailable: "provider_did_not_report_usage" };
}
