import { Trash2 } from "lucide-react";
import { CompanyScopeSelect } from "../CompanyScopeSelect";
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
  onOpenMassDelete?: () => void;
  onOpenMassDeleteBusiness?: () => void;
  onOpenMassDeleteAgent?: () => void;
}

export function ControlStrip({
  companies,
  selected,
  selectedId,
  onSelectCompanyId,
  agents,
  businesses,
  onUpdateBusiness,
  onOpenMassDelete,
  onOpenMassDeleteBusiness,
  onOpenMassDeleteAgent,
}: ControlStripProps) {
  const { t } = useTranslation();

  return (
    <section className="company-control-strip">
      {/* Block 1: Обираємо компанію */}
      <div className="company-strip-card">
        {onOpenMassDelete && (
          <button
            type="button"
            className="company-strip-mass-delete-btn"
            onClick={onOpenMassDelete}
            title={t("companySettings.massDelete.openTitle")}
            aria-label={t("companySettings.massDelete.openTitle")}
          >
            <Trash2 size={13} />
          </button>
        )}
        <div className="company-strip-eyebrow">
          <span className="company-strip-label">{t("companySettings.strip.company")}</span>
          <span className="company-strip-badge badge-active">{t("companySettings.strip.active")}</span>
        </div>
        <div className="company-strip-control-row">
          <CompanyScopeSelect
            includeAll={false}
            aria-label={t("companySettings.strip.selectCompany")}
            value={selectedId}
            onValueChange={(next) => {
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
          </CompanyScopeSelect>
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
        {onOpenMassDeleteBusiness && (
          <button
            type="button"
            className="company-strip-mass-delete-btn"
            onClick={onOpenMassDeleteBusiness}
            title={t("companySettings.massDelete.openBusinessTitle")}
            aria-label={t("companySettings.massDelete.openBusinessTitle")}
          >
            <Trash2 size={13} />
          </button>
        )}
        <div className="company-strip-eyebrow">
          <span className="company-strip-label">{t("companySettings.strip.linkedBusiness")}</span>
          <span className="company-strip-badge badge-linked">{t("companySettings.strip.linked")}</span>
        </div>
        <div className="company-strip-control-row">
          <CompanyScopeSelect
            includeAll={false}
            entity="business"
            aria-label={t("companySettings.strip.selectLinkedBusiness")}
            value={selected.businessId ?? ""}
            onValueChange={(value) => void onUpdateBusiness(value)}
            className="company-strip-select"
          >
            <option value="">{t("companySettings.strip.independent")}</option>
            {businesses?.map((business) => (
              <option key={business.id} value={business.id}>
                {business.name}
              </option>
            ))}
          </CompanyScopeSelect>
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
        {onOpenMassDeleteAgent && (
          <button
            type="button"
            className="company-strip-mass-delete-btn"
            onClick={onOpenMassDeleteAgent}
            title={t("companySettings.massDelete.openAgentTitle")}
            aria-label={t("companySettings.massDelete.openAgentTitle")}
          >
            <Trash2 size={13} />
          </button>
        )}
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
