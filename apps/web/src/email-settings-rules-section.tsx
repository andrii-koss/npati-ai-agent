import type { Dispatch, MutableRefObject, SetStateAction } from "react";

export interface EmailSettingsRulesSectionProps {
  setContactDrawerOpen: Dispatch<SetStateAction<boolean>>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  editingContactEmail: string | null;
  handleSaveContact: any;
  contactEmail: string;
  setContactEmail: Dispatch<SetStateAction<string>>;
  contactName: string;
  setContactName: Dispatch<SetStateAction<string>>;
  contactCompanyName: string;
  setContactCompanyName: Dispatch<SetStateAction<string>>;
  contactPhone: string;
  setContactPhone: Dispatch<SetStateAction<string>>;
  contactIsVip: boolean;
  setContactIsVip: Dispatch<SetStateAction<boolean>>;
  contactIsBlacklisted: boolean;
  setContactIsBlacklisted: Dispatch<SetStateAction<boolean>>;
  contactNotes: string;
  setContactNotes: Dispatch<SetStateAction<string>>;
  footer: string;
  savingContact: boolean;
}

export function EmailSettingsRulesSection({ setContactDrawerOpen, t, editingContactEmail, handleSaveContact, contactEmail, setContactEmail, contactName, setContactName, contactCompanyName, setContactCompanyName, contactPhone, setContactPhone, contactIsVip, setContactIsVip, contactIsBlacklisted, setContactIsBlacklisted, contactNotes, setContactNotes, footer, savingContact }: EmailSettingsRulesSectionProps) {
  return (
<div className="company-drawer-backdrop" onMouseDown={() => setContactDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>{t("emailSettings.contactDrawer.kicker")}</span>
                <h2>{editingContactEmail ? t("emailSettings.contactDrawer.editTitle") : t("emailSettings.contactDrawer.newTitle")}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label={t("common.close")}
                onClick={() => setContactDrawerOpen(false)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <form onSubmit={handleSaveContact}>
              <section>
                <h3>{t("emailSettings.contactDrawer.infoHeading")}</h3>
                <label>
                  <span>{t("emailSettings.contactDrawer.emailLabel")}</span>
                  <input
                    type="email"
                    required
                    disabled={!!editingContactEmail}
                    placeholder={t("emailSettings.contactDrawer.emailPlaceholder")}
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("emailSettings.contactDrawer.nameLabel")}</span>
                  <input
                    placeholder={t("emailSettings.contactDrawer.namePlaceholder")}
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("emailSettings.contactDrawer.companyLabel")}</span>
                  <input
                    placeholder={t("emailSettings.contactDrawer.companyPlaceholder")}
                    value={contactCompanyName}
                    onChange={(e) => setContactCompanyName(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("emailSettings.contactDrawer.phoneLabel")}</span>
                  <input
                    placeholder={t("emailSettings.contactDrawer.phonePlaceholder")}
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                  />
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.contactDrawer.flagsHeading")}</h3>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={contactIsVip}
                    onChange={(e) => setContactIsVip(e.target.checked)}
                  />
                  <span>{t("emailSettings.contactDrawer.markVipLabel")}</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={contactIsBlacklisted}
                    onChange={(e) => setContactIsBlacklisted(e.target.checked)}
                  />
                  <span>{t("emailSettings.contactDrawer.blacklistLabel")}</span>
                </label>
                <label style={{ marginTop: 10 }}>
                  <span>{t("emailSettings.contactDrawer.notesLabel")}</span>
                  <textarea
                    rows={3}
                    placeholder={t("emailSettings.contactDrawer.notesPlaceholder")}
                    value={contactNotes}
                    onChange={(e) => setContactNotes(e.target.value)}
                  />
                </label>
              </section>

              <footer style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setContactDrawerOpen(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary"
                  disabled={savingContact}
                >
                  {savingContact ? t("emailSettings.contactDrawer.savingContact") : editingContactEmail ? t("emailSettings.contactDrawer.saveContact") : t("emailSettings.contactDrawer.addContact")}
                </button>
              </footer>
            </form>
          </aside>
        </div>
  );
}
