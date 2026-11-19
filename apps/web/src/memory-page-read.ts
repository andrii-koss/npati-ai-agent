import type { MemoryCounts, MemoryPageQuery } from "@npati/workspace";
import type { WorkspaceOverview } from "./business-workspace-shared";
import type { MemoryItem } from "./memory-types";
import { createSettingsRecordsOpener } from "./settings-records-page-read";
import { api } from "./workspace-api";

type MemoryPageData = {
  items: MemoryItem[];
  counts: MemoryCounts | null;
  nextCursor: string | null;
  overview?: WorkspaceOverview;
};

type Filters = Omit<MemoryPageQuery, "after">;

export const memoryPageKey = (businessId?: string) => `memory:page:${businessId ?? "all"}`;

export function fetchMemoryPage(filters: Filters, cursor?: string, includeWorkspace = false) {
  const params = new URLSearchParams();
  if (filters.businessId) params.set("businessId", filters.businessId);
  if (filters.category) params.set("category", filters.category);
  if (filters.search) params.set("search", filters.search);
  if (filters.searchTypes?.length) params.set("searchTypes", filters.searchTypes.join(","));
  if (cursor) params.set("cursor", cursor);
  if (includeWorkspace) params.set("workspace", "1");
  return api<MemoryPageData>(params.size ? `/memory/page?${params}` : "/memory/page");
}

export const openMemoryPage = createSettingsRecordsOpener(memoryPageKey, businessId => fetchMemoryPage({ businessId }, undefined, true));
