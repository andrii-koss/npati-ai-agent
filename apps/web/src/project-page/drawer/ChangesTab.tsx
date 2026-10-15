import type { ChangesResult, FileChange } from "../types";

interface ChangesTabProps {
  language: string;
  changes: ChangesResult;
  selectedDiff?: FileChange;
  onSelectDiffPath: (path: string) => void;
  onSnapshotBaseline: () => void;
}

export function ChangesTab({
  language,
  changes,
  selectedDiff,
  onSelectDiffPath,
  onSnapshotBaseline,
}: ChangesTabProps) {
  return (
    <div className="changes-tab-pane">
      <div className="changes-summary-bar">
        <span className="badge-added">+{changes.summary.added} added</span>
        <span className="badge-modified">~{changes.summary.modified} modified</span>
        <span className="badge-deleted">-{changes.summary.deleted} deleted</span>
        <button
          type="button"
          className="button-secondary baseline-btn"
          onClick={onSnapshotBaseline}
          title="Set current files as new baseline"
        >
          {language === "uk" ? "Зафіксувати стан як базовий" : "Snapshot Baseline"}
        </button>
      </div>

      <div className="changes-diff-layout">
        <div className="changes-file-list">
          {changes.changes.length === 0 ? (
            <p className="no-changes-hint">
              {language === "uk" ? "Змін відносно базового стану немає" : "No changes detected relative to baseline"}
            </p>
          ) : (
            changes.changes.map((item) => (
              <button
                key={item.path}
                type="button"
                className={`change-file-item ${selectedDiff?.path === item.path ? "active" : ""}`}
                onClick={() => onSelectDiffPath(item.path)}
              >
                <span className={`status-tag status-${item.status}`}>{(item.status[0] ?? "").toUpperCase()}</span>
                <span className="change-path">{item.path}</span>
              </button>
            ))
          )}
        </div>

        <div className="changes-diff-viewer">
          {selectedDiff ? (
            <div className="diff-card">
              <div className="diff-header">
                <strong>{selectedDiff.path}</strong>
                <span className={`diff-status-label ${selectedDiff.status}`}>{selectedDiff.status}</span>
              </div>
              <pre className="diff-pre">
                <code>
                  {selectedDiff.diff.split("\n").map((line, idx) => (
                    <span
                      key={idx}
                      className={
                        line.startsWith("+") && !line.startsWith("+++")
                          ? "diff-line-add"
                          : line.startsWith("-") && !line.startsWith("---")
                          ? "diff-line-del"
                          : line.startsWith("@@")
                          ? "diff-line-hdr"
                          : "diff-line"
                      }
                    >
                      {line + "\n"}
                    </span>
                  ))}
                </code>
              </pre>
            </div>
          ) : (
            <p className="no-diff-selected">
              {language === "uk" ? "Виберіть змінений файл для перегляду diff" : "Select a modified file to view diff"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
