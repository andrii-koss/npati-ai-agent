interface QaIssue {
  id: string;
  type: string;
  message: string;
  severity?: string;
}

interface QaScreenshot {
  name: string;
  base64Data: string;
  viewport: { width: number; height: number };
}

interface QaReport {
  id: string;
  status: string;
  createdAt: string;
  summary?: string;
  metrics?: {
    loadTimeMs?: number;
    consoleErrorsCount?: number;
    brokenLinksCount?: number;
    a11yViolationsCount?: number;
  };
  issues?: QaIssue[];
  screenshots?: QaScreenshot[];
}

interface QaTabProps {
  language: string;
  qaPath: string;
  setQaPath: (v: string) => void;
  qaViewport: "desktop" | "tablet" | "mobile";
  setQaViewport: (v: "desktop" | "tablet" | "mobile") => void;
  handleRunQa: () => void;
  runningQa: boolean;
  loadQaReports: () => void;
  loadingQa: boolean;
  qaFeedback: string;
  qaReports: QaReport[];
  activeQaReport: QaReport | null;
  openQaReport: (id: string) => void;
  qaIssueFilter: string;
  setQaIssueFilter: (v: string) => void;
}

export function QaTab({
  language,
  qaPath,
  setQaPath,
  qaViewport,
  setQaViewport,
  handleRunQa,
  runningQa,
  loadQaReports,
  loadingQa,
  qaFeedback,
  qaReports,
  activeQaReport,
  openQaReport,
  qaIssueFilter,
  setQaIssueFilter,
}: QaTabProps) {
  return (
    <div className="qa-tab-pane">
      <div className="qa-toolbar">
        <label>
          {language === "uk" ? "Шлях" : "Path"}
          <input value={qaPath} onChange={(event) => setQaPath(event.target.value)} placeholder="/" />
        </label>
        <label>
          {language === "uk" ? "Екран" : "Viewport"}
          <select value={qaViewport} onChange={(event) => setQaViewport(event.target.value as typeof qaViewport)}>
            <option value="desktop">Desktop</option>
            <option value="tablet">Tablet</option>
            <option value="mobile">Mobile</option>
          </select>
        </label>
        <button type="button" className="button-primary" onClick={handleRunQa} disabled={runningQa}>
          {runningQa
            ? language === "uk"
              ? "Перевірка…"
              : "Inspecting…"
            : language === "uk"
            ? "Запустити Browser QA"
            : "Run Browser QA"}
        </button>
        <button type="button" className="button-secondary" onClick={loadQaReports} disabled={loadingQa}>
          {language === "uk" ? "Оновити" : "Refresh"}
        </button>
      </div>
      <p className="activity-hint">
        {language === "uk"
          ? "Спочатку запустіть Preview. Знімок показує лише розташування елементів."
          : "Start Preview first. The screenshot shows element layout only."}
      </p>
      {qaFeedback && <p role="status">{qaFeedback}</p>}
      <div className="qa-report-layout">
        <div className="qa-report-list">
          {qaReports.length === 0 ? (
            <p>{language === "uk" ? "Звітів ще немає." : "No reports yet."}</p>
          ) : (
            qaReports.map((report) => (
              <button
                key={report.id}
                type="button"
                className={activeQaReport?.id === report.id ? "button-secondary active" : "button-secondary"}
                onClick={() => openQaReport(report.id)}
              >
                <span className={`status-pill status-${report.status}`}>{report.status}</span>
                <span>{new Date(report.createdAt).toLocaleString()}</span>
              </button>
            ))
          )}
        </div>
        {activeQaReport && (
          <section className="qa-report-detail" aria-label="Browser QA report">
            <h3>{language === "uk" ? "Звіт Browser QA" : "Browser QA report"}</h3>
            <p>{activeQaReport.summary}</p>
            <div className="qa-metrics">
              <span>Load: {activeQaReport.metrics?.loadTimeMs ?? 0} ms</span>
              <span>Console: {activeQaReport.metrics?.consoleErrorsCount ?? 0}</span>
              <span>Links: {activeQaReport.metrics?.brokenLinksCount ?? 0}</span>
              <span>A11y: {activeQaReport.metrics?.a11yViolationsCount ?? 0}</span>
            </div>
            <label>
              {language === "uk" ? "Показати issues" : "Show issues"}
              <select value={qaIssueFilter} onChange={(event) => setQaIssueFilter(event.target.value)}>
                <option value="all">{language === "uk" ? "Усі" : "All"}</option>
                <option value="error">Error</option>
                <option value="warning">Warning</option>
              </select>
            </label>
            <ul className="qa-issue-list">
              {(activeQaReport.issues ?? [])
                .filter((item) => qaIssueFilter === "all" || item.severity === qaIssueFilter)
                .map((item) => (
                  <li key={item.id}>
                    <strong>{item.type}</strong> · {item.message}
                  </li>
                ))}
            </ul>
            {(activeQaReport.screenshots ?? []).map((shot, index) => (
              <figure key={index} className="qa-screenshot">
                <img
                  src={`data:image/png;base64,${shot.base64Data}`}
                  alt={language === "uk" ? "Знімок макета з прихованим вмістом" : "Layout screenshot with hidden content"}
                />
                <figcaption>
                  {shot.name} · {shot.viewport.width} × {shot.viewport.height}
                </figcaption>
              </figure>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
