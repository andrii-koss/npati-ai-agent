import type { WorkspaceOverview } from "./business-workspace-shared";
import type { Agent, BrowserCampaignTarget, BrowserEmailAccount, Company, CompanyAutomation } from "./automations/types";
import { createSettingsRecordsOpener } from "./settings-records-page-read";
import { api } from "./workspace-api";

export type AutomationFilters = { companyId?: string; status?: "active" | "paused"; search?: string };
export type AutomationsPageData = {
  items: CompanyAutomation[];
  counts: { total: number; active: number; paused: number; agentsCount: number } | null;
  nextCursor: string | null;
  companies?: Company[];
  agents?: Agent[];
  browser?: { targets: BrowserCampaignTarget[]; emailAccounts: BrowserEmailAccount[] };
  campaignOptions?: Array<Pick<CompanyAutomation, "id" | "name">>;
  overview?: WorkspaceOverview;
};

export const automationsPageKey = (companyId?: string) => `automations:page:${companyId ?? "all"}`;

export function fetchAutomationsPage(filters: AutomationFilters, cursor?: string, includeWorkspace = false) {
  const params = new URLSearchParams();
  if (filters.companyId) params.set("companyId", filters.companyId);
  if (filters.status) params.set("status", filters.status);
  if (filters.search) params.set("search", filters.search);
  if (cursor) params.set("cursor", cursor);
  if (includeWorkspace) params.set("workspace", "1");
  return api<AutomationsPageData>(params.size ? `/automations/page?${params}` : "/automations/page");
}

export const openAutomationsPage = createSettingsRecordsOpener(automationsPageKey, companyId => fetchAutomationsPage({ companyId }, undefined, true));
