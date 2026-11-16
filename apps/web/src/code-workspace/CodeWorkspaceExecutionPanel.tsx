import { modeLabel } from "./actions";
import type { Dispatch, SetStateAction, FormEventHandler } from "react";
import { Link } from "react-router-dom";
import { SESSION_MODES, eventTitle, eventFacts, eventFailure, type SessionMode, type UsageResponse, type RunEvent, type PendingApproval, type ApprovalScope } from "../code-workspace-page-types";
interface Props {
  isUk: boolean;
  asyncInboxEnabled: boolean | null;
  startTask: FormEventHandler<HTMLFormElement>;
  mode: SessionMode;
  modeBusy: boolean;
  modeError: string | null;
  taskBusy: boolean;
  applyMode: (mode: SessionMode) => Promise<void>;
  task: string;
  setTask: (task: string) => void;
  usageError: string | null;
  usage: UsageResponse | null;
  sessionId: string;
  stopBusy: boolean;
  stopRun: () => Promise<void>;
  activeTab: string;
  runId: string;
  streamError: string | null;
  events: RunEvent[];
  expanded: Record<string, boolean>;
  setExpanded: Dispatch<SetStateAction<Record<string, boolean>>>;
  approvals: PendingApproval[];
  approvalError: string | null;
  approvalBusy: string | null;
  decide: (approval: PendingApproval, decision: "approve" | "deny", scope: ApprovalScope) => Promise<void>;
  denyOpen: Record<string, boolean>;
  setDenyOpen: Dispatch<SetStateAction<Record<string, boolean>>>;
  denyComment: Record<string, string>;
  setDenyComment: Dispatch<SetStateAction<Record<string, string>>>;
}

