interface LogsTabProps {
  logs: string;
  onRefresh: () => void;
}

export function LogsTab({ logs, onRefresh }: LogsTabProps) {
  return (
    <div className="logs-tab-pane">
      <div className="logs-toolbar">
        <button type="button" className="button-secondary" onClick={onRefresh}>
          Refresh Logs
        </button>
      </div>
      <pre className="raw-logs-pre">
        <code>{logs || "No logs available yet."}</code>
      </pre>
    </div>
  );
}
