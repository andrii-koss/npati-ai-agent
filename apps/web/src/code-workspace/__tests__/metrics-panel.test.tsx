import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { CodeMetricsPanel, type CodeMetricsReportView } from "../CodeMetricsPanel";
import { en } from "../../i18n/locales/en";
import { uk } from "../../i18n/locales/uk";
import { de } from "../../i18n/locales/de";
import { fr } from "../../i18n/locales/fr";
import { es } from "../../i18n/locales/es";
import { it as itLocale } from "../../i18n/locales/it";
import { pl } from "../../i18n/locales/pl";

/**
 * [C14-web] the metrics panel.
 *
 * `environment: "node"` and no jsdom/@testing-library/react in this repository, so this suite asserts the two
 * things that are provable here and does not pretend to more:
 *
 *  1. **The dictionaries.** The panel renders through the app's `useTranslation`, so its labels come from the
 *     seven real dictionaries. Every one of them must carry the whole `codeMetrics` section — which
 *     `TranslationSchema` also enforces at compile time — and Ukrainian must be a real translation rather than a
 *     copy of English, since a missing key would otherwise fall back silently.
 *  2. **The rendering, driven by a report.** The markup is a pure function of the report it is handed, so
 *     `renderToStaticMarkup` proves the answer that matters most: a measured metric shows its number, and a
 *     metric with no source shows its **reason**, never a zero. Click-through testing needs a browser runner,
 *     which `vitest.web.config.ts` names as a deliberate follow-up rather than something skipped here.
 */

const REPORT: CodeMetricsReportView = {
  generatedAt: "2026-02-01T10:00:00.000Z",
  runs: { total: 4, byStatus: { completed: 3, failed: 1 } },
  truncated: false,
  eventLimit: 500,
  activityEventsWithoutOutcome: 0,
  metrics: [
    { kind: "success_rate", value: 0.75, unit: "ratio", source: "code_run_states.status", sampleSize: 4, observationCount: 4 },
    { kind: "avg_turns", value: 2.5, unit: "turns", source: "code_run_states.details.estimate.turns", sampleSize: 3, observationCount: 4, estimated: true },
    { kind: "failed_edit_rate", value: null, unit: "ratio", source: "code_activity_events kind=code_tool_activity", sampleSize: 0, observationCount: 0, unavailable: "no_edit_tool_events_in_window" },
    { kind: "approvals_share", value: 0.5, unit: "ratio", source: "code_activity_events kind=policy_decision", sampleSize: 2, observationCount: 2 },
    { kind: "tool_error_rate", value: 0, unit: "ratio", source: "code_activity_events kind=code_tool_activity", sampleSize: 7, observationCount: 7 },
    { kind: "cost_per_run", value: 0.0231, unit: "usd", source: "code_run_states.details.estimate.costUsd", sampleSize: 2, observationCount: 4, estimated: true },
  ],
};

const DICTIONARIES: Array<[string, typeof en]> = [
  ["en", en], ["uk", uk], ["de", de], ["fr", fr], ["es", es], ["it", itLocale], ["pl", pl],
];

/** The keys the panel reads; a missing one would render the raw key path instead of a label. */
const PANEL_KEYS = [
  "title", "subtitle", "loading", "empty", "unavailable", "successRate", "avgTurns", "failedEditRate",
  "approvalsShare", "toolErrorRate", "costPerRun", "sampleRuns", "sampleSize", "sampleWindow",
  "sampleTruncated", "estimated",
] as const;

/** A `t` over a real dictionary, exactly what `useTranslation` does — placeholders included. */
function translateWith(dictionary: typeof en): (key: string) => string {
  return (key: string) => {
    // The whole key, `codeMetrics.title` included: the provider's resolver walks the full dotted path, and a
    // helper that stripped the first segment would return the key itself and make every label assertion pass
    // vacuously against `codeMetrics.title`-shaped text.
    const path = key.split(".");
    let current: unknown = dictionary;
    for (const part of path) {
      if (!current || typeof current !== "object") return key;
      current = (current as Record<string, unknown>)[part];
    }
    return typeof current === "string" ? current : key;
  };
}

/** The component's own source, for the assertions this environment cannot make by rendering. */
function readSource(): string {
  return readFileSync(fileURLToPath(new URL("../CodeMetricsPanel.tsx", import.meta.url)), "utf8");
}

