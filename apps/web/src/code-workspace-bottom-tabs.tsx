import { CodeSnapshotPanel } from "./CodeSnapshotPanel";
import { type BottomTab, type Change, type RunEvent } from "./code-workspace-page-types";

export interface CodeWorkspaceBottomTabsProps {
  tab: BottomTab;
  setTab: (tab: BottomTab) => void;
  isUk: boolean;
  sessionId: string;
  runId: string;
  companyId: string;
  changesError: string | null;
  changedFiles: Change[];
  events?: RunEvent[];
}

export function CodeWorkspaceBottomTabs({
  tab,
  setTab,
  isUk,
  sessionId,
  runId,
  companyId,
  changesError,
  changedFiles,
  events = [],
}: CodeWorkspaceBottomTabsProps) {
  const terminalCommands = events
    .filter((e) => {
      const p = e.payload ?? {};
      return (
        typeof p.command === "string" ||
        p.tool === "code.shell.exec" ||
        typeof p.stdout === "string" ||
        typeof p.stderr === "string"
      );
    })
    .map((e) => {
      const p = e.payload ?? {};
      return {
        command: typeof p.command === "string" ? p.command : String(p.tool ?? "code.shell.exec"),
        stdout: typeof p.stdout === "string" ? p.stdout : undefined,
        stderr: typeof p.stderr === "string" ? p.stderr : undefined,
        exitCode: typeof p.exitCode === "number" ? p.exitCode : undefined,
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        at: e.createdAt,
      };
    });

  const logs = events.map((e) => {
    const p = e.payload ?? {};
    const text =
      typeof p.message === "string"
        ? p.message
        : typeof p.summary === "string"
          ? p.summary
          : typeof p.tool === "string"
            ? `Tool call: ${p.tool}`
            : JSON.stringify(p);
    return {
      time: e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : "—",
      kind: e.kind ?? "event",
      message: text.length > 300 ? text.slice(0, 300) + "…" : text,
    };
  });

  return (
    <section className="bottom-tabs">
      <div className="bottom-tabs-nav" role="tablist">
        {(["changes", "terminal", "logs", "activity"] as BottomTab[]).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={`bottom-tab-button ${tab === value ? "active" : ""}`}
            onClick={() => setTab(value)}
          >
            {value === "changes"
              ? isUk ? "Зміни" : "Changes"
              : value === "terminal"
                ? "Terminal"
                : value === "logs"
                  ? "Logs"
                  : "Activity"}
          </button>
        ))}
      </div>

      <div className="bottom-tab-content">
        {tab === "changes" && (
          <div>
            {!sessionId && <p className="ds-muted">{isUk ? "Сесію не вибрано." : "No session selected."}</p>}
            {sessionId && changesError && <p className="ds-hint-error">{changesError}</p>}
            {sessionId && !changesError && changedFiles.length === 0 && (
              <p className="ds-muted" style={{ padding: "16px 0", textAlign: "center" }}>
                {isUk ? "Змін немає." : "No changes."}
              </p>
            )}
            <ul className="code-changes-list">
              {changedFiles.map((change) => (
                <li key={change.path}>
                  <div className="code-change-header">
                    <code>{change.path}</code>
                    <span className="ds-muted">
                      {change.status ?? "modified"}
                      {change.additions !== undefined ? ` +${change.additions}` : ""}
                      {change.deletions !== undefined ? ` -${change.deletions}` : ""}
                    </span>
                  </div>
                  {change.diff && <pre className="code-diff">{change.diff}</pre>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === "terminal" && (
          <div>
            {terminalCommands.length === 0 ? (
              <p className="ds-muted" style={{ padding: "16px 0", textAlign: "center" }}>
                {isUk
                  ? "Термінал очікує виконання команд агентом у поточній сесії."
                  : "Terminal idle. Commands will appear when executed by the agent in this session."}
              </p>
            ) : (
              <div
                className="terminal-log-container"
                style={{
                  background: "#0f172a",
                  color: "#f8fafc",
                  borderRadius: 8,
                  padding: 14,
                  fontFamily: "monospace",
                  fontSize: "12.5px",
                }}
              >
                {terminalCommands.map((item, idx) => (
                  <div
                    key={idx}
                    style={{
                      marginBottom: 12,
                      borderBottom: idx < terminalCommands.length - 1 ? "1px solid #1e293b" : "none",
                      paddingBottom: 8,
                    }}
                  >
                    <div style={{ color: "#38bdf8", fontWeight: 600 }}>$ {item.command}</div>
                    {item.cwd && <div style={{ color: "#64748b", fontSize: "11px" }}>cwd: {item.cwd}</div>}
                    {item.stdout && <pre style={{ margin: "4px 0", color: "#f1f5f9", whiteSpace: "pre-wrap" }}>{item.stdout}</pre>}
                    {item.stderr && <pre style={{ margin: "4px 0", color: "#f87171", whiteSpace: "pre-wrap" }}>{item.stderr}</pre>}
                    {item.exitCode !== undefined && (
                      <div style={{ color: item.exitCode === 0 ? "#4ade80" : "#f87171", fontSize: "11px" }}>
                        exit code: {item.exitCode}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "logs" && (
          <div>
            {logs.length === 0 ? (
              <p className="ds-muted" style={{ padding: "16px 0", textAlign: "center" }}>
                {isUk ? "Логи виконання відсутні." : "No execution logs recorded yet."}
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 380, overflowY: "auto" }}>
                {logs.map((log, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      gap: 10,
                      fontSize: "12px",
                      padding: "6px 10px",
                      background: "#f8fafc",
                      borderRadius: 6,
                      border: "1px solid #e2e8f0",
                      alignItems: "baseline",
                    }}
                  >
                    <span style={{ color: "#64748b", fontFamily: "monospace", fontSize: "11px", whiteSpace: "nowrap" }}>
                      {log.time}
                    </span>
                    <span style={{ fontWeight: 600, color: "#2563eb", textTransform: "uppercase", fontSize: "11px" }}>
                      {log.kind}
                    </span>
                    <span style={{ color: "#334155", wordBreak: "break-all" }}>{log.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "activity" && (
          runId ? (
            <CodeSnapshotPanel companyId={companyId} runId={runId} isUk={isUk} />
          ) : (
            <p className="ds-muted" style={{ padding: "16px 0", textAlign: "center" }}>
              {isUk ? "Activity з'явиться, коли сесія почне run." : "Activity appears once the session starts a run."}
            </p>
          )
        )}
      </div>
    </section>
  );
}
