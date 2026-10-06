import React from "react";
import type { AccessDeniedKind } from "./types";

/**
 * C7: workspace states — empty, sandbox failure, connection lost, access denied, flag off.
 *
 * The important one is `AccessDeniedState`: it renders **the same markup for `forbidden` and
 * `not_found`**, takes no id, and names no tenant. If the two looked different, the page would become an
 * existence oracle — a user could probe which session ids exist in another company by comparing the two
 * screens, which is exactly the leak the server-side routes were written to avoid.
 */

export function EmptyWorkspaceState({ isUk = false }: { isUk?: boolean }): React.ReactElement {
  return (
    <div className="browser-empty-state" data-state="empty" role="status">
      <div>{isUk ? "Сесій ще немає" : "No sessions yet"}</div>
      <div className="ds-muted">
        {isUk
          ? "Імпортуйте репозиторій або створіть порожній проєкт, щоб почати."
          : "Import a repository or create an empty project to start."}
      </div>
    </div>
  );
}

export function SandboxErrorState({
  isUk = false,
  code,
  retryable = false,
}: {
  isUk?: boolean;
  code?: string;
  retryable?: boolean;
}): React.ReactElement {
  return (
    <div className="data-studio-alert error" data-state="sandbox_error" role="alert">
      <div>{isUk ? "Sandbox недоступний" : "Sandbox unavailable"}</div>
      <div className="ds-muted">
        {isUk
          ? "Код не виконувався. Спробуйте ще раз; якщо проблема повторюється — перевірте образ і мережу."
          : "No code was executed. Try again; if it repeats, check the image and the network."}
      </div>
      {code ? <div className="ds-muted" data-field="sandbox-code">{code}</div> : null}
      <div className="ds-muted" data-field="sandbox-retryable">
        {retryable ? (isUk ? "можна повторити" : "retryable") : isUk ? "повтор не допоможе" : "not retryable"}
      </div>
    </div>
  );
}

export function ConnectionLostState({ isUk = false }: { isUk?: boolean }): React.ReactElement {
  return (
    <div className="data-studio-alert warning" data-state="connection_lost" role="status">
      {isUk
        ? "Зв'язок втрачено. Стан відновлено з останнього ходу; перевірте Changes перед продовженням."
        : "Connection lost. State was restored from the last turn; review Changes before continuing."}
    </div>
  );
}

/**
 * One component for both refusal kinds, on purpose. `kind` is accepted for logging/eligibility by the
 * caller but must not change what is rendered.
 */
export function AccessDeniedState({
  kind,
  isUk = false,
}: {
  kind: AccessDeniedKind;
  isUk?: boolean;
}): React.ReactElement {
  void kind;
  return (
    <div className="data-studio-alert error" data-state="access_denied" role="alert">
      {isUk ? "Сесію не знайдено або до неї немає доступу." : "Session not found or not accessible."}
    </div>
  );
}

/**
 * C7 criterion 3: with the feature flag off, creating sessions, running, tools and approvals are
 * unavailable — but History, Activity, Changes and Export stay readable. This notice states that split
 * instead of hiding the workspace.
 */
export function FlagDisabledNotice({ isUk = false }: { isUk?: boolean }): React.ReactElement {
  return (
    <div className="data-studio-alert info" data-state="flag_disabled" role="status">
      <div>{isUk ? "Coding Agent вимкнено" : "Coding Agent is disabled"}</div>
      <div className="ds-muted" data-field="flag-disabled-unavailable">
        {isUk
          ? "Недоступно: створення сесій, запуск, інструменти, підтвердження."
          : "Unavailable: creating sessions, running, tools, approvals."}
      </div>
      <div className="ds-muted" data-field="flag-disabled-available">
        {isUk ? "Доступно лише для читання: історія, Activity, Changes, Export." : "Read-only: history, Activity, Changes, Export."}
      </div>
    </div>
  );
}
