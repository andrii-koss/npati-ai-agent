import type { GoalCounts, GoalPageQuery } from "@npati/workspace";
import type { WorkspaceOverview } from "./business-workspace-shared";
import { api, type Goal } from "./goals-types";
import { requestSettingsRead } from "./settings-page-cache";
import { getStoredAuthToken } from "./AuthContext";

export type GoalsPageData = {
  goals: Goal[];
  counts: GoalCounts | null;
  nextCursor: string | null;
  overview?: WorkspaceOverview;
};

type GoalsFilters = Omit<GoalPageQuery, "after">;
type Consumer = "page" | "workspace";
let opening: { token: string | null; key: string; consumer: Consumer; request: Promise<GoalsPageData> } | undefined;

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

export function openGoalsPage(businessId?: string, consumer: Consumer = "page") {
  const token = getStoredAuthToken();
  const key = goalsPageKey(businessId);
  // The lazy route and the workspace may mount at different times during auth restoration.
  if (opening?.token === token && opening.key === key && opening.consumer !== consumer) {
    const { request } = opening;
    opening = undefined;
    return request;
  }
  const request = requestSettingsRead(key, () => fetchGoalsPage({ businessId }, undefined, true));
  opening = { token, key, consumer, request };
  return request;
}
