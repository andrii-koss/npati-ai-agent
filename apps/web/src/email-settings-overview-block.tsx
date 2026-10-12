import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { Link } from "react-router-dom";
import { writeActiveCompanyId } from "./active-company";
import type { Company, EmailAccount, EmailAnalytics } from "./EmailSettingsPage";
import { readCachedAccounts, readCachedAnalytics } from "./EmailSettingsPage";

export interface EmailSettingsOverviewBlockProps {
  selectedCompanyId: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  setSelectedCompanyId: Dispatch<SetStateAction<string>>;
  setAgentId: Dispatch<SetStateAction<string>>;
  setRuleAgentId: Dispatch<SetStateAction<string>>;
  setRuleWorkflowId: Dispatch<SetStateAction<string>>;
  setRuleCreateTask: Dispatch<SetStateAction<boolean>>;
  setAccounts: Dispatch<SetStateAction<EmailAccount[]>>;
  setAnalytics: Dispatch<SetStateAction<EmailAnalytics | null>>;
  companies: Company[];
  accounts: EmailAccount[];
}

export function EmailSettingsOverviewBlock({ selectedCompanyId, t, setSelectedCompanyId, setAgentId, setRuleAgentId, setRuleWorkflowId, setRuleCreateTask, setAccounts, setAnalytics, companies, accounts }: EmailSettingsOverviewBlockProps) {
  return (
<div className="email-scope-toolbar">
        <div className="email-scope-left">
          <div className="email-scope-pill">
            <span className="email-scope-badge">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                {selectedCompanyId === "personal" ? (
                  <>
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </>
                ) : (
                  <>
                    <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
                    <path d="M9 22v-4h6v4" />
                    <path d="M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01" />
                  </>
                )}
              </svg>
              <span>{t("emailSettings.scope.mailboxScope")}</span>
            </span>

            <div className="email-scope-select-wrap">
              <select
                aria-label={t("emailSettings.scope.selectOwnerAria")}
                value={selectedCompanyId}
                onChange={(e) => {
                  const companyId = e.target.value;
                  setSelectedCompanyId(companyId);
                  setAgentId("");
                  setRuleAgentId("");
                  setRuleWorkflowId("");
                  setRuleCreateTask(false);
                  writeActiveCompanyId(companyId === "personal" ? "" : companyId);
                  const cachedAcc = readCachedAccounts(companyId);
                  if (cachedAcc.length > 0) setAccounts(cachedAcc);
                  const cachedAnal = readCachedAnalytics(companyId);
                  if (cachedAnal) setAnalytics(cachedAnal);
                }}
                className="email-scope-select"
                title={selectedCompanyId === "personal" ? t("emailSettings.scope.personalScope") : (companies.find((c) => c.id === selectedCompanyId)?.name || selectedCompanyId)}
              >
                <option value="personal">{t("emailSettings.scope.personalScope")}</option>
                {selectedCompanyId && selectedCompanyId !== "personal" && !companies.some((c) => c.id === selectedCompanyId) && (
                  <option key={selectedCompanyId} value={selectedCompanyId} title={selectedCompanyId}>
                    {selectedCompanyId}
                  </option>
                )}
                {companies.map((c) => (
                  <option key={c.id} value={c.id} title={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <svg className="email-scope-select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </div>
          </div>
          <span className="email-scope-context-hint">
            {selectedCompanyId === "personal"
              ? t("emailSettings.scope.personalContextHint")
              : t("emailSettings.scope.companyContextHint").replace("{{company}}", companies.find((c) => c.id === selectedCompanyId)?.name || "selected organization")}
          </span>
        </div>

        <div className="email-scope-right">
          <Link
            to={selectedCompanyId && selectedCompanyId !== "personal" ? `/settings/email/inbox?compose=1&company=${encodeURIComponent(selectedCompanyId)}` : "/settings/email/inbox?compose=1"}
            className="email-compose-btn"
            title={accounts.length ? t("emailSettings.scope.composeTitle") : t("emailSettings.scope.composeDisabledTitle")}
            aria-disabled={accounts.length === 0}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span>{t("emailSettings.scope.composeEmail")}</span>
          </Link>
        </div>
      </div>
  );
}
