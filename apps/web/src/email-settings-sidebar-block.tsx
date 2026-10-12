import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { EmailTemplate } from "./EmailSettingsPage";

export interface EmailSettingsSidebarBlockProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  openCreateTemplateDrawer: any;
  templates: EmailTemplate[];
  openEditTemplateDrawer: any;
  handleDeleteTemplate: any;
}

export function EmailSettingsSidebarBlock({ t, openCreateTemplateDrawer, templates, openEditTemplateDrawer, handleDeleteTemplate }: EmailSettingsSidebarBlockProps) {
  return (
<div className="automations-table-container">
          <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #f1f5f9" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>{t("emailSettings.templatesTab.heading")}</h3>
              <small style={{ color: "#64748b" }}>{t("emailSettings.templatesTab.subtitle")}</small>
            </div>
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={openCreateTemplateDrawer}
            >
              {t("emailSettings.templatesTab.addTemplateBtn")}
            </button>
          </div>
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ width: "240px" }}>{t("emailSettings.templatesTab.colTitle")}</th>
                <th style={{ width: "160px" }}>{t("emailSettings.templatesTab.colCategory")}</th>
                <th>{t("emailSettings.templatesTab.colBody")}</th>
                <th style={{ width: "140px", textAlign: "right" }}>{t("emailSettings.templatesTab.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: "40px", color: "#64748b" }}>
                    {t("emailSettings.templatesTab.empty")}
                  </td>
                </tr>
              ) : (
                templates.map((tmpl) => (
                  <tr key={tmpl.id}>
                    <td>
                      <div className="automation-title-cell">
                        <strong>{tmpl.title}</strong>
                        {tmpl.subjectTemplate && (
                          <small style={{ color: "#64748b", fontSize: 11 }}>Re: {tmpl.subjectTemplate}</small>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="automation-cron-pill" style={{ textTransform: "capitalize" }}>{tmpl.category}</span>
                    </td>
                    <td>
                      <div className="automation-prompt-preview" style={{ maxWidth: "480px" }}>
                        {tmpl.bodyTemplate}
                      </div>
                    </td>
                    <td>
                      <div className="automation-actions-cell">
                        <button
                          type="button"
                          className="automation-action-btn"
                          onClick={() => openEditTemplateDrawer(tmpl)}
                          title={t("emailSettings.templatesTab.actionEditTitle")}
                        >
                          {t("emailSettings.templatesTab.actionEdit")}
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn danger"
                          onClick={() => handleDeleteTemplate(tmpl.id)}
                          title={t("emailSettings.templatesTab.actionDeleteTitle")}
                        >
                          {t("emailSettings.templatesTab.actionDelete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
  );
}
