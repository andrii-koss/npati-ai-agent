import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { EmailAccount, EmailRule, EmailTemplate, ContactItem, EmailPermissionKey } from "./EmailSettingsPage";

export interface EmailSettingsHeaderBlockProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  activeTab: "accounts" | "rules" | "templates" | "contacts" | "permissions";
  accounts: EmailAccount[];
  setActiveTab: Dispatch<SetStateAction<"accounts" | "rules" | "templates" | "contacts" | "permissions">>;
  rules: EmailRule[];
  templates: EmailTemplate[];
  contacts: ContactItem[];
  permissionKeys: EmailPermissionKey[];
}

export function EmailSettingsHeaderBlock({ t, searchQuery, setSearchQuery, activeTab, accounts, setActiveTab, rules, templates, contacts, permissionKeys }: EmailSettingsHeaderBlockProps) {
  return (
<div className="inspector-controls automations-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            placeholder={t("emailSettings.controls.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="inspector-search-input"
            aria-label={t("emailSettings.controls.searchAriaLabel")}
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearchQuery("")}
              aria-label={t("emailSettings.controls.clearSearch")}
              title={t("emailSettings.controls.clearSearch")}
            >
              ×
            </button>
          )}
        </div>

        <div className="inspector-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "accounts"}
            className={`inspector-tab ${activeTab === "accounts" ? "active" : ""}`}
            onClick={() => setActiveTab("accounts")}
          >
            <span>{t("emailSettings.controls.tabAccounts")}</span>
            <small className="tab-count">{accounts.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "rules"}
            className={`inspector-tab ${activeTab === "rules" ? "active" : ""}`}
            onClick={() => setActiveTab("rules")}
          >
            <span>{t("emailSettings.controls.tabRules")}</span>
            <small className="tab-count">{rules.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "templates"}
            className={`inspector-tab ${activeTab === "templates" ? "active" : ""}`}
            onClick={() => setActiveTab("templates")}
          >
            <span>{t("emailSettings.controls.tabTemplates")}</span>
            <small className="tab-count">{templates.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "contacts"}
            className={`inspector-tab ${activeTab === "contacts" ? "active" : ""}`}
            onClick={() => setActiveTab("contacts")}
          >
            <span>{t("emailSettings.controls.tabContacts")}</span>
            <small className="tab-count">{contacts.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "permissions"}
            className={`inspector-tab ${activeTab === "permissions" ? "active" : ""}`}
            onClick={() => setActiveTab("permissions")}
          >
            <span>{t("emailSettings.controls.tabPermissions")}</span>
            <small className="tab-count">{permissionKeys.length}</small>
          </button>
        </div>
      </div>
  );
}
