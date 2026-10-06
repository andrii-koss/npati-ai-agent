import React from "react";
import type {
  AgentPlanItem,
  GoalCriterionStatus,
  GoalView,
  SelfReviewView,
  TestIntegrityFinding,
  VerificationView,
} from "./types";

/**
 * C9: the Plan/Todo block, extended with the goal-driven fields.
 *
 * This is the same block the C7 renderer already produced (`data-kind="plan"` with `✓`/`•` steps); the C9
 * additions are rendered inside it so there is exactly one place that claims to describe what the agent is
 * doing. A second block would let the plan and the goal disagree in front of the user.
 *
 * Two presentation rules carried over from the rest of the workspace, both security-relevant:
 *  - everything that came from the server (objective, criteria text, file paths, findings, reasons) is a
 *    React child, i.e. a text node. A model can put `<img src=x onerror=…>` in a file name or in a question
 *    prompt, and this file must never turn that into markup. There is no `dangerouslySetInnerHTML` here.
 *  - nothing may *look* like success when it is not known: `not_run`, `unavailable`, "no criteria" and
 *    "blocked without a question" each get their own explicit wording, because a blank area reads as "fine".
 */

function percent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress * 100)));
}

function criterionMark(status: GoalCriterionStatus): string {
  if (status === "verified") return "✓";
  if (status === "failed") return "✗";
  return "•";
}

function goalStatusLabel(status: GoalView["status"], isUk: boolean): string {
  const labels: Record<GoalView["status"], [string, string]> = {
    planned: ["planned", "заплановано"],
    running: ["running", "виконується"],
    blocked: ["blocked", "заблоковано"],
    verifying: ["verifying", "перевіряється"],
    completed: ["completed", "завершено"],
    failed: ["failed", "невдача"],
  };
  const entry = labels[status];
  return isUk ? entry[1] : entry[0];
}

function verificationStatusLabel(status: VerificationView["status"], isUk: boolean): string {
  const labels: Record<VerificationView["status"], [string, string]> = {
    not_run: ["not run", "не запускалась"],
    passed: ["passed", "пройдено"],
    failed: ["failed", "не пройдено"],
    unavailable: ["unavailable", "недоступно"],
    passed_with_unjustified_test_changes: [
      "passed, but the diff changed tests without justification",
      "пройдено, але diff змінив тести без обґрунтування",
    ],
  };
  const entry = labels[status];
  return isUk ? entry[1] : entry[0];
}

function selfReviewStatusLabel(status: SelfReviewView["status"], isUk: boolean): string {
  const labels: Record<SelfReviewView["status"], [string, string]> = {
    not_run: ["not run", "не виконувався"],
    clean: ["no findings", "без зауважень"],
    findings: ["findings", "є зауваження"],
    unavailable: ["unavailable", "недоступно"],
  };
  const entry = labels[status];
  return isUk ? entry[1] : entry[0];
}

function integrityReason(finding: TestIntegrityFinding, isUk: boolean): string {
  if (finding.justified === true) return isUk ? "обґрунтовано" : "justified";
  if (finding.justified === false) return isUk ? "без обґрунтування" : "unjustified";
  return isUk ? "не оцінено" : "not assessed";
}

function Alert({
  tone,
  children,
  testId,
}: {
  tone: "info" | "warning";
  children: React.ReactNode;
  testId?: string;
}): React.ReactElement {
  return (
    <div className={`data-studio-alert ${tone}`} data-kind={testId}>
      {children}
    </div>
  );
}

