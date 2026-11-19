import type { GoalPageQuery } from "@npati/workspace";
import { fetchGoalsPage, goalsPageKey, openGoalsPage } from "./goals-page-read";
import { useSettingsRecordsPage } from "./use-settings-records-page";

export function useGoalsPage(filters: Omit<GoalPageQuery, "after">, onError: (message: string) => void) {
  const { businessId, status, priority, search } = filters;
  return useSettingsRecordsPage(filters, {
    scope: goalsPageKey(businessId),
    unfiltered: !status && !priority && !search,
    open: () => openGoalsPage(businessId),
    fetch: fetchGoalsPage,
    append: (current, next) => ({ ...current, goals: [...current.goals, ...next.goals], nextCursor: next.nextCursor }),
    changedEvent: "npati:goals-changed",
    onError,
  });
}
