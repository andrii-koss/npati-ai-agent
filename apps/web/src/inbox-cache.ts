import { loadCompanyScopes } from "./company-scope";
import { api, type EmailThread } from "./email-inbox-shared";

export type InboxFolderCounts = Record<"inbox" | "sent" | "drafts" | "archived" | "spam", number>;
export interface InboxFilters { companyId: string; folder: string; accountId: string; status: string; priority: string; search: string; }
export interface InboxCountPage { id: string; counts: InboxFolderCounts; }
export const emptyInboxCounts = (): InboxFolderCounts => ({ inbox: 0, sent: 0, drafts: 0, archived: 0, spam: 0 });
export const inboxThreadsKey = (filters: InboxFilters) => `inbox-threads:${JSON.stringify([filters.companyId, filters.folder, filters.accountId, filters.status, filters.priority, filters.search.trim()])}`;
export const inboxCountsKey = (companyId: string, accountId: string) => `inbox-counts:${companyId}:${accountId}`;
export function sumInboxCounts(pages: InboxCountPage[]): InboxFolderCounts {
  const result = emptyInboxCounts();
  for (const page of pages) for (const key of Object.keys(result) as Array<keyof InboxFolderCounts>) result[key] += Number(page.counts[key] ?? 0);
  return result;
}

/** Existing company-scoped API; publish ready companies without waiting for counts or other companies. */
export async function readInboxThreads(ids: string[], filters: InboxFilters, options: {
  initial?: EmailThread[]; isActive?: () => boolean; onProgress?: (threads: EmailThread[]) => void;
} = {}) {
  const query = new URLSearchParams({ folder: filters.folder });
  if (filters.accountId !== "all") query.set("accountId", filters.accountId);
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.priority !== "all") query.set("priority", filters.priority);
  if (filters.search.trim()) query.set("search", filters.search.trim());
  const merge = (pages: EmailThread[][]) => pages.flat().sort((a,b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt) || a.id.localeCompare(b.id));
  const pages = await loadCompanyScopes(ids, async id => {
    const response = await api<{ threads: EmailThread[] }>(`/companies/${id}/email-inbox/threads?${query}`);
    return response.threads.map(thread => ({ ...thread, companyId: id }));
  }, {
    key: `inbox-threads:${query}`, isActive: options.isActive,
    initial: options.initial ? ids.map(id => options.initial!.filter(thread => thread.companyId === id)) : undefined,
    onProgress: options.onProgress ? pages => options.onProgress!(merge(pages)) : undefined,
  });
  return merge(pages);
}

export async function readInboxCounts(ids: string[], accountId: string, options: {
  initial?: InboxCountPage[]; isActive?: () => boolean; onProgress?: (pages: InboxCountPage[]) => void;
} = {}) {
  const query = accountId !== "all" ? `?accountId=${encodeURIComponent(accountId)}` : "";
  return loadCompanyScopes(ids, async id => {
    const response = await api<{ counts: InboxFolderCounts }>(`/companies/${id}/email-inbox/folder-counts${query}`);
    return { id, counts: response.counts };
  }, { key: `inbox-counts:${accountId}`, isActive: options.isActive, onProgress: options.onProgress,
    initial: options.initial ? ids.map(id => options.initial!.find(page => page.id === id) ?? { id, counts: emptyInboxCounts() }) : undefined,
  });
}
