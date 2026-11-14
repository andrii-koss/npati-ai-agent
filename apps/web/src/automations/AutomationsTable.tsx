import { useTranslation } from "../i18n";
import type { Agent, CompanyAutomation } from "./types";

export interface AutomationsTableProps {
  loading: boolean;
  automations: CompanyAutomation[];
  filteredAutomations: CompanyAutomation[];
  agents: Agent[];
  runningNowId: string | null;
  language: string;
  getCronDescription: (cron: string) => string;
  openCreateDrawer: () => void;
  setSearchQuery: (val: string) => void;
  setStatusFilter: (val: "all" | "active" | "paused") => void;
  toggleStatus: (auto: CompanyAutomation) => void | Promise<void>;
  triggerRunNow: (auto: CompanyAutomation) => void | Promise<void>;
  stopRun?: (auto: CompanyAutomation) => void | Promise<void>;
  openHistory: (auto: CompanyAutomation) => void | Promise<void>;
  openEditDrawer: (auto: CompanyAutomation) => void;
  deleteAutomation: (id: string) => void | Promise<void>;
}

export function AutomationsTable({
  loading,
  automations,
  filteredAutomations,
  agents,
  runningNowId,
  language,
  getCronDescription,
  openCreateDrawer,
  setSearchQuery,
  setStatusFilter,
  toggleStatus,
  triggerRunNow,
  stopRun,
  openHistory,
  openEditDrawer,
  deleteAutomation,
}: AutomationsTableProps) {
  const { t } = useTranslation();

  if (loading && automations.length === 0) {
    return (
      <div className="automations-table-container">
        <table className="automations-table">
          <thead>
            <tr>
              <th style={{ width: "110px" }}>{t("automations.table.colStatus")}</th>
              <th style={{ minWidth: "260px" }}>{t("automations.table.colTask")}</th>
              <th style={{ minWidth: "180px" }}>{t("automations.table.colSchedule")}</th>
              <th style={{ minWidth: "160px" }}>{t("automations.table.colAssignedAgent")}</th>
              <th style={{ width: "220px", textAlign: "right" }}>{t("automations.table.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 4 }).map((_, idx) => (
              <tr key={`skeleton-${idx}`} style={{ opacity: 0.5 }}>
                <td>
                  <span style={{ display: "inline-block", width: "70px", height: "24px", background: "var(--npati-gray-100)", borderRadius: "999px" }} />
                </td>
                <td className="automation-title-cell">
                  <span style={{ display: "block", width: "180px", height: "16px", background: "var(--npati-gray-100)", borderRadius: "4px", marginBottom: "6px" }} />
                  <span style={{ display: "block", width: "240px", height: "12px", background: "var(--npati-gray-100)", borderRadius: "4px" }} />
                </td>
                <td>
                  <span style={{ display: "inline-block", width: "90px", height: "18px", background: "var(--npati-gray-100)", borderRadius: "4px" }} />
                </td>
                <td>
                  <span style={{ display: "inline-block", width: "100px", height: "14px", background: "var(--npati-gray-100)", borderRadius: "4px" }} />
                </td>
                <td>
                  <div className="automation-actions-cell" style={{ justifyContent: "flex-end" }}>
                    <span style={{ display: "inline-block", width: "70px", height: "28px", background: "var(--npati-gray-100)", borderRadius: "6px" }} />
                    <span style={{ display: "inline-block", width: "50px", height: "28px", background: "var(--npati-gray-100)", borderRadius: "6px" }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (automations.length === 0) {
    return (
      <div className="automations-empty-card">
        <div className="automations-empty-icon">⏱️</div>
        <h3>{t("automations.empty.noAutomationsTitle")}</h3>
        <p>{t("automations.empty.noAutomationsDesc")}</p>
        <button type="button" className="button-primary automations-action-primary" onClick={openCreateDrawer}>
          {t("automations.empty.createFirstBtn")}
        </button>
      </div>
    );
  }

  if (filteredAutomations.length === 0) {
    return (
      <div className="automations-empty-card">
        <div className="automations-empty-icon">🔍</div>
        <h3>{t("automations.empty.noMatchingTitle")}</h3>
        <p>{t("automations.empty.noMatchingDesc")}</p>
        <button
          type="button"
          className="button-secondary"
          onClick={() => { setSearchQuery(""); setStatusFilter("all"); }}
        >
          {t("automations.empty.clearFiltersBtn")}
        </button>
      </div>
    );
  }

  return (
    <div className="automations-table-container">
      <table className="automations-table">
        <thead>
          <tr>
            <th style={{ width: "110px" }}>{t("automations.table.colStatus")}</th>
            <th style={{ minWidth: "260px" }}>{t("automations.table.colTask")}</th>
            <th style={{ minWidth: "180px" }}>{t("automations.table.colSchedule")}</th>
            <th style={{ minWidth: "160px" }}>{t("automations.table.colAssignedAgent")}</th>
            <th style={{ width: "220px", textAlign: "right" }}>{t("automations.table.colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {filteredAutomations.map((auto) => {
            const assignedAgent = agents.find((a) => a.id === auto.agentId);
            const isRunningNow = runningNowId === auto.id;
            // A paused automation keeps its stored slot for resuming but has no next run (V6 step 12).
            const nextDate = auto.status === "active" && auto.nextRunAt ? new Date(auto.nextRunAt) : null;

            return (
              <tr key={auto.id}>
                <td>
                  <button
                    type="button"
                    className={`automation-status-btn ${auto.status}`}
                    onClick={() => toggleStatus(auto)}
                    title={auto.status === "active" ? t("automations.table.clickToPause") : t("automations.table.clickToActivate")}
                  >
                    <span className="automation-status-dot" />
                    {auto.status === "active" ? t("automations.table.statusActive") : t("automations.table.statusPaused")}
                  </button>
                </td>
                <td className="automation-title-cell">
                  <strong>{auto.name}</strong>
                  {auto.description && <p>{auto.description}</p>}
                  <div className="automation-prompt-preview" title={auto.prompt}>
                    {t("automations.table.promptPrefix")} {auto.prompt}
                  </div>
                </td>
                <td>
                  <span className="automation-cron-pill">
                    <code>{auto.cronExpression}</code>
                  </span>
                  <span className="automation-cron-label">
                    {getCronDescription(auto.cronExpression)}
                  </span>
                  {nextDate && (
                    <span className="automation-next-run">
                      {t("automations.table.nextRunPrefix")}{" "}
                      {nextDate.toLocaleString(language === "uk" ? "uk-UA" : language, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                </td>
                <td>
                  <span className="automation-agent-badge">
                    <span>🤖</span>
                    <span>{assignedAgent ? assignedAgent.name : t("automations.table.mainAgent")}</span>
                  </span>
                </td>
                <td>
                  <div className="automation-actions-cell">
                    <button
                      type="button"
                      className="automation-action-btn run-btn"
                      disabled={isRunningNow}
                      onClick={() => triggerRunNow(auto)}
                      title={t("automations.table.runNowTitle")}
                    >
                      {isRunningNow ? t("automations.table.running") : t("automations.table.runNow")}
                    </button>
                    {stopRun && (isRunningNow || auto.isRunning) && (
                      <button
                        type="button"
                        className="automation-action-btn stop-btn"
                        data-testid="automation-stop"
                        onClick={() => stopRun(auto)}
                        title={t("automations.table.stopTitle")}
                      >
                        {t("automations.table.stop")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="automation-action-btn"
                      onClick={() => openHistory(auto)}
                      title={t("automations.table.historyTitle")}
                    >
                      {t("automations.table.history")}
                    </button>
                    <button
                      type="button"
                      className="automation-action-btn"
                      onClick={() => openEditDrawer(auto)}
                      title={t("automations.table.editTitle")}
                    >
                      {t("automations.table.edit")}
                    </button>
                    <button
                      type="button"
                      className="automation-action-btn danger"
                      onClick={() => deleteAutomation(auto.id)}
                      title={t("automations.table.deleteTitle")}
                    >
                      {t("automations.table.delete")}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
