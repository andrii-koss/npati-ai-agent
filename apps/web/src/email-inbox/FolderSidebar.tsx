import type { EmailAccount } from "../email-inbox-shared";
import { useTranslation } from "../i18n";

export type EmailFolder = "inbox" | "sent" | "drafts" | "archived" | "spam";

export interface FolderSidebarProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  selectedAccountId: string;
  onSelectAccount: (accountId: string) => void;
  accounts: EmailAccount[];
  folder: EmailFolder;
  onSelectFolder: (folder: EmailFolder) => void;
  folderCounts: Record<EmailFolder, number>;
}

export function FolderSidebar({
  sidebarCollapsed,
  onToggleSidebar,
  selectedAccountId,
  onSelectAccount,
  accounts,
  folder,
  onSelectFolder,
  folderCounts,
}: FolderSidebarProps) {
  const { t } = useTranslation();

  const folderItems: Array<{
    id: EmailFolder;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      id: "inbox",
      label: t("emailInbox.sidebar.folders.inbox"),
      icon: (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 14h5.5l1.5 2.5h4l1.5-2.5H21" />
        </svg>
      ),
    },
    {
      id: "sent",
      label: t("emailInbox.sidebar.folders.sent"),
      icon: (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 3l19 9-19 9 4-9-4-9z" />
          <path d="M6.5 12h8" />
        </svg>
      ),
    },
    {
      id: "drafts",
      label: t("emailInbox.sidebar.folders.drafts"),
      icon: (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      ),
    },
    {
      id: "archived",
      label: t("emailInbox.sidebar.folders.archived"),
      icon: (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="21 8 21 20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
          <rect x="3" y="3" width="18" height="5" rx="1" />
          <polyline points="9 13.5 12 16.5 15 13.5" />
          <line x1="12" y1="10.5" x2="12" y2="16.5" />
        </svg>
      ),
    },
    {
      id: "spam",
      label: t("emailInbox.sidebar.folders.spam"),
      icon: (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      ),
    },
  ];

  return (
    <aside className={`email-inbox-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
      <div className="email-inbox-sidebar-header">
        {!sidebarCollapsed && <span className="email-inbox-label">{t("emailInbox.sidebar.accountLabel")}</span>}
        <button
          type="button"
          className="email-sidebar-toggle-btn"
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? t("emailInbox.sidebar.expandSidebar") : t("emailInbox.sidebar.collapseSidebar")}
          aria-label={sidebarCollapsed ? t("emailInbox.sidebar.expandSidebar") : t("emailInbox.sidebar.collapseSidebar")}
        >
          {sidebarCollapsed ? "▶" : "◀"}
        </button>
      </div>

      {!sidebarCollapsed && (
        <div>
          <select
            value={selectedAccountId}
            onChange={(e) => onSelectAccount(e.target.value)}
            className="email-inbox-select"
            aria-label={t("emailInbox.sidebar.filterAccountAria")}
          >
            <option value="all">{t("emailInbox.sidebar.allAccounts").replace("{count}", String(accounts.length))}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName || a.emailAddress}
              </option>
            ))}
          </select>
        </div>
      )}

      <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {!sidebarCollapsed && <span className="email-inbox-label">{t("emailInbox.sidebar.foldersLabel")}</span>}
        {folderItems.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`email-inbox-folder-btn ${folder === f.id ? "active" : ""}`}
            onClick={() => onSelectFolder(f.id)}
            title={f.label}
          >
            <span className="email-folder-btn-content">
              <span className="email-folder-icon">{f.icon}</span>
              {!sidebarCollapsed && <span>{f.label}</span>}
            </span>
            {!sidebarCollapsed && (
              <span className="email-folder-count">({folderCounts[f.id]})</span>
            )}
          </button>
        ))}
      </nav>
    </aside>
  );
}
