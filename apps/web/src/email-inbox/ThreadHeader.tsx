import type { EmailThread } from "../email-inbox-shared";
import { useTranslation } from "../i18n";

export interface ThreadHeaderProps {
  activeThread: EmailThread;
  threadHeaderExpanded: boolean;
  onToggleThreadHeaderExpanded: (expanded: boolean) => void;
  readingFocus: boolean;
  onToggleReadingFocus: () => void;
  language: string;
  onUpdateActiveThread: (patch: Partial<EmailThread>) => void;
  onDeleteActiveThread: () => void;
  onToggleTakeover: () => void;
  onToggleVip: () => void;
}

export function ThreadHeader({
  activeThread,
  threadHeaderExpanded,
  onToggleThreadHeaderExpanded,
  readingFocus,
  onToggleReadingFocus,
  language,
  onUpdateActiveThread,
  onDeleteActiveThread,
  onToggleTakeover,
  onToggleVip,
}: ThreadHeaderProps) {
  const { t } = useTranslation();

  return (
    <div className={`email-inbox-detail-header ${threadHeaderExpanded ? "expanded" : "compact"}`}>
      {!threadHeaderExpanded ? (
        /* Compact Header Bar */
        <div className="email-header-compact-row">
          <div className="email-header-compact-left">
            <button
              type="button"
              className="email-header-toggle-btn"
              onClick={() => onToggleThreadHeaderExpanded(true)}
              title={t("emailInbox.threadDetail.detailsToggleTitle")}
            >
              {t("emailInbox.threadDetail.detailsToggle")}
            </button>

            <strong
              className="email-header-compact-subject"
              title={activeThread.subject}
            >
              {activeThread.subject}
            </strong>

            <span className="email-header-compact-sender">
              {t("emailInbox.threadDetail.fromPrefix")}{activeThread.customerName || activeThread.customerEmail}
            </span>
          </div>

          <div className="email-header-compact-actions">
            <button
              type="button"
              className="automation-action-btn"
              onClick={() => void onUpdateActiveThread({ folder: activeThread.folder === "spam" ? "inbox" : "spam" })}
              style={{ fontSize: 11.5, padding: "3px 8px" }}
              title={activeThread.folder === "spam" ? t("emailInbox.threadDetail.notSpamTitle") : t("emailInbox.threadDetail.spamTitle")}
            >
              {activeThread.folder === "spam" ? t("emailInbox.threadDetail.notSpamBtn") : t("emailInbox.threadDetail.spamBtn")}
            </button>
            <button
              type="button"
              className="automation-action-btn danger"
              onClick={onDeleteActiveThread}
              style={{ fontSize: 11.5, padding: "3px 8px" }}
              title={t("emailInbox.threadDetail.deleteThreadTitle")}
            >
              {t("emailInbox.threadDetail.deleteBtn")}
            </button>
            <button
              type="button"
              className={`email-expand-pane-btn ${readingFocus ? "active" : ""}`}
              onClick={onToggleReadingFocus}
              style={{ fontSize: 11.5, padding: "3px 8px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
              title={readingFocus ? t("emailInbox.threadDetail.restoreSplitView") : t("emailInbox.threadDetail.expandReadingView")}
              aria-label={readingFocus ? t("emailInbox.threadDetail.restoreSplitView") : t("emailInbox.threadDetail.expandReadingView")}
            >
              {readingFocus ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M4 14h6m0 0v6m0-6L3 21m17-7h-6m0 0v6m0-6l7 7M4 10h6m0 0V4m0 6L3 3m17 7h-6m0 0V4m0 6l7-7" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 3h6m0 0v6m0-6L14 10M9 21H3m0 0v-6m0 6l7-7M3 9V3m0 0h6m-6 0l7 7m11 11v-6m0 6h-6m6 0l-7-7" /></svg>
              )}
            </button>
          </div>
        </div>
      ) : (
        /* Expanded Header */
        <>
          <div className="email-detail-header-top">
            <div className="email-detail-title-area">
              <div className="email-detail-subject-row">
                <button
                  type="button"
                  className="email-header-toggle-btn"
                  onClick={() => onToggleThreadHeaderExpanded(false)}
                  title={t("emailInbox.threadDetail.compactToggleTitle")}
                >
                  {t("emailInbox.threadDetail.compactToggle")}
                </button>
                <h2 className="email-detail-subject">
                  {activeThread.subject}
                </h2>
                {activeThread.isVip && (
                  <span className="email-vip-badge">
                    VIP
                  </span>
                )}
              </div>
              <div className="email-detail-sender-row">
                <span>
                  {t("emailInbox.threadDetail.fromPrefix")}<strong>{activeThread.customerName || activeThread.customerEmail}</strong> &lt;{activeThread.customerEmail}&gt;
                </span>
                <span>
                  {new Date(activeThread.lastMessageAt).toLocaleString(language)}
                </span>
              </div>
            </div>

            <div className="email-detail-top-controls">
              <button
                type="button"
                className={`email-expand-pane-btn ${readingFocus ? "active" : ""}`}
                onClick={onToggleReadingFocus}
                title={readingFocus ? t("emailInbox.threadDetail.restoreSplitView") : t("emailInbox.threadDetail.expandReadingView")}
              >
                {readingFocus ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M4 14h6m0 0v6m0-6L3 21m17-7h-6m0 0v6m0-6l7 7M4 10h6m0 0V4m0 6L3 3m17 7h-6m0 0V4m0 6l7-7" /></svg>
                    <span>{t("emailInbox.threadDetail.splitView")}</span>
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 3h6m0 0v6m0-6L14 10M9 21H3m0 0v-6m0 6l7-7M3 9V3m0 0h6m-6 0l7 7m11 11v-6m0 6h-6m6 0l-7-7" /></svg>
                    <span>{t("emailInbox.threadDetail.expandView")}</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Actions Toolbar */}
          <div className="email-detail-actions-bar">
            <div className="email-detail-actions-left">
              <div className="email-priority-selector">
                <span>{t("emailInbox.threadDetail.priorityLabel")}</span>
                <select
                  className="email-inbox-select priority-select"
                  aria-label={t("emailInbox.threadDetail.priorityAria")}
                  value={activeThread.priority}
                  onChange={(e) => void onUpdateActiveThread({ priority: e.target.value as EmailThread["priority"] })}
                >
                  <option value="low">{t("emailInbox.priorities.low")}</option>
                  <option value="normal">{t("emailInbox.priorities.normal")}</option>
                  <option value="high">{t("emailInbox.priorities.high")}</option>
                  <option value="urgent">{t("emailInbox.priorities.urgent")}</option>
                </select>
              </div>

              <button
                type="button"
                className={`automation-action-btn ${activeThread.isHumanTakeover ? "active" : ""}`}
                onClick={onToggleTakeover}
                title={t("emailInbox.threadDetail.takeOverTitle")}
              >
                {activeThread.isHumanTakeover ? t("emailInbox.threadDetail.returnToAi") : t("emailInbox.threadDetail.takeOver")}
              </button>

              <button
                type="button"
                className={`automation-action-btn ${activeThread.isVip ? "active" : ""}`}
                onClick={onToggleVip}
                title={t("emailInbox.threadDetail.vipTitle")}
              >
                {activeThread.isVip ? t("emailInbox.threadDetail.vipCustomer") : t("emailInbox.threadDetail.makeVip")}
              </button>
            </div>

            <div className="email-detail-actions-right">
              <button
                type="button"
                className="automation-action-btn"
                onClick={() => void onUpdateActiveThread({ folder: activeThread.folder === "archived" ? "inbox" : "archived" })}
                title={activeThread.folder === "archived" ? t("emailInbox.threadDetail.unarchiveTitle") : t("emailInbox.threadDetail.archiveTitle")}
              >
                {activeThread.folder === "archived" ? t("emailInbox.threadDetail.unarchive") : t("emailInbox.threadDetail.archive")}
              </button>
              <button
                type="button"
                className="automation-action-btn"
                onClick={() => void onUpdateActiveThread({ folder: activeThread.folder === "spam" ? "inbox" : "spam" })}
                title={activeThread.folder === "spam" ? t("emailInbox.threadDetail.notSpamTitle") : t("emailInbox.threadDetail.spamTitle")}
              >
                {activeThread.folder === "spam" ? t("emailInbox.threadDetail.notSpamBtn") : t("emailInbox.threadDetail.spamBtn")}
              </button>
              <button
                type="button"
                className="automation-action-btn danger"
                onClick={onDeleteActiveThread}
                title={t("emailInbox.threadDetail.deleteThreadTitle")}
              >
                {t("emailInbox.threadDetail.deleteBtn")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
