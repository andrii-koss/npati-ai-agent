import React from "react";
import type { AskUserAnswer, AskUserCardData } from "./types";
import { validateAskUserAnswer } from "./actions";

/**
 * C9: the `ask_user` card — a structured question that pauses the run until a human answers.
 *
 * The card is presentation plus local choice state. It never builds a URL and never decides that an answer
 * is acceptable: it asks `validateAskUserAnswer` (the same rule the server enforces) and then hands the
 * answer to the injected `onAnswer` handler. That split is deliberate — in C7 three UI paths were found
 * pointing at endpoints that did not exist, so nothing here may *look* like it works: when the page has not
 * wired a handler, the controls are disabled with a visible reason instead of silently doing nothing.
 *
 * Statuses are rendered explicitly. `expired` in particular must say that the time ran out and that **no**
 * answer will be recorded — the tempting shortcut (show the choices as if still open, or show a default)
 * would put words in the user's mouth in an audit-relevant log.
 */

function statusLabel(status: AskUserCardData["status"], isUk: boolean): string {
  const labels: Record<AskUserCardData["status"], [string, string]> = {
    pending: ["waiting for an answer", "очікує відповіді"],
    answered: ["answered", "відповідь надано"],
    expired: ["expired", "час вичерпано"],
    cancelled: ["cancelled", "скасовано"],
  };
  const entry = labels[status];
  return isUk ? entry[1] : entry[0];
}

export function AskUserCard({
  card,
  isUk = false,
  onAnswer,
  disabled = false,
  disabledNotice,
}: {
  card: AskUserCardData;
  isUk?: boolean;
  /** Wired by the page; absent means the answer route is not available yet. */
  onAnswer?: (answer: AskUserAnswer) => void;
  disabled?: boolean;
  disabledNotice?: string;
}): React.ReactElement {
  const [choiceId, setChoiceId] = React.useState<string | undefined>(undefined);
  const [freeAnswer, setFreeAnswer] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);

  const open = card.status === "pending" && !disabled && typeof onAnswer === "function";
  const controlsDisabled = !open;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!onAnswer) return;
    const candidate: AskUserAnswer = {};
    if (choiceId !== undefined) candidate.choiceId = choiceId;
    const trimmed = freeAnswer.trim();
    if (trimmed.length > 0) candidate.freeAnswer = trimmed;

    const verdict = validateAskUserAnswer(candidate, card);
    if (!verdict.ok) {
      // The reason is shown to the user, not swallowed: an answer the server will refuse must not look sent.
      setProblem(verdict.reason);
      return;
    }
    setProblem(null);
    onAnswer(candidate);
  };

  return (
    <form
      className="data-studio-alert warning"
      data-kind="ask-user"
      data-question-id={card.questionId}
      data-question-status={card.status}
      data-revision={card.revision}
      onSubmit={submit}
    >
      <div className="data-studio-badge">{isUk ? "Питання" : "Question"}</div>
      <div className="ds-muted" data-field="ask-user-prompt">
        {card.prompt}
      </div>
      <div className="ds-muted" data-field="ask-user-status">
        {`${isUk ? "Стан" : "Status"}: ${statusLabel(card.status, isUk)}`}
      </div>

      {card.status === "expired" ? (
        <div className="ds-muted" data-field="ask-user-expired">
          {isUk
            ? "Час на відповідь вичерпано — відповідь не буде записана, і жодне значення не приймається за замовчуванням."
            : "The time to answer ran out — no answer will be recorded, and no value is assumed on your behalf."}
          {card.expiresAt ? <span className="ds-muted">{` (${card.expiresAt})`}</span> : null}
        </div>
      ) : null}

      {card.status === "cancelled" ? (
        <div className="ds-muted" data-field="ask-user-cancelled">
          {isUk
            ? `Питання скасовано${card.reason ? `: ${card.reason}` : "."}`
            : `The question was cancelled${card.reason ? `: ${card.reason}` : "."}`}
        </div>
      ) : null}

      {card.status === "answered" ? (
        <div data-field="ask-user-answered">
          <div className="ds-muted" data-field="ask-user-answer">
            {`${isUk ? "Відповідь" : "Answer"}: ${card.answer ?? ""}`}
          </div>
          {card.answeredBy || card.answeredAt ? (
            <div className="ds-muted" data-field="ask-user-answered-by">
              {`${isUk ? "Відповів" : "Answered by"}: ${card.answeredBy ?? ""}${
                card.answeredAt ? ` (${card.answeredAt})` : ""
              }`}
            </div>
          ) : null}
        </div>
      ) : null}

      {card.choices.length === 0 ? null : (
        <fieldset disabled={controlsDisabled} data-field="ask-user-choices">
          <legend>{isUk ? "Варіанти" : "Choices"}</legend>
          {card.choices.map((choice) => (
            <label key={choice.id} data-choice-id={choice.id}>
              <input
                type="radio"
                name={`ask-user-${card.questionId}`}
                value={choice.id}
                checked={choiceId === choice.id}
                disabled={controlsDisabled}
                onChange={() => setChoiceId(choice.id)}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </fieldset>
      )}

      {card.allowFreeAnswer ? (
        <label className="browser-form-field" data-field="ask-user-free-answer">
          <span>{isUk ? "Власна відповідь" : "Your own answer"}</span>
          <textarea
            value={freeAnswer}
            disabled={controlsDisabled}
            onChange={(event) => setFreeAnswer(event.target.value)}
            rows={3}
          />
        </label>
      ) : null}

      {problem ? (
        <div className="ds-muted" data-field="ask-user-problem">
          {problem}
        </div>
      ) : null}

      {disabledNotice && controlsDisabled ? (
        <div className="ds-muted" data-field="ask-user-disabled-notice">
          {disabledNotice}
        </div>
      ) : null}

      <button type="submit" className="button-secondary" disabled={controlsDisabled} data-action="ask-user-answer">
        {isUk ? "Надіслати відповідь" : "Send answer"}
      </button>
    </form>
  );
}
