import { Globe, Mail, Pencil, Plug, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import type { Agent, EmailAccount } from "./EmailSettingsPage";
import "./email-accounts-table.css";

export interface EmailSettingsInboxPanelProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  filteredAccounts: EmailAccount[];
  accounts: EmailAccount[];
  loading: boolean;
  openCreateDrawer: any;
  agents: Agent[];
  testingId: string | null;
  testResult: { id: string; success: boolean; message: string } | null;
  selectedCompanyId: string;
  runConnectionTest: any;
  openDnsCheck: any;
  openEditDrawer: any;
  deleteAccount: any;
}

export function EmailSettingsInboxPanel({ t, filteredAccounts, accounts, loading, openCreateDrawer, agents, testingId, testResult, selectedCompanyId, runConnectionTest, openDnsCheck, openEditDrawer, deleteAccount }: EmailSettingsInboxPanelProps) {
  return (
<>
          <div className="inspector-table-status">
            <div className="status-left">
              <span>
                {!loading && t("emailSettings.accountsTab.showingAccounts")
                  .replace("{{count}}", String(filteredAccounts.length))
                  .replace("{{total}}", String(accounts.length))}
              </span>
            </div>
          </div>

          {filteredAccounts.length === 0 && !loading ? (
            <div className="automations-empty-card">
              <div className="automations-empty-icon">✉️</div>
              <h3>{t("emailSettings.accountsTab.emptyTitle")}</h3>
              <p>{t("emailSettings.accountsTab.emptyDesc")}</p>
              <button
                type="button"
                className="button-primary automations-action-primary"
                onClick={openCreateDrawer}
              >
                {t("emailSettings.addEmailBtn")}
              </button>
            </div>
          ) : (
            <div className="automations-table-container email-accounts-table-container" aria-busy={loading}>
              <table className="automations-table email-accounts-table">
                <thead>
                  <tr>
                    <th scope="col">{t("emailSettings.accountsTab.colAccount")}</th>
                    <th scope="col">{t("emailSettings.accountsTab.colAssignedAgent")}</th>
                    <th scope="col">{t("emailSettings.accountsTab.colMode")}</th>
                    <th scope="col">{t("emailSettings.accountsTab.colConnectionDns")}</th>
                    <th scope="col">{t("emailSettings.accountsTab.colActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAccounts.map((acc) => {
                    const assigned = agents.find((a) => a.id === acc.agentId);
                    const isTesting = testingId === acc.id;
                    const testFeedback = testResult?.id === acc.id ? testResult : null;
                    const composeLabel = t("emailSettings.accountsTab.actionComposeTitle", { email: acc.emailAddress });
                    const testLabel = t(isTesting ? "emailSettings.accountsTab.actionTesting" : "emailSettings.accountsTab.actionTestTitle");

                    return (
                      <tr key={acc.id}>
                        <td>
                          <div className="automation-title-cell">
                            <strong>{acc.displayName || acc.emailAddress}</strong>
                            <p>{acc.emailAddress}</p>
                            {acc.testMode && (
                              <span className="automation-cron-pill" style={{ background: "#fef3c7", color: "#b45309", borderColor: "#fde68a" }}>
                                {t("emailSettings.accountsTab.sandboxBadge")}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className="automation-agent-badge">
                            <span>🤖</span>
                            <span>{assigned ? assigned.name : t("emailSettings.accountsTab.unassigned")}</span>
                          </span>
                        </td>
                        <td>
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            <span
                              className={`automation-status-btn ${
                                acc.mode === "autopilot" ? "active" : acc.mode === "approval" ? "paused" : ""
                              }`}
                              style={{ width: "fit-content", textTransform: "capitalize", cursor: "default" }}
                            >
                              <span className="automation-status-dot" />
                              {acc.mode} {t("emailSettings.accountsTab.modeSuffix")}
                            </span>
                            <span className="automation-next-run">
                              {t("emailSettings.accountsTab.thresholdLabel").replace("{{percent}}", String(Math.round(acc.confidenceThreshold * 100)))}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <span
                              className={`automation-status-btn ${acc.status === "connected" ? "active" : "paused"}`}
                              style={{ width: "fit-content", cursor: "default" }}
                            >
                              <span className="automation-status-dot" />
                              {acc.status === "connected" ? t("emailSettings.accountsTab.connected") : acc.status.replace("_", " ")}
                            </span>
                            {testFeedback && (
                              <small style={{ fontSize: "11px", color: testFeedback.success ? "#15803d" : "#dc2626" }}>
                                {testFeedback.message}
                              </small>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="automation-actions-cell">
                            <Link
                              to={`/settings/email/inbox?compose=1&account=${encodeURIComponent(acc.id)}${(acc.companyId || selectedCompanyId) ? `&company=${encodeURIComponent(acc.companyId || selectedCompanyId)}` : ""}`}
                              className="automation-action-btn"
                              title={composeLabel}
                              aria-label={composeLabel}
                            >
                              <Mail size={15} aria-hidden="true" />
                            </Link>
                            <button
                              type="button"
                              className="automation-action-btn"
                              disabled={isTesting}
                              onClick={() => runConnectionTest(acc)}
                              title={testLabel}
                              aria-label={testLabel}
                            >
                              <Plug size={15} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="automation-action-btn"
                              onClick={() => openDnsCheck(acc)}
                              title={t("emailSettings.accountsTab.actionDnsTitle")}
                              aria-label={t("emailSettings.accountsTab.actionDnsTitle")}
                            >
                              <Globe size={15} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="automation-action-btn"
                              onClick={() => openEditDrawer(acc)}
                              title={t("emailSettings.accountsTab.actionEditTitle")}
                              aria-label={t("emailSettings.accountsTab.actionEditTitle")}
                            >
                              <Pencil size={15} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="automation-action-btn danger"
                              onClick={() => deleteAccount(acc.id)}
                              title={t("emailSettings.accountsTab.actionDeleteTitle")}
                              aria-label={t("emailSettings.accountsTab.actionDeleteTitle")}
                            >
                              <Trash2 size={15} aria-hidden="true" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
  );
}
