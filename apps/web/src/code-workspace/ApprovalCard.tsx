import React, { useState } from "react";
import { approvalScopeLabel } from "./actions";
import { APPROVAL_SCOPES, type ApprovalCardData, type ApprovalScope } from "./types";

/**
 * C7: the approval card.
 *
 * Shows exactly what will happen — a diff, or a command together with the directory it runs in — and
 * offers the four answers the policy model supports. It decides nothing: it reports the human's choice
 * through `onDecision`, and `approvalDecisionPlan` (actions.ts) turns that choice into requests against
 * the existing approvals API.
 *
 * The card is rendered read-only when `disabled` is set (feature flag off): the buttons are disabled and
 * a notice explains that approvals are unavailable, rather than hiding the card and pretending the run
 * never asked.
 */
export function ApprovalCard({
  data,
  isUk = false,
  disabled = false,
  disabledNotice,
  onDecision,
}: {
  data: ApprovalCardData;
  isUk?: boolean;
  disabled?: boolean;
  disabledNotice?: string;
  onDecision: (scope: ApprovalScope, comment?: string) => void;
}): React.ReactElement {
  const [comment, setComment] = useState("");

  return (
    <section className="data-studio-alert warning" role="status" data-approval-id={data.approvalId}>
      <div className="code-detail-row">
        <span className="data-studio-badge">{data.action}</span>
        {data.riskLevel ? <span className="ds-muted">{`${isUk ? "ризик" : "risk"}: ${data.riskLevel}`}</span> : null}
        <span className="ds-muted">{data.approvalId}</span>
      </div>

      {data.command ? (
        <div className="code-detail-row">
          <div className="ds-muted">{`${isUk ? "Команда" : "Command"} (cwd: ${data.cwd ?? "—"})`}</div>
          <pre data-field="approval-command">{data.command}</pre>
        </div>
      ) : null}

      {data.diff ? (
        <div className="code-detail-row">
          <div className="ds-muted">{isUk ? "Зміни" : "Diff"}</div>
          <pre data-field="approval-diff">{data.diff}</pre>
        </div>
      ) : null}

      {data.filePaths && data.filePaths.length > 0 ? (
        <ul data-field="approval-files">
          {data.filePaths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : null}

      {disabled ? (
        <div className="data-studio-alert info" data-field="approval-disabled" role="status">
          {disabledNotice ?? (isUk ? "Підтвердження недоступні: Coding Agent вимкнено." : "Approvals are unavailable: the Coding Agent is disabled.")}
        </div>
      ) : null}

      <label className="browser-form-field" data-field="approval-comment">
        <span>{isUk ? "Коментар (повертається моделі при відхиленні)" : "Comment (returned to the model on deny)"}</span>
        <textarea
          value={comment}
          disabled={disabled}
          maxLength={2000}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>

      <div className="browser-form-footer">
        {APPROVAL_SCOPES.map((scope) => (
          <button
            key={scope}
            type="button"
            disabled={disabled}
            data-scope={scope}
            className={scope === "deny" ? "button-secondary" : "button-secondary"}
            onClick={() => onDecision(scope, scope === "deny" ? comment : undefined)}
          >
            {approvalScopeLabel(scope, isUk)}
          </button>
        ))}
      </div>

      {!disabled && data.expiresAt ? (
        <div className="ds-muted" data-field="approval-expiry">
          {`${isUk ? "Діє до" : "Expires at"}: ${data.expiresAt}`}
        </div>
      ) : null}
    </section>
  );
}
