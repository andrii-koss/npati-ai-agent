import { PageGuideLink } from "./PageGuideLink";
import { useTranslation } from "./i18n";
import { ReactNode } from "react";
import { Link } from "react-router-dom";
export function BusinessSettingsHeader({ title, copy, action, backTo = "/settings", onBack }: {
    title?: string;
    copy: string;
    action?: ReactNode;
    backTo?: string;
    onBack?: () => void;
}) {
    const { t } = useTranslation();
    const displayTitle = title || t("businessSettings.title");
    return (<header className="inspector-header automations-header business-settings-header">
      <div className="automations-header-top">
        <div>
          <p className="eyebrow">{t("businessSettings.eyebrow")}</p>
          <h1>
            {onBack ? <button type="button" className="marketplace-back-button" aria-label={t("businessSettings.backToProfiles")} title={t("businessSettings.backToProfiles")} onClick={onBack}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
            </button> : <Link to={backTo} className="marketplace-back-button" aria-label={backTo === "/settings" ? t("businessSettings.backToSettings") : t("businessSettings.backToProfiles")} title={backTo === "/settings" ? t("businessSettings.backToSettings") : t("businessSettings.backToProfiles")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
            </Link>}
            <span>{displayTitle}</span>
            <PageGuideLink guide="business"/>
          </h1>
          <p className="hero-copy">{copy}</p>
        </div>
        {action && <div className="automations-header-actions">{action}</div>}
      </div>
    </header>);
}
