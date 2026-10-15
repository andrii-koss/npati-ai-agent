import { Link } from "react-router-dom";
import { useTranslation } from "../i18n";
import type { Company } from "./types";
import { translatedStatus } from "./types";

export interface CompanyHeaderProps {
  selected?: Company;
  notice: string;
  noticeIsSuccess: boolean;
  onClearNotice: () => void;
  onOpenCompanyEditor: (company?: Company) => void;
  onOpenAgentEditor: () => void;
  onDeleteCompany: () => void | Promise<void>;
}

export function CompanyHeader({
  selected,
  notice,
  noticeIsSuccess,
  onClearNotice,
  onOpenCompanyEditor,
  onOpenAgentEditor,
  onDeleteCompany,
}: CompanyHeaderProps) {
  const { t } = useTranslation();

  return (
    <>
      <header className="company-page-header">
        <div>
          <p className="eyebrow">{t("companySettings.header.eyebrow")}</p>
          <div className="company-title-row">
            <Link
              to="/settings"
              className="marketplace-back-button"
              aria-label={t("companySettings.header.backToSettings")}
              title={t("companySettings.header.backToSettings")}
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
            <h1
              className="company-header-title"
              title={selected ? selected.name : t("companySettings.header.buildTitle")}
            >
              {selected ? selected.name : t("companySettings.header.buildTitle")}
            </h1>
            {selected && <span className={`company-status ${selected.status}`}>{translatedStatus(t, selected.status)}</span>}

            {selected && (
              <div className="company-title-actions">
                <button
                  type="button"
                  className="content-action-btn edit-btn"
                  onClick={() => onOpenCompanyEditor(selected)}
                  title={t("companySettings.header.editCompanyTitle")}
                >
                  {t("companySettings.header.editCompany")}
                </button>
                <button
                  type="button"
                  className="content-action-btn delete-btn"
                  onClick={() => void onDeleteCompany()}
                  title={t("companySettings.header.deleteTitle")}
                >
                  {t("companySettings.header.deleteBtn")}
                </button>
              </div>
            )}
          </div>
          {selected?.description && selected.description !== selected.name && selected.description !== "New Company" && (
            <p className="company-header-desc">{selected.description}</p>
          )}
        </div>
        <div className="company-header-actions">
          <button className="button-secondary" onClick={() => onOpenCompanyEditor()}>
            {t("companySettings.header.newCompany")}
          </button>
          {selected && (
            <button className="button-primary automations-action-primary" onClick={onOpenAgentEditor}>
              {t("companySettings.header.addAgent")}
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div className={`company-notice-banner ${noticeIsSuccess ? "success" : "error"}`}>
          <span className="company-notice-icon" aria-hidden="true">
            {noticeIsSuccess ? "✓" : "⚠"}
          </span>
          <div className="company-notice-content">
            <strong>{noticeIsSuccess ? t("companySettings.notices.updateCompleted") : t("companySettings.notices.systemAlert")}</strong>
            <span>{notice}</span>
          </div>
          <button
            type="button"
            className="company-notice-close"
            onClick={onClearNotice}
            aria-label={t("companySettings.misc.dismissNotice")}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