export function CodeWorkspaceExecutionPanel({ isUk, asyncInboxEnabled, startTask, mode, modeBusy, modeError, taskBusy, applyMode, task, setTask, usageError, usage, sessionId, stopBusy, stopRun, activeTab, runId, streamError, events, expanded, setExpanded, approvals, approvalError, approvalBusy, decide, denyOpen, setDenyOpen, denyComment, setDenyComment }: Props) {
  return (
    <>
      {/* TAB 1: WORKSPACE (AI Task Composer + Agent Stream) */}
      {(activeTab === "workspace" || activeTab === "all") && (
        <>
          {/* Modern AI Task Composer */}
          {asyncInboxEnabled !== true && (
            <form className="code-task-composer" onSubmit={startTask}>
              <div className="composer-header">
                <h2 className="composer-title">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d83438" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                  {isUk ? "Завдання для Coding Agent" : "Task for Coding Agent"}
                </h2>
                <div className="composer-options">
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <span style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569" }}>
                      {isUk ? "Режим роботи:" : "Permission mode:"}
                    </span>
                    <select
                      value={mode}
                      disabled={modeBusy || taskBusy}
                      onChange={(event) => void applyMode(event.target.value as SessionMode)}
                    >
                      {SESSION_MODES.map(value => <option key={value} value={value}>{modeLabel(value, isUk)}</option>)}
                    </select>
                  </label>
                </div>
              </div>

              {modeError && <p role="alert" className="ds-hint-error">{modeError}</p>}
              <textarea
                className="composer-textarea"
                value={task}
                onChange={(event) => setTask(event.target.value)}
                disabled={taskBusy}
                rows={3}
                placeholder={
                  isUk
                    ? "Опишіть завдання або зміни: наприклад, «Зміни головний колір кнопок на сайті», «Виправ верстку на сторінці checkout», або «Додай скрипт аналітики»…"
                    : "Describe what needs to be done: e.g., 'Change button styles on the landing page', 'Fix checkout layout', or 'Add a new section'…"
                }
              />

              <div className="composer-footer">
                <div className="code-workspace-usage">
                  {usageError && <span className="ds-hint-error">{usageError}</span>}
                  {!usageError && usage?.status === "ok" && usage.usage && (
                    <span className="ds-muted">
                      {isUk ? "Токени" : "Tokens"}: {usage.usage.totalTokens ?? "—"}
                      {usage.usage.estimated ? ` (${isUk ? "оцінка" : "estimate"})` : ""} ·{" "}
                      {isUk ? "вартість" : "cost"}:{" "}
                      {typeof usage.usage.costUsd === "number" ? `$${usage.usage.costUsd.toFixed(4)}` : "—"}
                    </span>
                  )}
                  {!usageError && (!usage || usage.status !== "ok") && (
                    <span className="ds-muted" style={{ fontSize: "12px" }}>
                      {isUk ? "Агент самостійно знайде потрібний файл, внесе правки та виконає перевірку." : "The agent will locate the files, apply edits, and verify changes."}
                    </span>
                  )}
                </div>

                <div className="composer-actions">
                  <button
                    type="submit"
                    className="button-primary automations-action-primary"
                    disabled={taskBusy || !task.trim()}
                    style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "9px 18px", fontWeight: 700 }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    {taskBusy
                      ? isUk ? "Запуск агента…" : "Starting agent…"
                      : isUk ? "Запустити агента" : "Run agent"}
                  </button>

                  <Link
                    className="button-secondary"
                    to="/chat"
                    style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12.5px" }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    {isUk ? "Продовжити в чаті" : "Continue in chat"}
                  </Link>

                  {sessionId && (
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={stopBusy}
                      onClick={() => void stopRun()}
                      style={{ fontSize: "12.5px", color: "#b91c1c" }}
                      title={isUk ? "Зупинити активний запуск" : "Stop active run"}
                    >
                      {stopBusy ? "…" : isUk ? "Зупинити" : "Stop"}
                    </button>
                  )}
                </div>
              </div>
            </form>
          )}

          {/* Agent Stream Card in workspace tab */}
          {activeTab === "workspace" && (
            <div className="project-col" style={{ borderRadius: 12, border: "1px solid #e2e8f0", background: "#ffffff", boxShadow: "0 1px 4px rgba(0,0,0,0.03)", overflow: "hidden", marginBottom: 20 }}>
              <div className="col-header">
                <h3>
                  {isUk ? "Стрім агента" : "Agent stream"}
                </h3>
                {runId ? (
                  <span className="data-studio-badge info" style={{ fontSize: "11px" }}>
                    run #{runId.slice(0, 6)}
                  </span>
                ) : (
                  <span className="ds-muted" style={{ fontSize: "12px" }}>{isUk ? "Очікування" : "Idle"}</span>
                )}
              </div>

              <div className="project-chat-body" style={{ maxHeight: 480 }}>
                {!runId && (
                  <div className="code-empty-state">
                    <div className="code-empty-state-icon">🤖</div>
                    <h4>{isUk ? "Немає активного запуску" : "No active run"}</h4>
                    <p>
                      {isUk
                        ? "Введіть завдання для Coding Agent у полі вище та натисніть «Запустити агента», щоб спостерігати за його кроками тут."
                        : "Enter a task above and click 'Run agent' to observe its real-time actions here."}
                    </p>
                  </div>
                )}

                {runId && streamError && <p className="ds-hint-error">{streamError}</p>}
                {runId && !streamError && events.length === 0 && (
                  <p className="ds-muted" style={{ textAlign: "center", padding: "20px 0" }}>
                    {isUk ? "Ініціалізація та очікування перших подій…" : "Initializing and waiting for first events…"}
                  </p>
                )}

                <ol className="code-stream">
                  {events.map((event, index) => {
                    const key = event.id ?? `${event.kind ?? "event"}-${index}`;
                    const isOpen = expanded[key] ?? false;
                    return (
                      <li key={key} className="code-stream-item">
                        <button
                          type="button"
                          className="code-stream-toggle"
                          aria-expanded={isOpen}
                          onClick={() => setExpanded((current) => ({ ...current, [key]: !isOpen }))}
                        >
                          <span className="code-stream-kind">{eventTitle(event, isUk)}</span>
                          {eventFailure(event) && <span className="code-stream-failed" style={{ color: "#b91c1c", fontWeight: 600, fontSize: "12px" }}>{(isUk ? "помилка" : "failed") + (eventFailure(event) !== "failed" ? ` · ${eventFailure(event)}` : "")}</span>}
                          {event.snapshotId && <span className="data-studio-badge info">snapshot</span>}
                        </button>
                        {isOpen && (
                          <div className="code-stream-body">
                            {eventFacts(event).length === 0 && (
                              <p className="ds-muted">{isUk ? "Лише метадані." : "Metadata only."}</p>
                            )}
                            {eventFacts(event).map(([label, value]) => (
                              <div className="code-detail-row" key={`${key}-${label}`} style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12px", padding: "2px 0" }}>
                                <span style={{ color: "#64748b" }}>{label}</span>
                                <code style={{ fontSize: "11.5px", background: "#f1f5f9", padding: "1px 5px", borderRadius: "4px" }}>{value}</code>
                              </div>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>

                {approvals.length > 0 && (
                  <div className="code-approvals">
                    <h4 style={{ margin: "0 0 10px", fontSize: "13.5px", fontWeight: 700, color: "#b45309", display: "flex", alignItems: "center", gap: "6px" }}>
                      {isUk ? "Очікують вашого підтвердження" : "Awaiting your approval"}
                    </h4>
                    {approvalError && <p className="ds-hint-error">{approvalError}</p>}
                    {approvals.map((approval) => (
                      <article className="code-approval-card" key={approval.id}>
                        <header>
                          <code>{approval.toolName ?? "code.shell.exec"}</code>
                          {approval.cwd && <span className="ds-muted" style={{ fontSize: "11.5px" }}> cwd: {approval.cwd}</span>}
                        </header>
                        {approval.command && <pre className="code-approval-body">{approval.command}</pre>}
                        {approval.diff && <pre className="code-approval-body">{approval.diff}</pre>}
                        {approval.reason && <p className="ds-muted" style={{ fontSize: "12px", margin: "6px 0" }}>{approval.reason}</p>}
                        <div className="code-approval-actions">
                          <button type="button" className="button-primary" style={{ padding: "6px 12px", fontSize: "12px" }} disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "approve", "once")}>
                            {isUk ? "Одноразово" : "Approve once"}
                          </button>
                          <button type="button" className="button-secondary" style={{ padding: "6px 12px", fontSize: "12px" }} disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "approve", "session")}>
                            {isUk ? "На сесію" : "For session"}
                          </button>
                          <button type="button" className="button-secondary" style={{ padding: "6px 12px", fontSize: "12px" }} disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "approve", "project")}>
                            {isUk ? "На проєкт" : "For project"}
                          </button>
                          <button type="button" className="button-secondary" style={{ padding: "6px 12px", fontSize: "12px", color: "#dc2626" }} disabled={approvalBusy === approval.id} onClick={() => setDenyOpen((current) => ({ ...current, [approval.id]: !current[approval.id] }))}>
                            {isUk ? "Відхилити" : "Deny"}
                          </button>
                        </div>
                        {denyOpen[approval.id] && (
                          <div className="code-approval-deny">
                            <textarea
                              maxLength={500}
                              value={denyComment[approval.id] ?? ""}
                              placeholder={isUk ? "Причина відхилення (повернеться моделі)" : "Reason for rejection (returned to model)"}
                              onChange={(event) => setDenyComment((current) => ({ ...current, [approval.id]: event.target.value }))}
                              style={{ padding: "8px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "12.5px" }}
                            />
                            <button type="button" className="button-secondary" disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "deny", "once")} style={{ alignSelf: "flex-start", fontSize: "12px" }}>
                              {isUk ? "Підтвердити відхилення" : "Confirm deny"}
                            </button>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}


    </>
  );
}
