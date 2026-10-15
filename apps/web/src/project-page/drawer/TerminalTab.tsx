import type { TerminalEvent } from "../types";

interface TerminalTabProps {
  sandboxState: string;
  terminalEvents: TerminalEvent[];
  onRefresh: () => void;
}

export function TerminalTab({ sandboxState, terminalEvents, onRefresh }: TerminalTabProps) {
  return (
    <div className="terminal-tab-pane">
      <div className="terminal-status-row">
        <span>
          Sandbox State: <strong>{sandboxState}</strong>
        </span>
        <button type="button" className="button-secondary" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {terminalEvents.length === 0 ? (
        <p className="empty-terminal-hint">No agent commands recorded yet.</p>
      ) : (
        terminalEvents.map((evt) => (
          <article key={evt.id} className="terminal-event-card">
            <div className="event-meta">
              <code>{evt.commandSummary}</code>
              <span>
                {evt.status} · {new Date(evt.createdAt).toLocaleTimeString()}
              </span>
            </div>
            {evt.output && (
              <pre>
                <code>{evt.output}</code>
              </pre>
            )}
          </article>
        ))
      )}
    </div>
  );
}
