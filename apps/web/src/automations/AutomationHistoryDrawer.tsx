import { useTranslation } from "../i18n";
import type { CompanyAutomation, CompanyAutomationRun } from "./types";

export interface AutomationHistoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  automation: CompanyAutomation | null;
  runs: CompanyAutomationRun[];
  loading: boolean;
  language: string;
}

export function AutomationHistoryDrawer({
  isOpen,
  onClose,
  automation,
  runs,
  loading,
  language,
}: AutomationHistoryDrawerProps) {
  const { t } = useTranslation();

  if (!isOpen || !automation) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={onClose}>
      <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <header>
          <div>
            <span>{t("automations.history.kicker")}</span>
            <h2>{automation.name}</h2>
          </div>
          <button
            type="button"
            className="automations-drawer-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <section style={{ padding: "20px 26px" }}>
          {loading ? (
            <div className="workspace-notice">{t("automations.history.loading")}</div>
          ) : runs.length === 0 ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "var(--npati-gray-500)" }}>
              {t("automations.history.noRuns")}
            </div>
          ) : (
            <div className="history-runs-list">
              {runs.map((r) => (
                <div key={r.id} className="history-run-item">
                  <div className="history-run-header">
                    <span className={`status-pill ${r.status}`}>{r.status.toUpperCase()}</span>
                    <small style={{ color: "var(--npati-gray-500)" }}>
                      {new Date(r.startedAt).toLocaleString(language === "uk" ? "uk-UA" : language)}
                    </small>
                  </div>
                  <div className="history-run-meta">
                    <span>{t("automations.history.duration")} <strong>{r.durationMs}ms</strong></span>
                    <code style={{ fontSize: "11px", color: "var(--npati-gray-500)" }}>#{r.id.slice(0, 8)}</code>
                  </div>
                  {r.result && (
                    <div className="history-run-result">
                      <strong style={{ display: "block", marginBottom: 4, color: "#15803d" }}>{t("automations.history.finalResult")}</strong>
                      <p style={{ margin: 0 }}>{r.result}</p>
                    </div>
                  )}
                  {r.errorMessage && (
                    <div className="history-run-error">
                      <strong>{t("automations.history.error")}</strong> {r.errorMessage}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
