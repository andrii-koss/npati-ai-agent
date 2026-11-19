import type { GoalCounts, GoalPageQuery } from "@npati/workspace";
import type { WorkspaceOverview } from "./business-workspace-shared";
import { api, type Goal } from "./goals-types";
import { createSettingsRecordsOpener } from "./settings-records-page-read";

export type GoalsPageData = {
  goals: Goal[];
  counts: GoalCounts | null;
  nextCursor: string | null;
  overview?: WorkspaceOverview;
};

type GoalsFilters = Omit<GoalPageQuery, "after">;

export const goalsPageKey = (businessId?: string) => `goals:page:${businessId ?? "all"}`;

export function fetchGoalsPage(filters: GoalsFilters, cursor?: string, includeWorkspace = false) {
  const params = new URLSearchParams();
  if (filters.businessId) params.set("businessId", filters.businessId);
  if (filters.status) params.set("status", filters.status);
  if (filters.priority) params.set("priority", String(filters.priority));
  if (filters.search) params.set("search", filters.search);
  if (cursor) params.set("cursor", cursor);
  if (includeWorkspace) params.set("workspace", "1");
  return api<GoalsPageData>(params.size ? `/goals/page?${params}` : "/goals/page");
}

export const openGoalsPage = createSettingsRecordsOpener(goalsPageKey, businessId => fetchGoalsPage({ businessId }, undefined, true));
