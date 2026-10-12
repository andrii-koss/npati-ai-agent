import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Agent, EmailRule } from "./EmailSettingsPage";

export interface EmailSettingsInboxBlockProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  openCreateRuleDrawer: any;
  rules: EmailRule[];
  mode: "manual" | "approval" | "autopilot";
  agents: Agent[];
  openEditRuleDrawer: any;
  handleDeleteRule: any;
}

export function EmailSettingsInboxBlock({ t, openCreateRuleDrawer, rules, mode, agents, openEditRuleDrawer, handleDeleteRule }: EmailSettingsInboxBlockProps) {
  return (
<div className="automations-table-container">
          <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #f1f5f9" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>{t("emailSettings.rulesTab.heading")}</h3>
              <small style={{ color: "#64748b" }}>{t("emailSettings.rulesTab.subtitle")}</small>
            </div>
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={openCreateRuleDrawer}
            >
              {t("emailSettings.rulesTab.addRuleBtn")}
            </button>
          </div>
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ width: "220px" }}>{t("emailSettings.rulesTab.colName")}</th>
                <th>{t("emailSettings.rulesTab.colConditions")}</th>
                <th>{t("emailSettings.rulesTab.colActions")}</th>
                <th style={{ width: "100px", textAlign: "right" }}>{t("emailSettings.rulesTab.colTableActions")}</th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: "40px", color: "#64748b" }}>
                    {t("emailSettings.rulesTab.empty")}
                  </td>
                </tr>
              ) : (
                rules.map((rule) => {
                  const kw = rule.conditions?.subjectKeywords ?? [];
                  const senders = rule.conditions?.senders ?? [];
                  const isVip = rule.conditions?.isVip;

                  return (
                    <tr key={rule.id}>
                      <td>
                        <div className="automation-title-cell">
                          <strong>{rule.name}</strong>
                          <span className="automation-status-btn active" style={{ cursor: "default", fontSize: 10, padding: "2px 8px" }}>
                            <span className="automation-status-dot" />
                            {t("emailSettings.rulesTab.activeBadge")}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          {kw.length > 0 && (
                            <span className="automation-cron-pill">
                              {t("emailSettings.rulesTab.keywordsLabel").replace("{{keywords}}", kw.join(", "))}
                            </span>
                          )}
                          {senders.length > 0 && (
                            <span className="automation-cron-pill">
                              {t("emailSettings.rulesTab.sendersLabel").replace("{{senders}}", senders.join(", "))}
                            </span>
                          )}
                          {isVip && (
                            <span className="automation-cron-pill" style={{ color: "#b45309", background: "#fef3c7" }}>
                              {t("emailSettings.rulesTab.vipOnlyBadge")}
                            </span>
                          )}
                          {!kw.length && !senders.length && !isVip && (
                            <span style={{ color: "#64748b", fontSize: 12 }}>{t("emailSettings.rulesTab.allInbound")}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          {rule.actions?.setPriority && (
                            <span className="automation-agent-badge" style={{ textTransform: "capitalize" }}>
                              {t("emailSettings.rulesTab.priorityPrefix").replace("{{priority}}", rule.actions.setPriority)}
                            </span>
                          )}
                          {rule.actions?.setMode && (
                            <span className="automation-agent-badge" style={{ textTransform: "capitalize" }}>
                              {t("emailSettings.rulesTab.modePrefix").replace("{{mode}}", rule.actions.setMode)}
                            </span>
                          )}
                          {rule.actions?.setAgentId && (
                            <span className="automation-agent-badge">
                              🤖 {agents.find((a) => a.id === rule.actions.setAgentId)?.name || "Agent"}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="automation-actions-cell">
                          <button
                            type="button"
                            className="automation-action-btn"
                            onClick={() => openEditRuleDrawer(rule)}
                            title={t("emailSettings.rulesTab.actionEditTitle")}
                          >
                            {t("emailSettings.rulesTab.actionEdit")}
                          </button>
                          <button
                            type="button"
                            className="automation-action-btn danger"
                            onClick={() => handleDeleteRule(rule.id)}
                            title={t("emailSettings.rulesTab.actionDeleteTitle")}
                          >
                            {t("emailSettings.rulesTab.actionDelete")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
  );
}
