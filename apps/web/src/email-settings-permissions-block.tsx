import type { Dispatch, MutableRefObject, SetStateAction } from "react";

export interface EmailSettingsPermissionsBlockProps {
  setTemplateDrawerOpen: Dispatch<SetStateAction<boolean>>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  editingTemplateId: string | null;
  handleSaveTemplate: any;
  templateTitle: string;
  setTemplateTitle: Dispatch<SetStateAction<string>>;
  templateCategory: string;
  setTemplateCategory: Dispatch<SetStateAction<string>>;
  templateSubject: string;
  setTemplateSubject: Dispatch<SetStateAction<string>>;
  setTemplateBody: Dispatch<SetStateAction<string>>;
  templateBody: string;
  footer: string;
  savingTemplate: boolean;
}

export function EmailSettingsPermissionsBlock({ setTemplateDrawerOpen, t, editingTemplateId, handleSaveTemplate, templateTitle, setTemplateTitle, templateCategory, setTemplateCategory, templateSubject, setTemplateSubject, setTemplateBody, templateBody, footer, savingTemplate }: EmailSettingsPermissionsBlockProps) {
  return (
<div className="company-drawer-backdrop" onMouseDown={() => setTemplateDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>{t("emailSettings.templateDrawer.kicker")}</span>
                <h2>{editingTemplateId ? t("emailSettings.templateDrawer.editTitle") : t("emailSettings.templateDrawer.newTitle")}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label={t("common.close")}
                onClick={() => setTemplateDrawerOpen(false)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <form onSubmit={handleSaveTemplate}>
              <section>
                <h3>{t("emailSettings.templateDrawer.templateDetails")}</h3>
                <label>
                  <span>{t("emailSettings.templateDrawer.titleLabel")}</span>
                  <input
                    required
                    placeholder={t("emailSettings.templateDrawer.titlePlaceholder")}
                    value={templateTitle}
                    onChange={(e) => setTemplateTitle(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("emailSettings.templateDrawer.categoryLabel")}</span>
                  <select value={templateCategory} onChange={(e) => setTemplateCategory(e.target.value)}>
                    <option value="general">{t("emailSettings.templateDrawer.categories.general")}</option>
                    <option value="support">{t("emailSettings.templateDrawer.categories.support")}</option>
                    <option value="billing">{t("emailSettings.templateDrawer.categories.billing")}</option>
                    <option value="sales">{t("emailSettings.templateDrawer.categories.sales")}</option>
                    <option value="information">{t("emailSettings.templateDrawer.categories.information")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("emailSettings.templateDrawer.subjectLabel")}</span>
                  <input
                    placeholder={t("emailSettings.templateDrawer.subjectPlaceholder")}
                    value={templateSubject}
                    onChange={(e) => setTemplateSubject(e.target.value)}
                  />
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.templateDrawer.bodyDetails")}</h3>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: "#64748b", alignSelf: "center", marginRight: 4 }}>{t("emailSettings.templateDrawer.insertVariable")}</span>
                  {["{{customer_name}}", "{{company_name}}", "{{agent_name}}", "{{date}}"].map((v) => (
                    <button
                      key={v}
                      type="button"
                      className="automation-cron-pill"
                      style={{ cursor: "pointer", background: "#f1f5f9" }}
                      onClick={() => setTemplateBody((prev) => prev + " " + v)}
                    >
                      + {v}
                    </button>
                  ))}
                </div>
                <label>
                  <span>{t("emailSettings.templateDrawer.bodyLabel")}</span>
                  <textarea
                    required
                    rows={6}
                    placeholder={t("emailSettings.templateDrawer.bodyPlaceholder")}
                    value={templateBody}
                    onChange={(e) => setTemplateBody(e.target.value)}
                  />
                </label>
              </section>

              <footer style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setTemplateDrawerOpen(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary"
                  disabled={savingTemplate}
                >
                  {savingTemplate ? t("emailSettings.templateDrawer.savingTemplate") : editingTemplateId ? t("emailSettings.templateDrawer.saveTemplate") : t("emailSettings.templateDrawer.createTemplate")}
                </button>
              </footer>
            </form>
          </aside>
        </div>
  );
}
