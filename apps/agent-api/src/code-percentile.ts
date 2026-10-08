/**
 * C14 — the one percentile rule of the coding agent, shared by the SLO calibration and the anomaly detector.
 *
 * It exists as its own module for one reason: two definitions of "the p95" would be two answers to "is this run
 * abnormal", and a threshold computed with one rule and a population with the other is worse than no threshold.
 * Everything here is a pure function over a sample of numbers.
 *
 * The rule is the **nearest-rank** percentile: sort the sample ascending and take the value at position
 * `ceil(p/100 * n)` (1-based, clamped to `n`). Nothing is interpolated. On a small sample — and the eval corpus
 * is 33 tasks — an interpolated p95 would be a number **no measurement produced**, and on a two-sample group it
 * would be the midpoint between the two, which is a statistic about arithmetic rather than about the system. A
 * reader can therefore always point at the task that produced a p95.
 */

/** The rule's name, carried in every report that uses it so the numbers can be re-derived. */
export const CODE_PERCENTILE_METHOD = "nearest_rank";

/**
 * The value at the nearest rank of `percentile`, or `null` when the sample is empty or the percentile is not in
 * `(0, 100]`. Non-finite entries are dropped rather than poisoning the sort, and `0` is never substituted for an
 * empty sample: "nothing measured" and "measured zero" are different claims.
 */
export function nearestRankPercentile(values: readonly number[], percentile: number): number | null {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) return null;
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  const sorted = [...usable].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index] ?? null;
}

/** The median under the very same rule, exported so no caller can quietly pick a different one. */
export function medianOf(values: readonly number[]): number | null {
  return nearestRankPercentile(values, 50);
}
