import type { EmailThread } from "../email-inbox-shared";
import { getStatusLabel } from "../email-inbox-shared";
import { useTranslation } from "../i18n";
import type { EmailFolder } from "./FolderSidebar";
import { SettingsListMore, useProgressiveSettingsItems } from "../useProgressiveSettingsItems";

export interface ThreadListColumnProps {
  readingFocus: boolean;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  statusFilter: string;
  onStatusFilterChange: (status: string) => void;
  priorityFilter: string;
  onPriorityFilterChange: (priority: string) => void;
  folder: EmailFolder;
  threads: EmailThread[];
  loading?: boolean;
  listKey?: string;
  selectedThreadId: string | null;
  onOpenThread: (thread: EmailThread) => void;
  language: string;
}

function getEmptyFolderTitle(folder: EmailFolder, t: (k: string) => string): string {
  const prefix = t("emailInbox.threadsList.emptyFolderTitlePrefix");
  switch (folder) {
    case "inbox":
      return `${prefix} ${t("emailInbox.sidebar.folders.inbox")}`;
    case "sent":
      return `${prefix} ${t("emailInbox.sidebar.folders.sent")}`;
    case "drafts":
      return `${prefix} ${t("emailInbox.sidebar.folders.drafts")}`;
    case "archived":
      return `${prefix} ${t("emailInbox.sidebar.folders.archived")}`;
    case "spam":
      return `${prefix} ${t("emailInbox.sidebar.folders.spam")}`;
  }
}

function getEmptyFolderHint(folder: EmailFolder, t: (k: string) => string): string {
  switch (folder) {
    case "inbox":
      return t("emailInbox.threadsList.emptyFolderHints.inbox");
    case "sent":
      return t("emailInbox.threadsList.emptyFolderHints.sent");
    case "drafts":
      return t("emailInbox.threadsList.emptyFolderHints.drafts");
    case "archived":
      return t("emailInbox.threadsList.emptyFolderHints.archived");
    case "spam":
      return t("emailInbox.threadsList.emptyFolderHints.spam");
  }
}

export function ThreadListColumn({
  readingFocus,
  searchQuery,
  onSearchQueryChange,
  statusFilter,
  onStatusFilterChange,
  priorityFilter,
  onPriorityFilterChange,
  folder,
  threads,
  loading = false,
  listKey = "",
  selectedThreadId,
  onOpenThread,
  language,
}: ThreadListColumnProps) {
  const { t } = useTranslation();
  const visiblePage = useProgressiveSettingsItems(threads, `${listKey}:${folder}:${statusFilter}:${priorityFilter}:${searchQuery}`, 20);
  const selected = threads.find(thread => thread.id === selectedThreadId);
  const visibleThreads = selected && !visiblePage.items.some(thread => thread.id === selectedThreadId) ? [...visiblePage.items, selected] : visiblePage.items;

  return (
    <div className={`email-inbox-threads-col ${readingFocus ? "hidden" : ""}`}>
      {/* Search & Filter Bar */}
      <div className="email-inbox-threads-header">
        <div className="inspector-search-box" style={{ width: "100%" }}>
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            placeholder={t("emailInbox.threadsList.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            className="inspector-search-input"
            aria-label={t("emailInbox.threadsList.searchAria")}
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => onSearchQueryChange("")}
              aria-label={t("emailInbox.threadsList.clearSearch")}
            >
              ×
            </button>
          )}
        </div>

        <div className="email-threads-filters-row">
          <select
            value={statusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value)}
            className="email-inbox-select filter-select"
            aria-label={t("emailInbox.threadsList.filterStatusAria")}
          >
            <option value="all">{t("emailInbox.statusFilters.all")}</option>
            <option value="new">{t("emailInbox.statusFilters.new")}</option>
            <option value="draft_ready">{t("emailInbox.statusFilters.draftReady")}</option>
            <option value="waiting_approval">{t("emailInbox.statusFilters.waitingApproval")}</option>
            <option value="answered">{t("emailInbox.statusFilters.answered")}</option>
          </select>
          <select
            value={priorityFilter}
            onChange={(e) => onPriorityFilterChange(e.target.value)}
            className="email-inbox-select filter-select"
            aria-label={t("emailInbox.threadsList.filterPriorityAria")}
          >
            <option value="all">{t("emailInbox.priorities.all")}</option>
            <option value="urgent">{t("emailInbox.priorities.urgent")}</option>
            <option value="high">{t("emailInbox.priorities.high")}</option>
            <option value="normal">{t("emailInbox.priorities.normal")}</option>
          </select>
        </div>
      </div>

      {/* Threads Scroll List */}
      <div className="email-inbox-threads-scroll">
        {threads.length === 0 && loading ? (
          <div role="status" style={{ padding: "40px 20px", textAlign: "center" }}>{language === "uk" ? "Завантаження листування…" : "Loading conversations..."}</div>
        ) : threads.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
            <strong style={{ display: "block", marginBottom: 4, color: "#1e293b" }}>
              {getEmptyFolderTitle(folder, t)}
            </strong>
            <small style={{ color: "#475569" }}>{getEmptyFolderHint(folder, t)}</small>
          </div>
        ) : (
          visibleThreads.map((tItem) => {
            const isSelected = tItem.id === selectedThreadId;
            return (
              <div
                key={tItem.id}
                onClick={() => onOpenThread(tItem)}
                className={`email-inbox-thread-card ${isSelected ? "active" : ""} ${tItem.unreadCount > 0 ? "unread" : ""}`}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, fontSize: 13, fontWeight: tItem.unreadCount > 0 ? 700 : 600, color: "#0f172a" }}>
                    {tItem.unreadCount > 0 && <span className="email-thread-unread-dot" aria-label={t("emailInbox.threadsList.unreadAria")} />}
                    {tItem.isVip && <span style={{ color: "#eab308", marginRight: 4 }}>★</span>}
                    {tItem.customerName || tItem.customerEmail}
                  </span>
                  <small style={{ fontSize: 11, color: "#475569", flexShrink: 0 }}>
                    {new Date(tItem.lastMessageAt).toLocaleDateString(language)}
                  </small>
                </div>

                <div style={{ fontSize: 13, color: "#334155", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {tItem.subject}
                </div>

                <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                  <span className={`email-status-pill status-${tItem.status}`}>
                    <span className="email-status-dot" />
                    {getStatusLabel(tItem.status, t)}
                  </span>

                  {tItem.priority === "urgent" && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#dc2626", background: "#fef2f2", padding: "2px 6px", borderRadius: 4 }}>
                      {t("emailInbox.priorities.urgent")}
                    </span>
                  )}
                  {tItem.priority === "high" && (
                    <span style={{ fontSize: 10, fontWeight: 600, color: "#d97706", background: "#fffbeb", padding: "2px 6px", borderRadius: 4 }}>
                      {t("emailInbox.priorities.high")}
                    </span>
                  )}
                  <small className="email-thread-message-count" title={t("emailInbox.threadsList.messagesCountTooltip")}>✉ {tItem.messagesCount ?? 0}</small>
                </div>
              </div>
            );
          })
        )}
        <SettingsListMore state={visiblePage} label={language === "uk" ? "Завантажити ще" : "Load more"} />
      </div>
    </div>
  );
}
