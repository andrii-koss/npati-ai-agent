import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Company, ContactItem } from "./EmailSettingsPage";
import { api } from "./EmailSettingsPage";

export interface EmailSettingsTestBlockProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  openCreateContactDrawer: any;
  contacts: ContactItem[];
  openEditContactDrawer: any;
  companies: Company[];
  selectedCompanyId: string;
  setContacts: Dispatch<SetStateAction<ContactItem[]>>;
}

export function EmailSettingsTestBlock({ t, openCreateContactDrawer, contacts, openEditContactDrawer, companies, selectedCompanyId, setContacts }: EmailSettingsTestBlockProps) {
  return (
<div className="automations-table-container">
          <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #f1f5f9" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>{t("emailSettings.contactsTab.heading")}</h3>
              <small style={{ color: "#64748b" }}>{t("emailSettings.contactsTab.subtitle")}</small>
            </div>
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={() => openCreateContactDrawer(true)}
            >
              {t("emailSettings.contactsTab.addContactBtn")}
            </button>
          </div>
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ minWidth: "220px" }}>{t("emailSettings.contactsTab.colContact")}</th>
                <th style={{ minWidth: "140px" }}>{t("emailSettings.contactsTab.colVip")}</th>
                <th style={{ minWidth: "140px" }}>{t("emailSettings.contactsTab.colBlacklisted")}</th>
                <th>{t("emailSettings.contactsTab.colNotes")}</th>
                <th style={{ width: "160px", textAlign: "right" }}>{t("emailSettings.contactsTab.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {contacts.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", padding: "40px", color: "#64748b" }}>
                    {t("emailSettings.contactsTab.empty")}
                  </td>
                </tr>
              ) : (
                contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td>
                      <div className="automation-title-cell">
                        <strong>{contact.name || contact.email}</strong>
                        <p>{contact.email}</p>
                        {contact.companyName && (
                          <small style={{ color: "#64748b", fontSize: 11 }}>{contact.companyName}</small>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`automation-status-btn ${contact.isVip ? "active" : "paused"}`} style={{ cursor: "default" }}>
                        <span className="automation-status-dot" />
                        {contact.isVip ? t("emailSettings.contactsTab.vipSender") : t("emailSettings.contactsTab.standardSender")}
                      </span>
                    </td>
                    <td>
                      <span className={`automation-status-btn ${contact.isBlacklisted ? "active" : "paused"}`} style={{ cursor: "default" }}>
                        <span className="automation-status-dot" />
                        {contact.isBlacklisted ? t("emailSettings.contactsTab.blacklisted") : t("emailSettings.contactsTab.allowed")}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: "12px", color: "#64748b" }}>{contact.notes || "—"}</span>
                    </td>
                    <td>
                      <div className="automation-actions-cell">
                        <button
                          type="button"
                          className="automation-action-btn"
                          onClick={() => openEditContactDrawer(contact)}
                          title={t("emailSettings.contactsTab.actionEditTitle")}
                        >
                          {t("emailSettings.contactsTab.actionEdit")}
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn"
                          onClick={async () => {
                            const updated = await api<{ contact: ContactItem }>(`/companies/${contact.companyId || selectedCompanyId}/email-inbox/contacts/${encodeURIComponent(contact.email)}`, {
                              method: "PATCH",
                              body: JSON.stringify({ isVip: !contact.isVip }),
                            });
                            setContacts((prev) => prev.map((c) => (c.id === contact.id ? { ...updated.contact, companyId: contact.companyId || selectedCompanyId } : c)));
                          }}
                        >
                          {contact.isVip ? t("emailSettings.contactsTab.actionUnVip") : t("emailSettings.contactsTab.actionMakeVip")}
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
