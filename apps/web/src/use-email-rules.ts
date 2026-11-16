import { useState, FormEvent } from "react";
import { confirmModal } from "./ConfirmDialog";
import { api, type EmailRule, type Agent, type CompanyAutomation } from "./email-settings-types";

export function useEmailRules(
  selectedCompanyId: string,
  agents: Agent[],
  t: (key: string) => string,
  setNotice: (msg: string | null) => void
) {
  const [rules, setRules] = useState<EmailRule[]>([]);
  const [ruleDrawerOpen, setRuleDrawerOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleName, setRuleName] = useState("");
  const [ruleSubjectKeywords, setRuleSubjectKeywords] = useState("");
  const [ruleBodyKeywords, setRuleBodyKeywords] = useState("");
  const [ruleSenders, setRuleSenders] = useState("");
  const [ruleDomains, setRuleDomains] = useState("");
  const [ruleDetectedIntent, setRuleDetectedIntent] = useState("");
  const [ruleAttachmentTypes, setRuleAttachmentTypes] = useState("");
  const [ruleIsVip, setRuleIsVip] = useState(false);
  const [rulePriority, setRulePriority] = useState("");
  const [ruleMode, setRuleMode] = useState("");
  const [ruleAgentId, setRuleAgentId] = useState("");
  const [ruleRequireApproval, setRuleRequireApproval] = useState(false);
  const [ruleCreateTask, setRuleCreateTask] = useState(false);
  const [ruleAutoTagSpam, setRuleAutoTagSpam] = useState(false);
  const [ruleTemplateId, setRuleTemplateId] = useState("");
  const [ruleWorkflowId, setRuleWorkflowId] = useState("");
  const [workflows, setWorkflows] = useState<CompanyAutomation[]>([]);
  const [savingRule, setSavingRule] = useState(false);

  function openCreateRuleDrawer() {
    setEditingRuleId(null);
    setRuleName("");
    setRuleSubjectKeywords("");
    setRuleBodyKeywords("");
    setRuleSenders("");
    setRuleDomains("");
    setRuleDetectedIntent("");
    setRuleAttachmentTypes("");
    setRuleIsVip(false);
    setRulePriority("high");
    setRuleMode("");
    setRuleAgentId(agents[0]?.id || "");
    setRuleRequireApproval(false);
    setRuleCreateTask(false);
    setRuleAutoTagSpam(false);
    setRuleTemplateId("");
    setRuleWorkflowId("");
    setRuleDrawerOpen(true);
  }

  function openEditRuleDrawer(rule: EmailRule) {
    setEditingRuleId(rule.id);
    setRuleName(rule.name);
    setRuleSubjectKeywords((rule.conditions?.subjectKeywords || []).join(", "));
    setRuleBodyKeywords((rule.conditions?.bodyKeywords || []).join(", "));
    setRuleSenders((rule.conditions?.senders || []).join(", "));
    setRuleDomains((rule.conditions?.domains || []).join(", "));
    setRuleDetectedIntent(rule.conditions?.detectedIntent || "");
    setRuleAttachmentTypes((rule.conditions?.attachmentTypes || []).join(", "));
    setRuleIsVip(rule.conditions?.isVip || false);
    setRulePriority(rule.actions?.setPriority || "");
    setRuleMode(rule.actions?.setMode || "");
    setRuleAgentId(rule.actions?.setAgentId || "");
    setRuleRequireApproval(rule.actions?.requireApproval || false);
    setRuleCreateTask(rule.actions?.createTask || false);
    setRuleAutoTagSpam(rule.actions?.autoTagSpam || false);
    setRuleTemplateId(rule.actions?.autoReplyTemplateId || "");
    setRuleWorkflowId(rule.actions?.startWorkflowId || "");
    setRuleDrawerOpen(true);
  }

  async function handleSaveRule(e: FormEvent) {
    e.preventDefault();
    if (!ruleName.trim()) {
      setNotice(t("emailSettings.messages.ruleNameReq"));
      return;
    }
    setSavingRule(true);
    try {
      const conditions: any = {};
      const kw = ruleSubjectKeywords.split(",").map((s) => s.trim()).filter(Boolean);
      if (kw.length > 0) conditions.subjectKeywords = kw;
      const bodyKw = ruleBodyKeywords.split(",").map((s) => s.trim()).filter(Boolean);
      if (bodyKw.length > 0) conditions.bodyKeywords = bodyKw;
      const senders = ruleSenders.split(",").map((s) => s.trim()).filter(Boolean);
      if (senders.length > 0) conditions.senders = senders;
      const domains = ruleDomains.split(",").map((s) => s.trim()).filter(Boolean);
      if (domains.length > 0) conditions.domains = domains;
      if (ruleDetectedIntent) conditions.detectedIntent = ruleDetectedIntent;
      const attachmentTypes = ruleAttachmentTypes.split(",").map((value) => value.trim()).filter(Boolean);
      if (attachmentTypes.length > 0) conditions.attachmentTypes = attachmentTypes;
      if (ruleIsVip) conditions.isVip = true;

      const actions: any = {};
      if (rulePriority) actions.setPriority = rulePriority;
      if (ruleMode) actions.setMode = ruleMode;
      if (selectedCompanyId !== "personal" && ruleAgentId) actions.setAgentId = ruleAgentId;
      if (ruleRequireApproval) actions.requireApproval = true;
      if (selectedCompanyId !== "personal" && ruleCreateTask) actions.createTask = true;
      if (ruleAutoTagSpam) actions.autoTagSpam = true;
      if (ruleTemplateId) actions.autoReplyTemplateId = ruleTemplateId;
      if (selectedCompanyId !== "personal" && ruleWorkflowId) actions.startWorkflowId = ruleWorkflowId;

      if (editingRuleId) {
        const res = await api<{ rule: EmailRule }>(`/companies/${selectedCompanyId}/email-inbox/rules/${editingRuleId}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: ruleName.trim(),
            conditions,
            actions,
          }),
        });
        setRules((prev) => prev.map((r) => (r.id === editingRuleId ? res.rule : r)));
      } else {
        const res = await api<{ rule: EmailRule }>(`/companies/${selectedCompanyId}/email-inbox/rules`, {
          method: "POST",
          body: JSON.stringify({
            name: ruleName.trim(),
            conditions,
            actions,
          }),
        });
        setRules((prev) => [...prev, res.rule]);
      }
      setRuleDrawerOpen(false);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setSavingRule(false);
    }
  }

  async function handleDeleteRule(id: string) {
    const ok = await confirmModal({
      title: t("emailSettings.dialogs.deleteRuleTitle"),
      message: t("emailSettings.dialogs.deleteRuleMsg"),
      isDanger: true,
    });
    if (!ok) return;
    try {
      await api(`/companies/${rules.find(rule => rule.id === id)?.companyId || selectedCompanyId}/email-inbox/rules/${id}`, { method: "DELETE" });
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (err: any) {
      setNotice(err.message);
    }
  }

  return {
    rules,
    setRules,
    ruleDrawerOpen,
    setRuleDrawerOpen,
    editingRuleId,
    ruleName,
    setRuleName,
    ruleSubjectKeywords,
    setRuleSubjectKeywords,
    ruleBodyKeywords,
    setRuleBodyKeywords,
    ruleSenders,
    setRuleSenders,
    ruleDomains,
    setRuleDomains,
    ruleDetectedIntent,
    setRuleDetectedIntent,
    ruleAttachmentTypes,
    setRuleAttachmentTypes,
    ruleIsVip,
    setRuleIsVip,
    rulePriority,
    setRulePriority,
    ruleMode,
    setRuleMode,
    ruleAgentId,
    setRuleAgentId,
    ruleRequireApproval,
    setRuleRequireApproval,
    ruleCreateTask,
    setRuleCreateTask,
    ruleAutoTagSpam,
    setRuleAutoTagSpam,
    ruleTemplateId,
    setRuleTemplateId,
    ruleWorkflowId,
    setRuleWorkflowId,
    workflows,
    setWorkflows,
    savingRule,
    openCreateRuleDrawer,
    openEditRuleDrawer,
    handleSaveRule,
    handleDeleteRule,
  };
}
