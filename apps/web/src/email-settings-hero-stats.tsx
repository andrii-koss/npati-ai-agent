import { Link } from "react-router-dom";
import type { EmailAnalytics } from "./email-settings-types";

export function EmailSettingsHeroHeader({
  t,
  selectedCompanyId,
  openCreateDrawer,
}: {
  t: (key: string) => string;
  selectedCompanyId: string;
  openCreateDrawer: () => void;
}) {
  return (
    <header className="inspector-header automations-header">
      <div className="automations-header-top">
        <div>
          <p className="eyebrow">{t("emailSettings.eyebrow")}</p>
          <h1>
            <Link to="/settings" className="marketplace-back-button" aria-label={t("emailSettings.backAria")} title={t("emailSettings.backAria")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
            <span>{t("emailSettings.title")}</span>
          </h1>
          <p className="hero-copy">
            {t("emailSettings.heroCopy")}
          </p>
        </div>
        <div className="automations-header-actions">
          <Link
            to={selectedCompanyId && selectedCompanyId !== "personal" ? `/settings/email/inbox?company=${encodeURIComponent(selectedCompanyId)}` : "/settings/email/inbox"}
            className="button-secondary"
            style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
          >
            {t("emailSettings.openInbox")}
          </Link>
          <button
            type="button"
            className="button-primary automations-action-primary"
            onClick={openCreateDrawer}
            title={t("emailSettings.addEmailTitle")}
          >
            {t("emailSettings.addEmailBtn")}
          </button>
        </div>
      </div>
    </header>
  );
}

export function EmailSettingsStatsCards({
  analytics,
  t,
}: {
  analytics: EmailAnalytics | null;
  t: (key: string) => string;
}) {
  return (
    <section className="overview-grid inspector-stats-grid automations-stats-grid">
      <div>
        <strong>{analytics?.receivedEmails ?? 0}</strong>
        <span>{t("emailSettings.stats.totalReceived")}</span>
        <small>{t("emailSettings.stats.totalReceivedDesc")}</small>
      </div>
      <div>
        <strong>{analytics?.sentEmails ?? 0}</strong>
        <span>{t("emailSettings.stats.totalSent")}</span>
        <small>{t("emailSettings.stats.totalSentDesc")}</small>
      </div>
      <div>
        <strong>{Math.round(analytics?.automationRate ?? 0)}%</strong>
        <span>{t("emailSettings.stats.automationRate")}</span>
        <small>{t("emailSettings.stats.automationRateDesc")}</small>
      </div>
      <div>
        <strong>{analytics?.draftedByAi ?? 0}</strong>
        <span>{t("emailSettings.stats.draftsPrepared")}</span>
        <small>{t("emailSettings.stats.draftsPreparedDesc")}</small>
      </div>
    </section>
  );
}
