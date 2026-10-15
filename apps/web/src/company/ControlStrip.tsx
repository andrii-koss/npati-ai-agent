import { useTranslation } from "../i18n";
import type { Company, Agent } from "./types";
import { SELECTED_COMPANY_ID_KEY } from "./cache";

export interface ControlStripProps {
  companies: Company[];
  selected: Company;
  selectedId: string;
  onSelectCompanyId: (id: string) => void;
  agents: Agent[];
  businesses?: Array<{ id: string; name: string }>;
  onUpdateBusiness: (businessId: string) => void | Promise<void>;
}

export function ControlStrip({
  companies,
  selected,
  selectedId,
  onSelectCompanyId,
  agents,
  businesses,
  onUpdateBusiness,
}: ControlStripProps) {
  const { t } = useTranslation();

  return (
    <section className="company-control-strip">
      {/* Block 1: Обираємо компанію */}
      <div className="company-strip-card">
        <div className="company-strip-eyebrow">
          <span className="company-strip-label">{t("companySettings.strip.company")}</span>
          <span className="company-strip-badge badge-active">{t("companySettings.strip.active")}</span>
        </div>
        <div className="company-strip-control-row">
          <select
            aria-label={t("companySettings.strip.selectCompany")}
            value={selectedId}
            onChange={(event) => {
              const next = event.target.value;
              onSelectCompanyId(next);
              try {
                sessionStorage.setItem(SELECTED_COMPANY_ID_KEY, next);
                localStorage.setItem(SELECTED_COMPANY_ID_KEY, next);
              } catch {}
            }}
            className="company-strip-select"
          >
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        </div>
        <span
          className="company-strip-footer-text"
          title={`${t("companySettings.strip.mainOrchestrator")} ${agents.find((a) => a.id === selected.mainAgentId)?.name ?? t("companySettings.header.addAgent")}`}
        >
          {t("companySettings.strip.mainOrchestrator")} {agents.find((a) => a.id === selected.mainAgentId)?.name ?? t("companySettings.header.addAgent")}
        </span>
      </div>

      {/* Block 2: Обираємо бізнес який є створений і підходить */}
      <div className="company-strip-card">
        <div className="company-strip-eyebrow">
          <span className="company-strip-label">{t("companySettings.strip.linkedBusiness")}</span>
          <span className="company-strip-badge badge-linked">{t("companySettings.strip.linked")}</span>
        </div>
        <div className="company-strip-control-row">
          <select
            aria-label={t("companySettings.strip.selectLinkedBusiness")}
            value={selected.businessId ?? ""}
            onChange={(event) => void onUpdateBusiness(event.target.value)}
            className="company-strip-select"
          >
            <option value="">{t("companySettings.strip.independent")}</option>
            {businesses?.map((business) => (
              <option key={business.id} value={business.id}>
                {business.name}
              </option>
            ))}
          </select>
        </div>
        <span
          className="company-strip-footer-text"
          title={t("companySettings.strip.contextConnected")}
        >
          {t("companySettings.strip.contextConnected")}
        </span>
      </div>

      {/* Block 3: Кількість агентів */}
      <div className="company-strip-card">
        <div className="company-strip-eyebrow">
          <span className="company-strip-label">{t("companySettings.strip.totalAgents")}</span>
          <span className="company-strip-badge badge-hierarchy">{t("companySettings.strip.hierarchy")}</span>
        </div>
        <div className="company-strip-control-row">
          <strong>{t("companySettings.strip.agentsCount", { count: String(agents.length) })}</strong>
        </div>
        <span className="company-strip-footer-text" title={t("companySettings.strip.readyForTasks")}>
          {t("companySettings.strip.readyForTasks")}
        </span>
      </div>
    </section>
  );
}
