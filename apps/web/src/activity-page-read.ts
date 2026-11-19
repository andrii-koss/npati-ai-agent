import type { CompanyItem, CompanyRun, ActiveRunDetails, RunStatusFilter } from "./activity-types";
import type { MonitorData } from "./CodeRunMonitor";
import type { RunSnapshotData } from "./CodeSnapshotPanel";
import { readSettingsSnapshot, requestSettingsRead, writeSettingsSnapshot } from "./settings-page-cache";
import { api } from "./workspace-api";

export interface ActivityFilters {
  company: string;
  status: RunStatusFilter;
  search: string;
}

export interface ActivityDetail {
  runId: string;
  agent: ActiveRunDetails | null;
  code: MonitorData | null;
  snapshot: RunSnapshotData;
}

export interface ActivityPageSummary {
  companies: CompanyItem[];
  items: CompanyRun[];
  nextCursor: string | null;
  matchingTotal: number;
  counts: { total: number; completed: number; running: number; failed: number };
  securityDecisions?: number;
  selected: CompanyRun | null;
}

type ActivityPage = ActivityPageSummary & { detail: ActivityDetail | null };

export function activityParams(filters: ActivityFilters) {
  const params = new URLSearchParams();
  if (filters.company !== "all") params.set("company", filters.company);
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.search) params.set("search", filters.search);
  return params;
}

export function activityPageKey(filters: ActivityFilters) {
  const suffix = activityParams(filters).toString();
  return suffix && (filters.status !== "all" || filters.search)
    ? `activity:filtered:${suffix}`
    : `activity:page:${filters.company}`;
}

export function readActivitySnapshot(filters: ActivityFilters, runId?: string | null) {
  const summary = readSettingsSnapshot<ActivityPageSummary>(activityPageKey(filters));
  return runId && summary?.selected?.id !== runId ? undefined : summary;
}

export function cacheActivityPage(filters: ActivityFilters, data: ActivityPage) {
  const { detail, ...summary } = data;
  if (detail) writeSettingsSnapshot(`activity:detail:${detail.runId}`, detail, false);
  if (filters.status === "all" && !filters.search) {
    writeSettingsSnapshot(activityPageKey(filters), { ...summary, securityDecisions: detail?.agent?.toolAudit.length ?? 0 });
  }
}

export function readActivityPage(filters: ActivityFilters, runId?: string, cursor?: string) {
  const params = activityParams(filters);
  if (runId) params.set("runId", runId);
  if (cursor) params.set("cursor", cursor);
  const url = `/activity/page${params.size ? `?${params}` : ""}`;
  return requestSettingsRead(url, () => api<ActivityPage>(url), false);
}

export function readActivityDetail(companyId: string, runId: string) {
  return requestSettingsRead(`activity:detail:${runId}`, () =>
    api<ActivityDetail>(`/activity/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(runId)}`), false);
}
