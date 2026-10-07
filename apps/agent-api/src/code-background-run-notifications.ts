import type { MessagingConnectionSettings } from "./messaging-integrations-repository";

/**
 * C10 (ТЗ item 5): which messaging notifications a connection agreed to receive, as a pure decision.
 *
 * It is a named, exported function rather than a filter inlined at the call site, for one reason: the finding that
 * opened this step is that `notifications.backgroundResults` was in the schema, in the migration defaults and in the
 * UI in eight locales while **no server code read it**. A switch that can only be exercised by standing up the
 * whole application is a switch that rots again; this one is asserted directly.
 */
export type MessagingNotificationKind = "automation" | "background_run" | "approval";

export function connectionWantsNotification(
  kind: MessagingNotificationKind,
  settings: MessagingConnectionSettings,
): boolean {
  if (kind === "automation") return settings.notifications.automationResults;
  if (kind === "background_run") return settings.notifications.backgroundResults;
  /**
   * An approval request is something a person has to act on, so it is not silenced by the two result switches: it
   * follows `errors` ("tell me when something needs me"), and a connection that turned every notification off still
   * receives it — a run blocked on an unanswered approval is otherwise stuck forever with nobody told.
   */
  const { automationResults, backgroundResults, errors, status } = settings.notifications;
  return errors || (!automationResults && !backgroundResults && !status);
}
