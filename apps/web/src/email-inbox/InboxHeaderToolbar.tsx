import { CompanyScopeSelect } from "../CompanyScopeSelect";
import { PageGuideLink } from "../PageGuideLink";
import { Link } from "react-router-dom";
import type { Company, EmailAccount, EmailNotification } from "../email-inbox-shared";
import { useTranslation } from "../i18n";

export interface InboxHeaderToolbarProps {
  selectedCompanyId: string;
  onSelectCompanyId: (id: string) => void;
  companies: Company[];
  accounts: EmailAccount[];
  onOpenCompose: () => void;
  notice: { text: string; type: "success" | "error" | "info" } | null;
  onDismissNotice: () => void;
  notifications: EmailNotification[];
  onOpenNotification: (item: EmailNotification) => void;
}

export function InboxHeaderToolbar({
  selectedCompanyId,
  onSelectCompanyId,
  companies,
  accounts,
  onOpenCompose,
  notice,
  onDismissNotice,
  notifications,
  onOpenNotification,
}: InboxHeaderToolbarProps) {
  const { t } = useTranslation();

  const emailSettingsUrl =
    selectedCompanyId && selectedCompanyId !== "personal"
      ? `/settings/email?company=${encodeURIComponent(selectedCompanyId)}`
      : "/settings/email";

  return (
    <>
      {/* Top Header matching /settings/email and /settings/goals */}
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{t("emailInbox.header.eyebrow")}</p>
            <h1>
              <Link
                to={emailSettingsUrl}
                className="marketplace-back-button"
                aria-label={t("emailInbox.header.backAria")}
                title={t("emailInbox.header.backTitle")}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{t("emailInbox.header.title")}</span>
              <PageGuideLink guide="email" />
            </h1>
            <p className="hero-copy">
              {t("emailInbox.header.heroCopy")}
            </p>
          </div>
          <div className="automations-header-actions">
            <Link
              to={emailSettingsUrl}
              className="button-secondary"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              {t("emailInbox.header.emailSettingsBtn")}
            </Link>
          </div>
        </div>
      </header>

      {/* Mailbox Scope & Quick Actions Toolbar matching EmailSettingsPage */}
      <div className="email-scope-toolbar">
        <div className="email-scope-left">
          <div className="email-scope-pill">
            <span className="email-scope-badge">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                {selectedCompanyId === "personal" ? (
                  <>
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </>
                ) : (
                  <>
                    <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
                    <path d="M9 22v-4h6v4" />
                    <path d="M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01" />
                  </>
                )}
              </svg>
              <span>{t("emailInbox.scope.scopeLabel")}</span>
            </span>

            <div className="email-scope-select-wrap">
              <CompanyScopeSelect
                aria-label={t("emailInbox.scope.selectOwnerAria")}
                value={selectedCompanyId}
                onValueChange={(value) => onSelectCompanyId(value)}
                className="email-scope-select"
                title={selectedCompanyId === "personal" ? t("emailInbox.scope.personalOption") : (companies.find((c) => c.id === selectedCompanyId)?.name || selectedCompanyId)}
              >
                <option value="personal">{t("emailInbox.scope.personalOption")}</option>
                {selectedCompanyId && selectedCompanyId !== "all" && selectedCompanyId !== "personal" && !companies.some((c) => c.id === selectedCompanyId) && (
                  <option key={selectedCompanyId} value={selectedCompanyId} title={selectedCompanyId}>
                    {selectedCompanyId}
                  </option>
                )}
                {companies.map((c) => (
                  <option key={c.id} value={c.id} title={c.name}>
                    {c.name}
                  </option>
                ))}
              </CompanyScopeSelect>
              <svg className="email-scope-select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </div>
          </div>
          <span className="email-scope-context-hint">
            {selectedCompanyId === "all" ? "All companies" : selectedCompanyId === "personal"
              ? t("emailInbox.scope.personalHint")
              : `${t("emailInbox.scope.companyHintPrefix")}${companies.find((c) => c.id === selectedCompanyId)?.name || t("emailInbox.scope.selectedOrgFallback")}`}
          </span>
        </div>

        <div className="email-scope-right">
          <button
            type="button"
            className="email-compose-btn"
            onClick={onOpenCompose}
            disabled={accounts.length === 0}
            title={accounts.length ? t("emailInbox.scope.composeTitleCan") : t("emailInbox.scope.composeTitleCant")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span>{t("emailInbox.scope.composeBtn")}</span>
          </button>
        </div>
      </div>

      {notice && (
        <div className={`workspace-notice ${notice.type}`} style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>{notice.type === "success" ? "✓" : notice.type === "error" ? "⚠️" : "ℹ️"}</span>
            <span>{notice.text}</span>
          </div>
          <button
            type="button"
            className="workspace-notice-close"
            onClick={onDismissNotice}
            aria-label={t("emailInbox.notices.dismissNotice")}
          >
            ✕
          </button>
        </div>
      )}

      {notifications.some((item) => !item.isRead) && (
        <section className="workspace-notice" style={{ marginBottom: 16 }} aria-label={t("emailInbox.notices.notificationsHeading")}>
          <strong>{t("emailInbox.notices.notificationsHeading")}</strong>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {notifications.filter((item) => !item.isRead).slice(0, 5).map((item) => (
              <button key={item.id} type="button" className="automation-action-btn" onClick={() => void onOpenNotification(item)} title={item.body}>
                {item.title}
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
