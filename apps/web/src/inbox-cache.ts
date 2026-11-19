import { api, type Company, type ContactDetails, type CustomerContext, type EmailAccount, type EmailAuditEntry, type EmailMessage, type EmailNotification, type EmailThread } from "./email-inbox-shared";
import { requestSettingsRead } from "./settings-page-cache";

export type InboxFolderCounts = Record<"inbox" | "sent" | "drafts" | "archived" | "spam", number>;
export interface InboxFilters { companyId: string; folder: string; accountId: string; status: string; priority: string; search: string; }
export interface InboxDetail {
  thread: EmailThread;
  messages: EmailMessage[];
  contact: ContactDetails | null;
  customerContext: CustomerContext;
  logs: EmailAuditEntry[];
}
interface InboxOpen {
  companies: Company[];
  accounts: EmailAccount[];
  threads: EmailThread[];
  counts: InboxFolderCounts;
  notifications: EmailNotification[];
  detail: InboxDetail | null;
}

export const inboxThreadsKey = (filters: InboxFilters) => `inbox-threads:${JSON.stringify([filters.companyId, filters.folder, filters.accountId, filters.status, filters.priority, filters.search.trim()])}`;
export const inboxCountsKey = (companyId: string, accountId: string) => `inbox-folder-totals:${companyId}:${accountId}`;
export const inboxDetailKey = (companyId: string, threadId: string) => `inbox-thread-detail:${companyId}:${threadId}`;

export function readInboxOpen(filters: InboxFilters, threadId?: string | null) {
  const query = new URLSearchParams({ company: filters.companyId, folder: filters.folder });
  if (filters.accountId !== "all") query.set("accountId", filters.accountId);
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.priority !== "all") query.set("priority", filters.priority);
  if (filters.search.trim()) query.set("search", filters.search.trim());
  if (threadId) query.set("threadId", threadId);
  return requestSettingsRead(`inbox-open:${query}`, () => api<InboxOpen>(`/email/inbox/open?${query}`), false);
}
