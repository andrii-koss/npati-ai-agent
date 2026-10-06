import React, { useState } from "react";
import { validateChangePaths } from "./actions";
import type { ChangedFile } from "./types";

/**
 * C7: the Changes tab — what the run touched, with Revert file / Revert all.
 *
 * Revert is the one destructive control in this view, so it is deliberately explicit: the path list is
 * validated with the same rules the server enforces (`validateChangePaths`) before anything is asked of
 * the API, and an invalid selection is reported instead of being silently dropped. Reverts go through the
 * existing checkpoint mechanism server-side, which creates a pre-restore safety checkpoint first.
 */
export function ChangesView({
  files,
  isUk = false,
  disabled = false,
  onRevert,
  onRevertAll,
}: {
  files: readonly ChangedFile[];
  isUk?: boolean;
  disabled?: boolean;
  onRevert: (files: readonly string[]) => void;
  onRevertAll: () => void;
}): React.ReactElement {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const toggle = (path: string): void => {
    setProblem(null);
    setSelected((current) => (current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path]));
  };

  const revertSelected = (): void => {
    const validated = validateChangePaths(selected);
    if (!validated.ok) {
      setProblem(
        isUk
          ? `Не можна відкотити: ${validated.reason} (${validated.path || "—"})`
          : `Cannot revert: ${validated.reason} (${validated.path || "—"})`
      );
      return;
    }
    onRevert(validated.paths);
  };

  if (files.length === 0) {
    return (
      <div className="browser-empty-state" data-field="changes-empty">
        {isUk ? "Змін у цьому ході немає." : "No changes in this turn."}
      </div>
    );
  }

  return (
    <section className="ds-section-title" aria-label={isUk ? "Зміни" : "Changes"}>
      <div className="automations-table-container">
        <table className="automations-table">
          <thead>
            <tr>
              <th aria-label={isUk ? "Вибір" : "Select"} />
              <th>{isUk ? "Файл" : "File"}</th>
              <th>{isUk ? "Статус" : "Status"}</th>
              <th>{isUk ? "Зміни" : "Changes"}</th>
              <th>{isUk ? "Дія" : "Action"}</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.path} data-file={file.path}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.includes(file.path)}
                    disabled={disabled}
                    onChange={() => toggle(file.path)}
                    aria-label={file.path}
                  />
                </td>
                <td className="automation-title-cell">{file.path}</td>
                <td className="ds-muted">{file.status}</td>
                <td className="ds-muted">{`+${file.additions} −${file.deletions}`}</td>
                <td>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={disabled}
                    data-revert-file={file.path}
                    onClick={() => onRevert([file.path])}
                  >
                    {isUk ? "Відкотити файл" : "Revert file"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {problem ? (
        <div className="data-studio-alert error" role="alert" data-field="revert-problem">
          {problem}
        </div>
      ) : null}

      <div className="browser-form-footer">
        <button
          type="button"
          className="button-secondary"
          disabled={disabled || selected.length === 0}
          data-action="revert-selected"
          onClick={revertSelected}
        >
          {isUk ? "Відкотити вибрані" : "Revert selected"}
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={disabled}
          data-action="revert-all"
          onClick={onRevertAll}
        >
          {isUk ? "Відкотити все" : "Revert all"}
        </button>
      </div>
    </section>
  );
}
