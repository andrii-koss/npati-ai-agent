import React from "react";
import { Link } from "react-router-dom";
import type { ActiveRunDetails, ProjectTaskItem } from "./activity-types";
import { visibleRunTask } from "./activity-types";

export interface ActivityTraceDetailProps {
  activeRunDetails: ActiveRunDetails | null;
  projectTasks: ProjectTaskItem[];
  copiedId: string | null;
  copyToClipboard: (text: string, id: string) => void;
  setViewMode: (mode: "presets" | "trace") => void;
  language: string;
  t: (key: string, options?: any) => string;
}

export function ActivityTraceDetail({
  activeRunDetails,
  projectTasks,
  copiedId,
  copyToClipboard,
  setViewMode,
  language,
  t,
}: ActivityTraceDetailProps) {
  if (!activeRunDetails) {
    return (
      <div className="activity-placeholder-card">
        <span className="placeholder-icon">👈</span>
        <h3>{t("activity.trace.selectRunTitle")}</h3>
        <p>{t("activity.trace.selectRunCopy")}</p>
      </div>
    );
  }

  return (
    <div className="trace-detail-card">
      <header className="trace-card-header">
        <div className="trace-header-top-row">
          <button
            type="button"
            className="trace-back-arrow-btn"
            onClick={() => setViewMode("presets")}
            title={t("activity.trace.backToPresetsAria")}
            aria-label={t("activity.trace.backToPresetsAria")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="trace-header-badges">
            <span className={`status-pill ${activeRunDetails.run.status}`}>
              {activeRunDetails.run.status}
            </span>
            <span className="trace-mode-pill">
              {t("activity.trace.modePrefix", { mode: activeRunDetails.run.executionMode || activeRunDetails.run.requestedMode || "auto" })}
            </span>
            {activeRunDetails.run.omnirouteComboName && (
              <span className="trace-combo-pill">
                {t("activity.trace.comboPrefix", { combo: activeRunDetails.run.omnirouteComboName })}
              </span>
            )}
            {activeRunDetails.run.projectId && (
              <Link to={`/settings/websites/${activeRunDetails.run.companyId}/${activeRunDetails.run.projectId}`} className="button-secondary open-project-from-activity-btn">
                🌐 {language === "uk" ? "Відкрити проєкт" : "Open Project"}
              </Link>
            )}
          </div>
        </div>
        <div className="trace-header-main">
          <h2>{visibleRunTask(activeRunDetails.run.task)}</h2>
          <div className="trace-meta-row">
            <div className="trace-meta-item">
              <span>{t("activity.trace.runIdLabel")}:</span>
              <code>{activeRunDetails.run.id}</code>
              <button
                type="button"
                className="copy-btn"
                onClick={() => copyToClipboard(activeRunDetails.run.id, "runId")}
                title={t("activity.trace.copyRunIdTitle")}
              >
                {copiedId === "runId" ? t("activity.trace.copied") : t("activity.trace.copy")}
              </button>
            </div>
            <div className="trace-meta-item">
              <span>{t("activity.trace.startedLabel")}:</span>
              <strong>{new Date(activeRunDetails.run.createdAt).toLocaleString()}</strong>
            </div>
            {activeRunDetails.run.completedAt && (
              <div className="trace-meta-item">
                <span>{t("activity.trace.completedLabel")}:</span>
                <strong>{new Date(activeRunDetails.run.completedAt).toLocaleTimeString()}</strong>
              </div>
            )}
            {activeRunDetails.run.totalDurationMs !== undefined && (
              <div className="trace-meta-item">
                <span>{t("activity.trace.durationLabel")}:</span>
                <strong>{(activeRunDetails.run.totalDurationMs / 1000).toFixed(2)}s</strong>
              </div>
            )}
          </div>
        </div>
      </header>

      {activeRunDetails.run.result && (
        <div className="trace-result-box">
          <div className="trace-box-header">
            <div className="trace-box-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <strong>{t("activity.trace.finalOutput")}</strong>
            </div>
            <button
              type="button"
              className="copy-btn"
              onClick={() => copyToClipboard(activeRunDetails.run.result || "", "result")}
              title={t("activity.trace.copyResultTitle")}
            >
              {copiedId === "result" ? t("activity.trace.copied") : t("activity.trace.copy")}
            </button>
          </div>
          <p>{activeRunDetails.run.result}</p>
        </div>
      )}

      {activeRunDetails.run.errorMessage && (
        <div className="trace-error-box">
          <div className="trace-box-header">
            <div className="trace-box-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <strong>{t("activity.trace.executionFault")}</strong>
            </div>
          </div>
          <p>{activeRunDetails.run.errorMessage}</p>
        </div>
      )}

      {activeRunDetails.completionReport && (
        <div className={`trace-completion-report ${activeRunDetails.completionReport.status}`}>
          <div>
            <strong>{t("activity.trace.completionReportTitle")}</strong>
            <span>{activeRunDetails.completionReport.status}</span>
          </div>
          <p>
            {t("activity.trace.attemptSummary", {
              attempt: activeRunDetails.completionReport.attemptCount,
              tokens: activeRunDetails.completionReport.totalTokens,
              cost: activeRunDetails.completionReport.totalCost.toFixed(6),
              seconds: (activeRunDetails.completionReport.totalDurationMs / 1000).toFixed(2),
            })}
          </p>
        </div>
      )}

      {projectTasks.length > 0 && (
        <div className="trace-section">
          <div className="trace-section-header"><h3>Project task plan</h3></div>
          <div className="project-task-list">
            <div className="project-task-team">
              <span className="task-team-label">Agent team:</span>
              {[...new Set(projectTasks.map((t) => `${t.role} (${t.agentId?.slice(0, 8)})`))].map((label, idx) => (
                <span key={idx} className="task-agent-badge">{label}</span>
              ))}
            </div>
            {projectTasks.map((task) => {
              const latest = [...(activeRunDetails.backgroundEvents ?? [])].reverse()
                .find((event) => event.details.taskId === task.id);
              const status = String(latest?.details.status ?? "queued");
              return (
                <div key={task.id} className="project-task-row">
                  <span className={`status-pill status-${status}`}>{status}</span>
                  <strong>{task.title}</strong>
                  <span>{task.role} · {task.agentId?.slice(0, 8)}</span>
                  {task.dependsOn?.length > 0 && <small>After: {task.dependsOn.join(", ")}</small>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="trace-section">
        <div className="trace-section-header">
          <h3>{t("activity.trace.timelineTitle", { count: activeRunDetails.backgroundEvents?.length ?? 0 })}</h3>
          <small>{t("activity.trace.timelineDesc")}</small>
        </div>
        <div className="background-event-list">
          {(activeRunDetails.backgroundEvents ?? []).map((event) => (
            <div key={event.id} className={`background-event-item ${event.eventType}`}>
              <span className="background-event-dot" aria-hidden="true" />
              <div>
                <strong>{event.eventType.replace("_", " ")}</strong>
                <p>{event.message}</p>
                <small>{t("activity.trace.attemptLabel", { attempt: event.attemptCount })}{event.workerId ? ` · ${event.workerId}` : ""} · {new Date(event.createdAt).toLocaleTimeString()}</small>
              </div>
            </div>
          ))}
          {(!activeRunDetails.backgroundEvents || activeRunDetails.backgroundEvents.length === 0) && (
            <div className="trace-empty-notice">{t("activity.trace.synchronousNotice")}</div>
          )}
        </div>
      </div>

      {/* Agent Delegation Steps */}
      <div className="trace-section">
        <div className="trace-section-header">
          <h3>
            {t("activity.trace.delegationTitle", { count: activeRunDetails.steps?.length ?? 0 })}
          </h3>
          <small>{t("activity.trace.delegationDesc")}</small>
        </div>
        <div className="trace-steps-list">
          {(activeRunDetails.steps ?? []).map((step, idx) => (
            <div key={step.id || idx} className="trace-step-item">
              <span className="step-number">{step.stepOrder || idx + 1}</span>
              <div className="trace-step-body">
                <div className="trace-step-top">
                  <span className={`role-badge ${step.role}`}>{step.role}</span>
                  <span className={`step-status-badge ${step.status}`}>{step.status}</span>
                  <code className="trace-agent-id">{t("activity.trace.agentPrefix", { id: step.agentId.slice(0, 10) })}...</code>
                </div>
                <div className="trace-step-meta">
                  <span>{t("activity.trace.modelPrefix")} <strong>{step.modelId || "auto"}</strong></span>
                  {step.lane !== undefined && <span>{t("activity.trace.lanePrefix", { lane: step.lane })}</span>}
                </div>
              </div>
            </div>
          ))}
          {(!activeRunDetails.steps || activeRunDetails.steps.length === 0) && (
            <div className="trace-empty-notice">
              {t("activity.trace.noStepsNotice")}
            </div>
          )}
        </div>
      </div>

      {/* Tool Executions & Security Decisions */}
      <div className="trace-section">
        <div className="trace-section-header">
          <h3>
            {t("activity.trace.toolsTitle", { count: activeRunDetails.toolAudit?.length ?? 0 })}
          </h3>
          <small>{t("activity.trace.toolsDesc")}</small>
        </div>
        <div className="trace-tool-list">
          {(activeRunDetails.toolAudit ?? []).map((tool, idx) => (
            <div key={tool.id || idx} className={`trace-tool-item ${tool.decision}`}>
              <div className="trace-tool-item-header">
                <span className={`decision-badge ${tool.decision}`}>{tool.decision}</span>
                <code className="tool-name-code">{tool.toolName}</code>
                <span className={`status-badge ${tool.status}`}>{tool.status}</span>
                {tool.latencyMs !== undefined && (
                  <span className="tool-latency-tag">{tool.latencyMs}ms</span>
                )}
              </div>
              {tool.errorMessage && <p className="trace-tool-error">{tool.errorMessage}</p>}
              {tool.reasonCode && (
                <div className="trace-tool-reason">
                  <span>{t("activity.trace.policyReason")}</span> <code>{tool.reasonCode}</code>
                </div>
              )}
            </div>
          ))}
          {(!activeRunDetails.toolAudit || activeRunDetails.toolAudit.length === 0) && (
            <div className="trace-empty-notice">
              {t("activity.trace.noToolsNotice")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