describe("[C14-web] metrics panel dictionaries and rendering", () => {
  it("carries the whole codeMetrics section in every shipped locale", () => {
    for (const [code, dictionary] of DICTIONARIES) {
      const section = dictionary.codeMetrics;
      expect(section, `${code} has no codeMetrics section`).toBeTruthy();
      for (const key of PANEL_KEYS) {
        const value = section[key];
        expect(typeof value, `${code}.codeMetrics.${key} is missing`).toBe("string");
        expect(value.length, `${code}.codeMetrics.${key} is empty`).toBeGreaterThan(0);
      }
      // The placeholders the panel substitutes have to survive translation, or the sample line would read
      // `runs: {{count}}` on screen.
      expect(section.sampleRuns).toContain("{{count}}");
      expect(section.sampleSize).toContain("{{count}}");
      expect(section.sampleTruncated).toContain("{{limit}}");
      // Ukrainian must be a translation, not a copy: the loop above would pass on a lazy English fallback. The
      // comparison skips English itself, which is identical to English by definition.
      if (code !== "en") expect(section.title).not.toBe(en.codeMetrics.title);
    }
    expect(uk.codeMetrics.successRate).toBe("Частка успішних прогонів");
    expect(uk.codeMetrics.unavailable).toBe("Недоступно");
  });

  it("renders the number a measured metric carries and the reason a missing one carries", () => {
    const markup = renderToStaticMarkup(React.createElement(CodeMetricsPanel, {
      companyId: "company-1",
      report: REPORT,
      // Called, not passed as a function: `translateWith(en)` builds the resolver over the English dictionary.
      t: translateWith(en),
    }));

    // Unit-aware formatting: a ratio as a percentage, an average as turns, a price as USD.
    expect(markup).toContain("75.00 %");
    expect(markup).toContain("2.50");
    expect(markup).toContain("$0.0231");
    // A measured zero is shown as the number zero, with its sample — `0 %` here means "none of the 7 recorded
    // tool calls failed", which is a measurement.
    expect(markup).toContain('data-metric="tool_error_rate" data-metric-state="ok"');
    expect(markup).toContain("0.00 %");
    // A metric with no source shows its reason instead — the whole point of the panel. The row carries no
    // percentage at all, so "unknown" can never be read as "zero".
    expect(markup).toContain('data-metric="failed_edit_rate" data-metric-state="unavailable"');
    expect(markup).toContain("no_edit_tool_events_in_window");
    const unavailableRow = markup.slice(markup.indexOf('data-metric="failed_edit_rate"'));
    expect(unavailableRow.slice(0, unavailableRow.indexOf("</li>"))).not.toContain("%");
    // The denominator travels with the number, so "75 %" cannot be read as "out of everything".
    expect(markup).toContain("sample: 4");
    expect(markup).toContain("sample: 0");
    // The estimate marker is rendered exactly where the server said the number is an estimate.
    expect(markup).toContain("estimated from the runner summary");
    // The counter each metric was computed from is named in the markup, not left to trust.
    expect(markup).toContain("code_run_states.details.estimate.costUsd");
    // Read-only surface: no control that could change a run, and no link out.
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("href=");
  });

  it("renders Ukrainian labels from the shipped dictionary", () => {
    const markup = renderToStaticMarkup(React.createElement(CodeMetricsPanel, {
      companyId: "company-1",
      report: REPORT,
      t: translateWith(uk),
    }));
    expect(markup).toContain("Метрики кодового агента");
    expect(markup).toContain("Частка успішних прогонів");
    expect(markup).toContain("Недоступно: no_edit_tool_events_in_window");
  });

  it("says when the Activity sample hit its cap instead of presenting a window as the history", () => {
    const truncated = renderToStaticMarkup(React.createElement(CodeMetricsPanel, {
      companyId: "company-1",
      report: { ...REPORT, truncated: true, eventLimit: 500 },
      t: translateWith(en),
    }));
    expect(truncated).toContain("newest 500 events only");
    const full = renderToStaticMarkup(React.createElement(CodeMetricsPanel, {
      companyId: "company-1",
      report: REPORT,
      t: translateWith(en),
    }));
    expect(full).toContain("full history");
    expect(full).not.toContain("events only");
  });

  it("marks the pending report without a visible loading message and guards the read request", () => {
    // The effect does not run under `renderToStaticMarkup`, so the first paint is the loading state; the request
    // itself is asserted on the component's own source, because this environment cannot click. That is the
    // honest split: formatting and failure states are render-tested, the wiring is source-guarded.
    const markup = renderToStaticMarkup(React.createElement(CodeMetricsPanel, { companyId: "company-1", t: translateWith(en) }));
    expect(markup).toContain('data-metrics-status="loading"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("Loading metrics...");

    const source = readSource();
    expect(source).toContain("/api/companies/${encodeURIComponent(companyId)}/code/metrics");
    // A read surface: the component must never issue a mutating request to this route.
    expect(source).not.toContain('method: "POST"');
    expect(source).not.toContain('method: "PUT"');
    expect(source).not.toContain('method: "DELETE"');
    expect(readSource().length).toBeGreaterThan(500);
  });
});
