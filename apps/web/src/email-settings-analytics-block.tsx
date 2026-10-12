import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Agent, CompanyAutomation, EmailTemplate } from "./EmailSettingsPage";

export interface EmailSettingsAnalyticsBlockProps {
  setRuleDrawerOpen: Dispatch<SetStateAction<boolean>>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  editingRuleId: string | null;
  handleSaveRule: any;
  ruleName: string;
  setRuleName: Dispatch<SetStateAction<string>>;
  ruleSubjectKeywords: string;
  setRuleSubjectKeywords: Dispatch<SetStateAction<string>>;
  ruleSenders: string;
  setRuleSenders: Dispatch<SetStateAction<string>>;
  ruleDomains: string;
  setRuleDomains: Dispatch<SetStateAction<string>>;
  ruleBodyKeywords: string;
  setRuleBodyKeywords: Dispatch<SetStateAction<string>>;
  ruleDetectedIntent: string;
  setRuleDetectedIntent: Dispatch<SetStateAction<string>>;
  ruleAttachmentTypes: string;
  setRuleAttachmentTypes: Dispatch<SetStateAction<string>>;
  ruleIsVip: boolean;
  setRuleIsVip: Dispatch<SetStateAction<boolean>>;
  rulePriority: string;
  setRulePriority: Dispatch<SetStateAction<string>>;
  ruleMode: string;
  setRuleMode: Dispatch<SetStateAction<string>>;
  ruleAgentId: string;
  setRuleAgentId: Dispatch<SetStateAction<string>>;
  selectedCompanyId: string;
  agents: Agent[];
  ruleTemplateId: string;
  setRuleTemplateId: Dispatch<SetStateAction<string>>;
  templates: EmailTemplate[];
  ruleWorkflowId: string;
  setRuleWorkflowId: Dispatch<SetStateAction<string>>;
  workflows: CompanyAutomation[];
  ruleRequireApproval: boolean;
  setRuleRequireApproval: Dispatch<SetStateAction<boolean>>;
  ruleCreateTask: boolean;
  setRuleCreateTask: Dispatch<SetStateAction<boolean>>;
  ruleAutoTagSpam: boolean;
  setRuleAutoTagSpam: Dispatch<SetStateAction<boolean>>;
  footer: string;
  savingRule: boolean;
}

