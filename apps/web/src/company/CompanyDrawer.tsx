import type { FormEvent } from "react";
import { useTranslation } from "../i18n";
import type { Company, CompanyDraft } from "./types";
import { CompanyDataAutoAllow } from "./CompanyDataAutoAllow";

export interface CompanyDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  editingCompany: Company | null;
  companyForm: CompanyDraft;
  setCompanyForm: React.Dispatch<React.SetStateAction<CompanyDraft>>;
  saveCompany: (e: FormEvent) => void;
  deleteCompany: () => Promise<void>;
  saving: boolean;
  businesses?: Array<{ id: string; name: string }>;
}

export function CompanyDrawer({
  isOpen,
  onClose,
  editingCompany,
  companyForm,
  setCompanyForm,
  saveCompany,
  deleteCompany,
  saving,
  businesses,
}: CompanyDrawerProps) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={onClose}>
      <aside className="company-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>{t("companySettings.companyDrawer.company")}</span>
            <h2>{editingCompany ? t("companySettings.companyDrawer.companySettings") : t("companySettings.companyDrawer.newCompany")}</h2>
          </div>
          <button type="button" className="company-drawer-close" aria-label={t("companySettings.misc.closeDrawer")} onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <form onSubmit={saveCompany}>
          <section>
            <h3>{t("companySettings.companyDrawer.companyContext")}</h3>
            <label><span>{t("companySettings.companyDrawer.companyName")}</span><input required value={companyForm.name} onChange={(event) => setCompanyForm({ ...companyForm, name: event.target.value })} /></label>
            <label><span>{t("companySettings.companyDrawer.linkedBusiness")}</span><select value={companyForm.businessId} onChange={(event) => setCompanyForm({ ...companyForm, businessId: event.target.value })}>
              <option value="">{t("companySettings.companyDrawer.independent")}</option>{businesses?.map((business) => <option value={business.id} key={business.id}>{business.name}</option>)}
            </select></label>
            <div className="company-form-grid"><label><span>{t("companySettings.companyDrawer.website")}</span><input value={companyForm.website} onChange={(event) => setCompanyForm({ ...companyForm, website: event.target.value })} /></label>
            <label><span>{t("companySettings.companyDrawer.industry")}</span><input value={companyForm.industry} onChange={(event) => setCompanyForm({ ...companyForm, industry: event.target.value })} /></label></div>
            <label><span>{t("companySettings.companyDrawer.description")}</span><textarea value={companyForm.description} onChange={(event) => setCompanyForm({ ...companyForm, description: event.target.value })} /></label>
            <label><span>{t("companySettings.companyDrawer.productsServices")}</span><textarea value={companyForm.productsServices} onChange={(event) => setCompanyForm({ ...companyForm, productsServices: event.target.value })} /></label>
            <div className="company-form-grid"><label><span>{t("companySettings.companyDrawer.languages")}</span><input placeholder={t("companySettings.companyDrawer.languagesPlaceholder")} value={companyForm.languages} onChange={(event) => setCompanyForm({ ...companyForm, languages: event.target.value })} /></label>
            <label><span>{t("companySettings.companyDrawer.brandTone")}</span><input value={companyForm.brandTone} onChange={(event) => setCompanyForm({ ...companyForm, brandTone: event.target.value })} /></label></div>
            <label><span>{t("companySettings.companyDrawer.companyInstructions")}</span><textarea rows={5} value={companyForm.companyInstructions} onChange={(event) => setCompanyForm({ ...companyForm, companyInstructions: event.target.value })} /></label>
          </section>
          {editingCompany ? <CompanyDataAutoAllow companyId={editingCompany.id} /> : null}
          <footer>
            {editingCompany && <button type="button" className="danger-button" onClick={() => void deleteCompany()}>{t("companySettings.companyDrawer.deleteCompany")}</button>}
            <span />
            <button type="button" className="button-secondary" onClick={onClose}>{t("companySettings.companyDrawer.cancel")}</button>
            <button className="button-primary" disabled={saving}>{saving ? t("companySettings.companyDrawer.saving") : t("companySettings.companyDrawer.save")}</button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