function GoalSection({ goal, isUk }: { goal: GoalView; isUk: boolean }): React.ReactElement {
  const verified = goal.criteria.filter((criterion) => criterion.status === "verified").length;
  const current = goal.tasks.find((task) => task.status === "in_progress");
  const completed = goal.tasks.filter((task) => task.status === "completed");
  const blocked = goal.tasks.filter((task) => task.status === "pending" && Boolean(task.blockedReason));

  return (
    <div className="code-detail-row" data-kind="goal" data-goal-id={goal.goalId} data-goal-status={goal.status}>
      <div className="data-studio-badge">{isUk ? "Ціль" : "Goal"}</div>
      <div className="ds-muted" data-field="goal-objective">
        {goal.objective}
      </div>
      <div className="ds-muted" data-field="goal-status">
        {`${isUk ? "Статус" : "Status"}: ${goalStatusLabel(goal.status, isUk)}`}
      </div>
      <div className="ds-muted" data-field="goal-progress" data-progress-percent={percent(goal.progress)}>
        {`${isUk ? "Прогрес" : "Progress"}: ${percent(goal.progress)}% (${verified}/${goal.criteria.length} ${
          isUk ? "критеріїв перевірено" : "criteria verified"
        })`}
      </div>

      <div className="ds-section-title">{isUk ? "Критерії приймання" : "Acceptance criteria"}</div>
      {goal.criteria.length === 0 ? (
        // Not "all done": a goal without criteria cannot be certified as complete, and the UI must say so
        // rather than render an empty list that looks like nothing is outstanding.
        <Alert tone="warning" testId="goal-criteria-missing">
          <span data-field="criteria-missing">
            {isUk
              ? "Критерії приймання не задані — завершення не може бути підтверджене."
              : "No acceptance criteria are defined — completion cannot be certified."}
          </span>
        </Alert>
      ) : (
        <ul data-field="goal-criteria">
          {goal.criteria.map((criterion) => (
            <li key={criterion.id} data-criterion-id={criterion.id} data-criterion-status={criterion.status}>
              {`${criterionMark(criterion.status)} ${criterion.text}`}
              {criterion.note ? <span className="ds-muted">{` — ${criterion.note}`}</span> : null}
            </li>
          ))}
        </ul>
      )}

      <div className="ds-section-title">{isUk ? "Задачі" : "Tasks"}</div>
      <div className="ds-muted" data-field="task-current">
        {`${isUk ? "Поточна" : "Current"}: ${current ? current.content : isUk ? "немає" : "none"}`}
      </div>
      <div className="ds-muted" data-field="task-completed-count" data-completed-count={completed.length}>
        {`${isUk ? "Завершено" : "Completed"}: ${completed.length}`}
      </div>
      {blocked.length === 0 ? null : (
        <div data-field="tasks-blocked">
          <div className="ds-muted">{`${isUk ? "Заблоковані" : "Blocked"}: ${blocked.length}`}</div>
          <ul>
            {blocked.map((task) => (
              <li key={task.taskId} data-blocked-task-id={task.taskId}>
                {`${task.content} — ${task.blockedReason ?? ""}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {goal.status === "blocked" ? (
        // "Blocked on a question" and "blocked for a technical reason" need different user actions, so they
        // are rendered as different statements instead of one generic "blocked" badge.
        <Alert tone="warning" testId={goal.awaitingAnswer ? "goal-blocked-awaiting-answer" : "goal-blocked"}>
          <span data-field="goal-blocked-reason">
            {goal.awaitingAnswer
              ? isUk
                ? "Очікує відповіді на питання."
                : "Waiting for an answer to a question."
              : isUk
                ? `Заблоковано: ${goal.blockedReason ?? "причина не вказана"}`
                : `Blocked: ${goal.blockedReason ?? "no reason given"}`}
          </span>
        </Alert>
      ) : null}
    </div>
  );
}

function VerificationSection({ verification, isUk }: { verification: VerificationView; isUk: boolean }): React.ReactElement {
  const attempts =
    verification.maxAttempts === null
      ? `${verification.attemptsUsed}`
      : `${verification.attemptsUsed}/${verification.maxAttempts}`;
  const findings = verification.testIntegrityFindings ?? [];

  return (
    <div className="code-detail-row" data-kind="verification" data-verification-status={verification.status}>
      <div className="data-studio-badge">{isUk ? "Перевірки" : "Verification"}</div>
      <div className="ds-muted" data-field="verification-status">
        {`${isUk ? "Статус" : "Status"}: ${verificationStatusLabel(verification.status, isUk)}`}
      </div>
      <div className="ds-muted" data-field="verification-repair-attempts" data-attempts-used={verification.attemptsUsed}>
        {`${isUk ? "Спроби виправлення" : "Repair attempts"}: ${attempts}`}
      </div>
      {verification.unavailable ? (
        // The server's own wording, never a substitute like "passed": an unknown verification result is the
        // one state a user is most likely to misread as success.
        <Alert tone="warning" testId="verification-unavailable">
          <span data-field="verification-unavailable">
            {`${isUk ? "Перевірку не виконано" : "Verification did not run"}: ${verification.unavailable}`}
          </span>
        </Alert>
      ) : null}
      {verification.checks.length === 0 ? null : (
        <table className="automations-table">
          <thead>
            <tr>
              <th>{isUk ? "Перевірка" : "Check"}</th>
              <th>{isUk ? "Стан" : "Result"}</th>
            </tr>
          </thead>
          <tbody>
            {verification.checks.map((check, index) => (
              <tr key={`${check.check}-${index}`} data-check={check.check} data-check-status={check.status}>
                <td className="automation-title-cell">{check.check}</td>
                <td className="ds-muted">
                  {`${check.status}${check.errorCode ? ` (${check.errorCode})` : ""}`}
                  {check.message ? <pre>{check.message}</pre> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {findings.length === 0 ? null : (
        <Alert tone="warning" testId="test-integrity-findings">
          <div className="ds-muted" data-field="test-integrity-count">
            {`${isUk ? "Зміни в тестах" : "Test changes"}: ${findings.length}`}
          </div>
          <ul data-field="test-integrity-list">
            {findings.map((finding, index) => (
              <li key={`${finding.path}-${index}`} data-integrity-kind={finding.kind}>
                {`${finding.path}: ${finding.reason} (${integrityReason(finding, isUk)})`}
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}

function SelfReviewSection({ review, isUk }: { review: SelfReviewView; isUk: boolean }): React.ReactElement {
  return (
    <div className="code-detail-row" data-kind="self-review" data-self-review-status={review.status}>
      <div className="data-studio-badge">{isUk ? "Само-рев'ю" : "Self-review"}</div>
      <div className="ds-muted" data-field="self-review-status">
        {`${isUk ? "Статус" : "Status"}: ${selfReviewStatusLabel(review.status, isUk)}`}
      </div>
      {review.iterationsUsed === undefined ? null : (
        <div className="ds-muted" data-field="self-review-iterations">
          {`${isUk ? "Ітерацій виправлень" : "Fix iterations"}: ${review.iterationsUsed}`}
        </div>
      )}
      {review.unavailable ? (
        <Alert tone="warning" testId="self-review-unavailable">
          <span data-field="self-review-unavailable">{review.unavailable}</span>
        </Alert>
      ) : null}
      {review.findings.length === 0 ? null : (
        <ul data-field="self-review-findings">
          {review.findings.map((finding, index) => (
            <li key={`${finding.path ?? "finding"}-${index}`} data-severity={finding.severity}>
              {`[${finding.severity}] ${finding.path ? `${finding.path}: ` : ""}${finding.reason}`}
              {finding.suggestedFix ? <span className="ds-muted">{` — ${finding.suggestedFix}`}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PlanTodoBlock({ item, isUk }: { item: AgentPlanItem; isUk: boolean }): React.ReactElement {
  return (
    // `data-kind="plan"` and the `✓`/`•` step lines are the C7 contract and are covered by existing tests.
    <div className="data-studio-alert info" role="status" data-kind="plan">
      <div>{item.title ?? (isUk ? "План" : "Plan")}</div>
      <ul>
        {item.steps.map((step, stepIndex) => (
          <li key={`step-${stepIndex}`}>{`${step.done ? "✓" : "•"} ${step.text}`}</li>
        ))}
      </ul>
      {item.goal ? <GoalSection goal={item.goal} isUk={isUk} /> : null}
      {item.verification ? <VerificationSection verification={item.verification} isUk={isUk} /> : null}
      {item.selfReview ? <SelfReviewSection review={item.selfReview} isUk={isUk} /> : null}
    </div>
  );
}
