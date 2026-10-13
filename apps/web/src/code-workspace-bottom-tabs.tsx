import { CodeSnapshotPanel } from "./CodeSnapshotPanel";
import { type BottomTab, type Change } from "./code-workspace-page-types";

export interface CodeWorkspaceBottomTabsProps {
  tab: BottomTab;
  setTab: (tab: BottomTab) => void;
  isUk: boolean;
  sessionId: string;
  runId: string;
  companyId: string;
  changesError: string | null;
  changedFiles: Change[];
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
}: CodeWorkspaceBottomTabsProps) {
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
              <p className="ds-muted">{isUk ? "Змін немає." : "No changes."}</p>
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
          <p className="ds-muted">
            {isUk
              ? "Вивід команд відображається в стрімі агента як результат tool call; окремий термінал — у Website Builder."
              : "Use Process output in the async work panel for the current process output. Tool-call results also appear in the agent stream."}
          </p>
        )}

        {tab === "logs" && (
          <p className="ds-muted">
            {isUk
              ? "Логи run-у доступні в Activity (метадані) та в AuditLog для привілейованих дій."
              : "Run logs are available in Activity (metadata) and in the AuditLog for privileged actions."}
          </p>
        )}

        {tab === "activity" && (
          runId ? (
            <CodeSnapshotPanel companyId={companyId} runId={runId} isUk={isUk} />
          ) : (
            <p className="ds-muted">
              {isUk ? "Activity з'явиться, коли сесія почне run." : "Activity appears once the session starts a run."}
            </p>
          )
        )}
      </div>
    </section>
  );
}
