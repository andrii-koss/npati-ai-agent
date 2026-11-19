import { History, Pencil, Play, Square, Trash2 } from "lucide-react";
import { useTranslation } from "../i18n";
import { RecordCheckbox, type RecordSelectionControls } from "../record-selection";
import type { CompanyAutomation } from "./types";
import "./automations-table.css";

export interface AutomationsTableProps {
  loading: boolean;
  selection: RecordSelectionControls;
  total?: number;
  filteredAutomations: CompanyAutomation[];
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
  selection,
  total,
  filteredAutomations,
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
  const header = (
    <thead>
      <tr>
        <th className="record-selection-cell" scope="col" />
        <th className="automation-status-column" scope="col">{t("automations.table.colStatus")}</th>
        <th scope="col">{t("automations.table.colTask")}</th>
        <th className="automation-schedule-column" scope="col">{t("automations.table.colSchedule")}</th>
        <th className="automation-agent-column" scope="col">{t("automations.table.colAssignedAgent")}</th>
        <th className="automation-actions-column" scope="col">{t("automations.table.colActions")}</th>
      </tr>
    </thead>
  );

  if (loading) {
    return (
      <div className="automations-table-container automation-list-container">
        <table className="automations-table automation-list-table">
          {header}
          <tbody>
            {Array.from({ length: 4 }).map((_, idx) => (
              <tr key={`skeleton-${idx}`} style={{ opacity: 0.5 }}>
                <td className="record-selection-cell" />
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
                  <div className="automation-actions-cell">
                    <span style={{ display: "inline-block", width: "112px", height: "28px", background: "var(--npati-gray-100)", borderRadius: "6px" }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (total === 0) {
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
    <div className="automations-table-container automation-list-container">
      <table className="automations-table automation-list-table">
        {header}
        <tbody>
          {filteredAutomations.map((auto) => {
            const isRunningNow = runningNowId === auto.id;
            // A paused automation keeps its stored slot for resuming but has no next run (V6 step 12).
            const nextDate = auto.status === "active" && auto.nextRunAt ? new Date(auto.nextRunAt) : null;

            return (
              <tr key={auto.id} className={selection.selected.has(auto.id) ? "record-selected" : undefined}>
                <td className="record-selection-cell">
                  <RecordCheckbox selection={selection} record={{ id: auto.id, ownerId: auto.companyId }} name={auto.name} />
                </td>
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
                  <strong title={auto.name}>{auto.name}</strong>
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
                  <span className="automation-agent-badge" title={auto.agentName ?? t("automations.table.mainAgent")}>
                    <span>🤖</span>
                    <span>{auto.agentName ?? t("automations.table.mainAgent")}</span>
                  </span>
                </td>
                <td>
                  <div className="automation-actions-cell">
                    <button
                      type="button"
                      className="automation-action-btn run-btn"
                      disabled={isRunningNow}
                      onClick={() => triggerRunNow(auto)}
                      title={t(isRunningNow ? "automations.table.running" : "automations.table.runNowTitle")}
                      aria-label={t(isRunningNow ? "automations.table.running" : "automations.table.runNowTitle")}
                    >
                      <Play size={15} aria-hidden="true" />
                    </button>
                    {stopRun && (isRunningNow || auto.isRunning) && (
                      <button
                        type="button"
                        className="automation-action-btn stop-btn"
                        data-testid="automation-stop"
                        onClick={() => stopRun(auto)}
                        title={t("automations.table.stopTitle")}
                        aria-label={t("automations.table.stopTitle")}
                      >
                        <Square size={14} aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="automation-action-btn"
                      onClick={() => openHistory(auto)}
                      title={t("automations.table.historyTitle")}
                      aria-label={t("automations.table.historyTitle")}
                    >
                      <History size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="automation-action-btn"
                      onClick={() => openEditDrawer(auto)}
                      title={t("automations.table.editTitle")}
                      aria-label={t("automations.table.editTitle")}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="automation-action-btn danger"
                      onClick={() => deleteAutomation(auto.id)}
                      title={t("automations.table.deleteTitle")}
                      aria-label={t("automations.table.deleteTitle")}
                    >
                      <Trash2 size={15} aria-hidden="true" />
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
