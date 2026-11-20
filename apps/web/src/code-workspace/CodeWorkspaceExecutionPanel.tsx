import type { Dispatch, SetStateAction } from "react";
import { eventTitle, eventFacts, eventFailure, type RunEvent, type PendingApproval, type ApprovalScope } from "../code-workspace-page-types";
interface Props {
  isUk: boolean;
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

export function CodeWorkspaceExecutionPanel({ isUk, sessionId, stopBusy, stopRun, activeTab, runId, streamError, events, expanded, setExpanded, approvals, approvalError, approvalBusy, decide, denyOpen, setDenyOpen, denyComment, setDenyComment }: Props) {
  if (activeTab !== "workspace") return null;
  return (
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
        {sessionId && runId && (
          <button type="button" className="button-secondary" disabled={stopBusy} onClick={() => void stopRun()}>
            {stopBusy ? "…" : isUk ? "Зупинити запуск" : "Stop run"}
          </button>
        )}
      </div>

      <div className="project-chat-body" style={{ maxHeight: 480 }}>
        {!runId && (
          <div className="code-empty-state">
            <div className="code-empty-state-icon">🤖</div>
            <h4>{isUk ? "Немає активного запуску" : "No active run"}</h4>
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
  );
}
