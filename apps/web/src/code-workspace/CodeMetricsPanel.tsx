import React, { useContext, useEffect, useState } from "react";
import { I18nContextRef } from "../i18n";

/**
 * C14 (owner decision 3): the coding-agent metrics panel.
 *
 * It is a **reader**, nothing else. The six numbers arrive already aggregated from
 * `GET /api/companies/:companyId/code/metrics`, and this component does three things with them:
 *
 *   1. formats a ratio as a percentage, a turn count as an average and a price as USD;
 *   2. shows `unavailable: <reason>` when a metric has no source — it never prints a number the server did not
 *      measure. `—` is the placeholder, so `0 %` on screen always means "measured zero failures", never "we do
 *      not know";
 *   3. names the counter a metric was computed from (`source`) and its sample size, so "60 % success" can be
 *      read together with "out of 5 finished runs" instead of being taken on faith.
 *
 * It also states when the Activity sample hit its cap (`truncated`): rates over a bounded window are still real
 * rates, but presenting them as the whole history would not be. There is no control here that changes anything —
 * the route is a read, and a metrics surface that could mutate state would be a new way to change a run.
 */

export type CodeMetricUnit = "ratio" | "turns" | "usd";

export interface CodeMetricView {
  kind: string;
  value: number | null;
  unit: CodeMetricUnit;
  source: string;
  sampleSize: number;
  observationCount: number;
  estimated?: true;
  unavailable?: string;
}

export interface CodeMetricsReportView {
  generatedAt: string;
  runs: { total: number; byStatus: Record<string, number> };
  truncated: boolean;
  eventLimit: number;
  activityEventsWithoutOutcome: number;
  metrics: readonly CodeMetricView[];
}

interface MetricsEnvelope {
  status?: string;
  reason?: string;
  report?: CodeMetricsReportView | null;
  message?: string;
}

/** The i18n label of each metric. An unknown kind falls back to its own name, never to a guessed label. */
const METRIC_LABEL_KEY: Record<string, string> = {
  success_rate: "codeMetrics.successRate",
  avg_turns: "codeMetrics.avgTurns",
  failed_edit_rate: "codeMetrics.failedEditRate",
  approvals_share: "codeMetrics.approvalsShare",
  tool_error_rate: "codeMetrics.toolErrorRate",
  cost_per_run: "codeMetrics.costPerRun",
};

/** Percentages get two decimals: a rate of `1/3` must not render as `33 %` and read as an exact number. */
function formatValue(metric: CodeMetricView, unavailableLabel: string): string {
  if (metric.value === null || !Number.isFinite(metric.value)) {
    return `${unavailableLabel}: ${metric.unavailable ?? "unavailable"}`;
  }
  if (metric.unit === "ratio") return `${(metric.value * 100).toFixed(2)} %`;
  if (metric.unit === "turns") return metric.value.toFixed(2);
  return `$${metric.value.toFixed(4)}`;
}

function summary(report: CodeMetricsReportView, t: (key: string) => string): string {
  const runs = t("codeMetrics.sampleRuns").replace("{{count}}", String(report.runs.total));
  const window = report.truncated
    ? t("codeMetrics.sampleTruncated").replace("{{limit}}", String(report.eventLimit))
    : t("codeMetrics.sampleWindow");
  return `${runs} · ${window}`;
}

export interface CodeMetricsPanelProps {
  companyId: string;
  /** Injected for tests and composition; defaults to the browser `fetch`. */
  fetcher?: typeof fetch;
  /** Optional pre-fetched report (a test or a parent that already holds one); skips the request entirely. */
  report?: CodeMetricsReportView | null;
  /**
   * Optional label resolver. The default is the app's `useTranslation`, but the whole point of taking it as a
   * prop is that the markup becomes testable in the repository's Node-only web test project — there is no jsdom
   * here, so a component that could only be rendered under the provider could not be asserted at all.
   */
  t?: (key: string) => string;
}

export function CodeMetricsPanel({ companyId, fetcher, report: supplied, t: suppliedT }: CodeMetricsPanelProps): React.ReactElement {
  // The provider's own resolver, or the injected one. Reading the context (rather than `useTranslation`) keeps
  // the hook call unconditional, so the component stays renderable without a provider — which is the only way
  // this repository's Node-only web test project can assert its markup at all.
  const context = useContext(I18nContextRef);
  const t = suppliedT ?? context?.t ?? ((key: string) => key);
  const [fetched, setFetched] = useState<CodeMetricsReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(supplied === undefined);

  // A supplied report means the caller already fetched it (or the test wants the rendered output without a
  // network round trip), so the effect must not fire a second, competing read.
  useEffect(() => {
    if (supplied !== undefined) return;
    let active = true;
    setLoading(true);
    const send = fetcher ?? (typeof fetch === "function" ? fetch : null);
    if (!send) {
      setError("fetch_unavailable");
      setLoading(false);
      return;
    }
    void send(`/api/companies/${encodeURIComponent(companyId)}/code/metrics`, { headers: { accept: "application/json" } })
      .then(async (response) => {
        const payload = (await response.json()) as MetricsEnvelope;
        if (!active) return;
        if (!response.ok) {
          setError(payload?.reason ?? `HTTP ${response.status}`);
          setFetched(null);
          return;
        }
        // `status: "unavailable"` with no report is a real answer ("this deployment wired no source"), so it is
        // shown as such rather than as an empty table.
        setError(payload?.status === "ok" ? null : payload?.reason ?? "metrics_unavailable");
        setFetched(payload?.report ?? null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setFetched(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [companyId, fetcher, supplied]);

  const report = supplied !== undefined ? supplied : fetched;
  return (
    <section className="project-panel code-metrics" aria-label={t("codeMetrics.title")} data-metrics-status={error ? "error" : loading ? "loading" : "ok"}>
      <h2 className="ds-section-title">{t("codeMetrics.title")}</h2>
      <p className="ds-muted">{t("codeMetrics.subtitle")}</p>
      {error && <p className="ds-hint-error">{`${t("codeMetrics.unavailable")}: ${error}`}</p>}
      {!error && loading && <p className="ds-muted">{t("codeMetrics.loading")}</p>}
      {!error && !loading && !report && <p className="ds-muted">{t("codeMetrics.empty")}</p>}
      {report && (
        <>
          <p className="ds-muted" data-field="metrics-sample">{summary(report, t)}</p>
          <ul className="code-metrics-list">
            {report.metrics.map((metric) => (
              <li key={metric.kind} className="code-metrics-row" data-metric={metric.kind} data-metric-state={metric.value === null ? "unavailable" : "ok"}>
                <div className="code-metrics-head">
                  <span className="code-metrics-label">{METRIC_LABEL_KEY[metric.kind] ? t(METRIC_LABEL_KEY[metric.kind]!) : metric.kind}</span>
                  <strong className="code-metrics-value">{formatValue(metric, t("codeMetrics.unavailable"))}</strong>
                </div>
                <div className="ds-muted code-metrics-source">
                  <code>{metric.source}</code>
                  <span>
                    {` · ${t("codeMetrics.sampleSize").replace("{{count}}", String(metric.sampleSize))}`}
                    {metric.estimated ? ` · ${t("codeMetrics.estimated")}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