export function EmailSettingsAnalyticsBlock({ setRuleDrawerOpen, t, editingRuleId, handleSaveRule, ruleName, setRuleName, ruleSubjectKeywords, setRuleSubjectKeywords, ruleSenders, setRuleSenders, ruleDomains, setRuleDomains, ruleBodyKeywords, setRuleBodyKeywords, ruleDetectedIntent, setRuleDetectedIntent, ruleAttachmentTypes, setRuleAttachmentTypes, ruleIsVip, setRuleIsVip, rulePriority, setRulePriority, ruleMode, setRuleMode, ruleAgentId, setRuleAgentId, selectedCompanyId, agents, ruleTemplateId, setRuleTemplateId, templates, ruleWorkflowId, setRuleWorkflowId, workflows, ruleRequireApproval, setRuleRequireApproval, ruleCreateTask, setRuleCreateTask, ruleAutoTagSpam, setRuleAutoTagSpam, footer, savingRule }: EmailSettingsAnalyticsBlockProps) {
  return (
<div className="company-drawer-backdrop" onMouseDown={() => setRuleDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>{t("emailSettings.ruleDrawer.kicker")}</span>
                <h2>{editingRuleId ? t("emailSettings.ruleDrawer.editTitle") : t("emailSettings.ruleDrawer.newTitle")}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label={t("common.close")}
                onClick={() => setRuleDrawerOpen(false)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <form onSubmit={handleSaveRule}>
              <section>
                <h3>{t("emailSettings.ruleDrawer.ruleParams")}</h3>
                <label>
                  <span>{t("emailSettings.ruleDrawer.ruleNameLabel")}</span>
                  <input
                    required
                    placeholder={t("emailSettings.ruleDrawer.ruleNamePlaceholder")}
                    value={ruleName}
                    onChange={(e) => setRuleName(e.target.value)}
                  />
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.ruleDrawer.triggerConditions")}</h3>
                <label>
                  <span>{t("emailSettings.ruleDrawer.subjectKeywordsLabel")}</span>
                  <input
                    placeholder={t("emailSettings.ruleDrawer.subjectKeywordsPlaceholder")}
                    value={ruleSubjectKeywords}
                    onChange={(e) => setRuleSubjectKeywords(e.target.value)}
                  />
                  <small style={{ color: "#64748b", fontSize: "11.5px" }}>{t("emailSettings.ruleDrawer.subjectKeywordsHint")}</small>
                </label>
                <label>
                  <span>{t("emailSettings.ruleDrawer.senderPatternsLabel")}</span>
                  <input
                    placeholder={t("emailSettings.ruleDrawer.senderPatternsPlaceholder")}
                    value={ruleSenders}
                    onChange={(e) => setRuleSenders(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("emailSettings.ruleDrawer.senderDomainsLabel")}</span>
                  <input placeholder={t("emailSettings.ruleDrawer.senderDomainsPlaceholder")} value={ruleDomains} onChange={(e) => setRuleDomains(e.target.value)} />
                </label>
                <label>
                  <span>{t("emailSettings.ruleDrawer.bodyKeywordsLabel")}</span>
                  <input placeholder={t("emailSettings.ruleDrawer.bodyKeywordsPlaceholder")} value={ruleBodyKeywords} onChange={(e) => setRuleBodyKeywords(e.target.value)} />
                </label>
                <label>
                  <span>{t("emailSettings.ruleDrawer.detectedIntentLabel")}</span>
                  <select value={ruleDetectedIntent} onChange={(e) => setRuleDetectedIntent(e.target.value)}>
                    <option value="">{t("emailSettings.ruleDrawer.intents.any")}</option>
                    <option value="support">{t("emailSettings.ruleDrawer.intents.support")}</option>
                    <option value="billing">{t("emailSettings.ruleDrawer.intents.billing")}</option>
                    <option value="refund">{t("emailSettings.ruleDrawer.intents.refund")}</option>
                    <option value="cancellation">{t("emailSettings.ruleDrawer.intents.cancellation")}</option>
                    <option value="sales">{t("emailSettings.ruleDrawer.intents.sales")}</option>
                    <option value="marketing">{t("emailSettings.ruleDrawer.intents.marketing")}</option>
                    <option value="general">{t("emailSettings.ruleDrawer.intents.general")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("emailSettings.ruleDrawer.attachmentTypesLabel")}</span>
                  <input
                    placeholder={t("emailSettings.ruleDrawer.attachmentTypesPlaceholder")}
                    value={ruleAttachmentTypes}
                    onChange={(e) => setRuleAttachmentTypes(e.target.value)}
                  />
                  <small style={{ color: "#64748b", fontSize: "11.5px" }}>{t("emailSettings.ruleDrawer.attachmentTypesHint")}</small>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={ruleIsVip}
                    onChange={(e) => setRuleIsVip(e.target.checked)}
                  />
                  <span>{t("emailSettings.ruleDrawer.vipOnlyLabel")}</span>
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.ruleDrawer.automatedActions")}</h3>
                <label>
                  <span>{t("emailSettings.ruleDrawer.priorityLabel")}</span>
                  <select value={rulePriority} onChange={(e) => setRulePriority(e.target.value)}>
                    <option value="">{t("emailSettings.ruleDrawer.priorities.noChange")}</option>
                    <option value="urgent">{t("emailSettings.ruleDrawer.priorities.urgent")}</option>
                    <option value="high">{t("emailSettings.ruleDrawer.priorities.high")}</option>
                    <option value="normal">{t("emailSettings.ruleDrawer.priorities.normal")}</option>
                    <option value="low">{t("emailSettings.ruleDrawer.priorities.low")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("emailSettings.ruleDrawer.modeLabel")}</span>
                  <select value={ruleMode} onChange={(e) => setRuleMode(e.target.value)}>
                    <option value="">{t("emailSettings.ruleDrawer.modes.noChange")}</option>
                    <option value="autopilot">{t("emailSettings.ruleDrawer.modes.autopilot")}</option>
                    <option value="approval">{t("emailSettings.ruleDrawer.modes.approval")}</option>
                    <option value="manual">{t("emailSettings.ruleDrawer.modes.manual")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("emailSettings.ruleDrawer.assignAgentLabel")}</span>
                  <select value={ruleAgentId} onChange={(e) => setRuleAgentId(e.target.value)} disabled={selectedCompanyId === "personal"}>
                    <option value="">{t("emailSettings.ruleDrawer.assignAgentNoChange")}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.role})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("emailSettings.ruleDrawer.templateLabel")}</span>
                  <select value={ruleTemplateId} onChange={(e) => setRuleTemplateId(e.target.value)}>
                    <option value="">{t("emailSettings.ruleDrawer.templateGenerateAi")}</option>
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>{template.title}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("emailSettings.ruleDrawer.workflowLabel")}</span>
                  <select value={ruleWorkflowId} onChange={(e) => setRuleWorkflowId(e.target.value)} disabled={selectedCompanyId === "personal"}>
                    <option value="">{t("emailSettings.ruleDrawer.workflowNoChange")}</option>
                    {workflows.map((workflow) => (
                      <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={ruleRequireApproval} onChange={(e) => setRuleRequireApproval(e.target.checked)} />
                  <span>{t("emailSettings.ruleDrawer.requireApprovalLabel")}</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={ruleCreateTask} disabled={selectedCompanyId === "personal"} onChange={(e) => setRuleCreateTask(e.target.checked)} />
                  <span>{selectedCompanyId === "personal" ? t("emailSettings.ruleDrawer.createTaskPersonal") : t("emailSettings.ruleDrawer.createTaskCompany")}</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={ruleAutoTagSpam} onChange={(e) => setRuleAutoTagSpam(e.target.checked)} />
                  <span>{t("emailSettings.ruleDrawer.autoTagSpamLabel")}</span>
                </label>
              </section>

              <footer style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setRuleDrawerOpen(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary"
                  disabled={savingRule}
                >
                  {savingRule ? t("emailSettings.ruleDrawer.savingRule") : editingRuleId ? t("emailSettings.ruleDrawer.saveRule") : t("emailSettings.ruleDrawer.createRule")}
                </button>
              </footer>
            </form>
          </aside>
        </div>
  );
}
