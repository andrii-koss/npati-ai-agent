import React from "react";
import type { AgentStreamItem, AgentToolCallItem, AskUserAnswer, ChangedFile } from "./types";
import { PlanTodoBlock } from "./PlanTodoBlock";
import { AskUserCard } from "./AskUserCard";

/**
 * C7: the agent stream — messages, tool calls, the plan and changed files.
 *
 * Presentation only: it takes already-fetched items as props, calls nothing, and renders every dynamic
 * string as a React child. That last point is the security property this file exists to hold: tool
 * output, command text and **file names** are attacker-influenced data (a model can be told to write a
 * file called `<img src=x onerror=…>`), so they must arrive in the DOM as text and never as markup.
 * There is no `dangerouslySetInnerHTML` here and there must never be one.
 */

function statusBadge(status: AgentToolCallItem["status"], isUk: boolean): string {
  const labels: Record<AgentToolCallItem["status"], [string, string]> = {
    ok: ["ok", "ок"],
    failed: ["failed", "помилка"],
    denied: ["denied", "відхилено"],
    pending: ["pending", "у процесі"],
  };
  return labels[status][isUk ? 1 : 0];
}

function ToolCall({ item, isUk }: { item: AgentToolCallItem; isUk: boolean }): React.ReactElement {
  const target = item.file ?? item.command ?? "";
  return (
    <details className="code-detail-row" data-tool-call-id={item.toolCallId} data-status={item.status}>
      <summary>
        <span className="data-studio-badge">{item.tool}</span>
        {target ? <span className="ds-muted">{target}</span> : null}
        <span className="ds-muted">{statusBadge(item.status, isUk)}</span>
      </summary>
      <div className="code-detail-row">
        <table className="automations-table">
          <tbody>
            {item.file ? (
              <tr>
                <td className="automation-title-cell">{isUk ? "Файл" : "File"}</td>
                <td className="ds-muted" data-field="file">
                  {item.file}
                </td>
              </tr>
            ) : null}
            {item.command ? (
              <tr>
                <td className="automation-title-cell">{isUk ? "Команда" : "Command"}</td>
                <td className="ds-muted" data-field="command">
                  <pre>{item.command}</pre>
                </td>
              </tr>
            ) : null}
            {item.cwd ? (
              <tr>
                <td className="automation-title-cell">{isUk ? "Робоча тека" : "Working directory"}</td>
                <td className="ds-muted" data-field="cwd">
                  {item.cwd}
                </td>
              </tr>
            ) : null}
            <tr>
              <td className="automation-title-cell">{isUk ? "Результат" : "Result"}</td>
              <td className="ds-muted" data-field="result">
                <pre>{item.result ?? ""}</pre>
                {item.truncated ? <span className="ds-muted">{isUk ? " (обрізано)" : " (truncated)"}</span> : null}
              </td>
            </tr>
            {item.errorCode ? (
              <tr>
                <td className="automation-title-cell">{isUk ? "Код помилки" : "Error code"}</td>
                <td className="ds-muted" data-field="error-code">
                  {item.errorCode}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ChangedFiles({ files, isUk }: { files: readonly ChangedFile[]; isUk: boolean }): React.ReactElement {
  return (
    <div className="automations-table-container">
      <table className="automations-table">
        <thead>
          <tr>
            <th>{isUk ? "Файл" : "File"}</th>
            <th>{isUk ? "Зміни" : "Changes"}</th>
            <th>{isUk ? "Diff" : "Diff"}</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.path} data-file={file.path}>
              <td className="automation-title-cell">{file.path}</td>
              <td className="ds-muted">{`+${file.additions} −${file.deletions}`}</td>
              <td className="ds-muted">
                <pre>{file.diff ?? ""}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentStreamView({
  items,
  isUk = false,
  onAskUserAnswer,
  askUserDisabled = false,
  askUserDisabledNotice,
}: {
  items: readonly AgentStreamItem[];
  isUk?: boolean;
  /**
   * C9: wired by the page once the `ask_user` answer route exists. Left undefined the card shows disabled
   * controls with a visible reason rather than a button that appears to submit and does not.
   */
  onAskUserAnswer?: (questionId: string, answer: AskUserAnswer) => void;
  askUserDisabled?: boolean;
  askUserDisabledNotice?: string;
}): React.ReactElement {
  return (
    <section className="ds-section-title" aria-label={isUk ? "Стрім агента" : "Agent stream"}>
      {items.map((item, index) => {
        if (item.kind === "message") {
          return (
            <div className="code-detail-row" key={`message-${index}`} data-role={item.role}>
              <span className="data-studio-badge">{item.role}</span>
              <div className="ds-muted" data-field="message-text">
                {item.text}
              </div>
            </div>
          );
        }
        if (item.kind === "tool_call") {
          return <ToolCall item={item} isUk={isUk} key={`tool-${item.toolCallId}`} />;
        }
        if (item.kind === "plan") {
          // The C9 goal/verification/self-review fields render inside this same block.
          return <PlanTodoBlock item={item} isUk={isUk} key={`plan-${index}`} />;
        }
        if (item.kind === "ask_user") {
          return (
            <AskUserCard
              card={item.card}
              isUk={isUk}
              key={`ask-${item.card.questionId}`}
              disabled={askUserDisabled}
              disabledNotice={askUserDisabledNotice}
              onAnswer={
                onAskUserAnswer ? (answer) => onAskUserAnswer(item.card.questionId, answer) : undefined
              }
            />
          );
        }
        return <ChangedFiles files={item.files} isUk={isUk} key={`files-${index}`} />;
      })}
    </section>
  );
}
