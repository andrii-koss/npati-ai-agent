import { invalidateEmailSettings, readCachedEmailSettings, readEmailSettings } from "./email-settings-read";
import { invalidateIntegrationsCatalog } from "./integrations/cache";
import { ALL_COMPANIES } from "./company-scope";
import { readEmailCollection } from "./email-company-scope";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { readCachedCompanies, writeCachedCompanies } from "./active-company";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { EmailSettingsTemplatesSection } from "./email-settings-templates-section";
import { EmailSettingsContactsSection } from "./email-settings-contacts-section";
import { EmailSettingsRulesSection } from "./email-settings-rules-section";
import { EmailSettingsAccountFormSection } from "./email-settings-account-form-section";
import { EmailSettingsAnalyticsBlock } from "./email-settings-analytics-block";
import { EmailSettingsInboxPanel } from "./email-settings-inbox-panel";
import { EmailSettingsInboxBlock } from "./email-settings-inbox-block";
import { EmailSettingsPermissionsBlock } from "./email-settings-permissions-block";
import { EmailSettingsTestBlock } from "./email-settings-test-block";
import { EmailSettingsOverviewBlock } from "./email-settings-overview-block";
import { EmailSettingsHeaderBlock } from "./email-settings-header-block";
import { EmailSettingsSidebarBlock } from "./email-settings-sidebar-block";
import { EmailSettingsFooterBlock } from "./email-settings-footer-block";
import {
  api,
  writeCachedAccounts,
  writeCachedAnalytics,
  type Company,
  type Agent,
  type EmailAccount,
  type DnsCheckResult,
  type EmailAnalytics,
  type EmailPermissionKey,
  type EmailRule,
  type EmailTemplate,
  type CompanyAutomation,
  type ContactItem,
} from "./email-settings-types";
import { EmailSettingsHeroHeader, EmailSettingsStatsCards } from "./email-settings-hero-stats";
import { useEmailRules } from "./use-email-rules";
import { useEmailTemplatesContacts } from "./use-email-templates-contacts";

export * from "./email-settings-types";

export function EmailSettingsPage() {
  const { t, language } = useTranslation();
  const [selectedCompanyId, setSelectedCompanyId] = useState(() => new URLSearchParams(window.location.search).get("company") || ALL_COMPANIES);
  const [companies, setCompanies] = useState<Company[]>(() => readCachedEmailSettings(selectedCompanyId)?.companies ?? readCachedCompanies());
  const companyIdsKey = companies.map(company => company.id).join("\0");
  const [agents, setAgents] = useState<Agent[]>(() => readCachedEmailSettings(selectedCompanyId)?.agents ?? []);
  const [accounts, setAccounts] = useState<EmailAccount[]>(() => readCachedEmailSettings(selectedCompanyId)?.accounts ?? []);
  const [activeTab, setActiveTab] = useState<"accounts" | "rules" | "templates" | "contacts" | "permissions">("accounts");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(() => !readCachedEmailSettings(selectedCompanyId));
  const accountsVersion = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);

  // Email Account Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [emailAddress, setEmailAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [mode, setMode] = useState<"manual" | "approval" | "autopilot">("approval");
  const [provider, setProvider] = useState<EmailAccount["provider"]>("imap_smtp");
  const [senderPolicy, setSenderPolicy] = useState<EmailAccount["senderPolicy"]>("allowlist");
  const [allowedSenders, setAllowedSenders] = useState("");
  const [allowedDomains, setAllowedDomains] = useState("");
  const [requireAuthenticatedSender, setRequireAuthenticatedSender] = useState(true);
  const [outboundPolicy, setOutboundPolicy] = useState<EmailAccount["outboundPolicy"]>("approval_required");
  const connectionScope: EmailAccount["connectionScope"] = agentId ? "agent" : selectedCompanyId === "personal" ? "account" : "company";
  const [testMode, setTestMode] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.8);
  const [languageMode, setLanguageMode] = useState("auto");
  const [mailAuthType, setMailAuthType] = useState<"password" | "oauth2">("password");
  const [oauthAccessToken, setOauthAccessToken] = useState("");
  const [oauthRefreshToken, setOauthRefreshToken] = useState("");
  const [oauthTokenUrl, setOauthTokenUrl] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState("");
  const [oauthScopes, setOauthScopes] = useState("");
  const [oauthRedirectUri, setOauthRedirectUri] = useState(() => `${window.location.origin}/api/email/oauth/callback`);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [imapSecure, setImapSecure] = useState(true);
  const [imapUser, setImapUser] = useState("");
  const [imapPass, setImapPass] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(465);
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [maxPerHour, setMaxPerHour] = useState(50);
  const [maxPerDay, setMaxPerDay] = useState(500);
  const [maxPerRecipientDaily, setMaxPerRecipientDaily] = useState(100);
  const [maxCompanyPerHour, setMaxCompanyPerHour] = useState(500);
  const [maxCompanyPerDay, setMaxCompanyPerDay] = useState(5000);
  const [followupEnabled, setFollowupEnabled] = useState(false);
  const [followupDelayDays, setFollowupDelayDays] = useState(2);
  const [followupMax, setFollowupMax] = useState(2);
  const [followupAction, setFollowupAction] = useState<"draft" | "auto_send" | "create_task" | "notify_user">("draft");
  const [greeting, setGreeting] = useState("Hello,");
  const [signature, setSignature] = useState("Best regards,\nCustomer Support");
  const [footer, setFooter] = useState("");
  const [saving, setSaving] = useState(false);
  const [accountFormError, setAccountFormError] = useState<string | null>(null);
  const [accountFieldErrors, setAccountFieldErrors] = useState<Record<string, string>>({});

  // DNS Check Drawer
  const [dnsDrawerOpen, setDnsDrawerOpen] = useState(false);
  const [dnsAccount, setDnsAccount] = useState<EmailAccount | null>(null);
  const [dnsResult, setDnsResult] = useState<DnsCheckResult | null>(null);
  const [dnsChecking, setDnsChecking] = useState(false);

  // Connection Test State
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);

  const {
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
  } = useEmailRules(selectedCompanyId, agents, t, setNotice);

  const {
    templates,
    setTemplates,
    templateDrawerOpen,
    setTemplateDrawerOpen,
    editingTemplateId,
    templateTitle,
    setTemplateTitle,
    templateCategory,
    setTemplateCategory,
    templateSubject,
    setTemplateSubject,
    templateBody,
    setTemplateBody,
    savingTemplate,
    openCreateTemplateDrawer,
    openEditTemplateDrawer,
    handleSaveTemplate,
    handleDeleteTemplate,
    contacts,
    setContacts,
    contactDrawerOpen,
    setContactDrawerOpen,
    editingContactEmail,
    contactEmail,
    setContactEmail,
    contactName,
    setContactName,
    contactCompanyName,
    setContactCompanyName,
    contactPhone,
    setContactPhone,
    contactIsVip,
    setContactIsVip,
    contactIsBlacklisted,
    setContactIsBlacklisted,
    contactNotes,
    setContactNotes,
    savingContact,
    openCreateContactDrawer,
    openEditContactDrawer,
    handleSaveContact,
  } = useEmailTemplatesContacts(selectedCompanyId, t, setNotice);

  // Analytics
  const [analytics, setAnalytics] = useState<EmailAnalytics | null>(() => readCachedEmailSettings(selectedCompanyId)?.analytics ?? null);
  const [analyticsExpanded, setAnalyticsExpanded] = useState(true);

  // Granular permissions are delegated through the existing scoped API-key system.
  const [permissionKeys, setPermissionKeys] = useState<EmailPermissionKey[]>([]);
  const [permissionKeyName, setPermissionKeyName] = useState("Email integration");
  const [selectedEmailPermissions, setSelectedEmailPermissions] = useState<string[]>(["email:view", "email:read_messages"]);
  const [createdPermissionToken, setCreatedPermissionToken] = useState<string | null>(null);
  const [savingPermissionKey, setSavingPermissionKey] = useState(false);

  useEffect(() => {
    let active = true;
    const version = accountsVersion.current;
    const cached = readCachedEmailSettings(selectedCompanyId);
    setLoading(!cached);
    setAccounts(cached?.accounts ?? []);
    setAgents(cached?.agents ?? []);
    setAnalytics(cached?.analytics ?? null);

    void readEmailSettings(selectedCompanyId).then(data => {
      if (!active) return;
      setCompanies(data.companies);
      writeCachedCompanies(data.companies);
      if (version === accountsVersion.current) {
        setAccounts(data.accounts);
        writeCachedAccounts(selectedCompanyId, data.accounts);
      }
      setAgents(data.agents);
      setAnalytics(data.analytics);
      writeCachedAnalytics(selectedCompanyId, data.analytics);
      const url = new URL(window.location.href);
      if (url.searchParams.get("company") === selectedCompanyId) {
        url.searchParams.delete("company");
        window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      }
    }).catch(error => {
      if (active) setNotice(error.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [selectedCompanyId]);

  // Load rules/templates/contacts on tab switch
  useEffect(() => {
    if (!selectedCompanyId) return;
    if (selectedCompanyId === ALL_COMPANIES) {
      let active = true;
      const ids = companies.map(company => company.id);
      setRules([]); setTemplates([]); setContacts([]); setPermissionKeys([]); setWorkflows([]);
      const load = async () => {
        if (activeTab === "rules") {
          const [rules, templates] = await Promise.all([readEmailCollection<EmailRule>(ids, "email-inbox/rules", "rules"), readEmailCollection<EmailTemplate>(ids, "email-inbox/templates", "templates")]);
          if (active) { setRules(rules); setTemplates(templates); }
        } else if (activeTab === "templates") {
          const templates = await readEmailCollection<EmailTemplate>(ids, "email-inbox/templates", "templates");
          if (active) setTemplates(templates);
        } else if (activeTab === "contacts") {
          const contacts = await readEmailCollection<ContactItem>(ids, "email-inbox/contacts", "contacts");
          if (active) setContacts(contacts);
        } else if (activeTab === "permissions") {
          const keys = await readEmailCollection<EmailPermissionKey>(ids, "api-keys", "keys");
          if (active) setPermissionKeys(keys.filter(key => key.scopes.some(scope => scope.startsWith("email:"))));
        }
      };
      void load().catch(error => { if (active) setNotice(error.message); });
      return () => { active = false; };
    }
    if (activeTab === "rules") {
      Promise.all([
        api<{ rules: EmailRule[] }>(`/companies/${selectedCompanyId}/email-inbox/rules`),
        api<{ templates: EmailTemplate[] }>(`/companies/${selectedCompanyId}/email-inbox/templates`),
        selectedCompanyId === "personal"
          ? Promise.resolve({ automations: [] as CompanyAutomation[] })
          : api<{ automations: CompanyAutomation[] }>(`/companies/${selectedCompanyId}/automations`),
      ])
        .then(([ruleResult, templateResult, automationResult]) => {
          setRules(ruleResult.rules);
          setTemplates(templateResult.templates);
          setWorkflows(automationResult.automations.filter((automation) => automation.status === "active"));
        })
        .catch(() => undefined);
    } else if (activeTab === "templates") {
      api<{ templates: EmailTemplate[] }>(`/companies/${selectedCompanyId}/email-inbox/templates`)
        .then((r) => setTemplates(r.templates))
        .catch(() => undefined);
    } else if (activeTab === "contacts") {
      api<{ contacts: ContactItem[] }>(`/companies/${selectedCompanyId}/email-inbox/contacts`)
        .then((r) => setContacts(r.contacts))
        .catch(() => undefined);
    } else if (activeTab === "permissions") {
      if (selectedCompanyId === "personal") {
        setPermissionKeys([]);
        return;
      }
      api<{ keys: EmailPermissionKey[] }>(`/companies/${selectedCompanyId}/api-keys`)
        .then((r) => setPermissionKeys(r.keys.filter((key) => key.scopes.some((scope: string) => scope.startsWith("email:")))))
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    }
  }, [selectedCompanyId, activeTab, companyIdsKey]);

  async function createPermissionKey(event: FormEvent) {
    event.preventDefault();
    if (selectedCompanyId === ALL_COMPANIES) { setNotice(language === "uk" ? "Виберіть компанію" : "Select a company"); return; }
    if (selectedCompanyId === "personal") {
      setNotice(t("emailSettings.messages.personalKeysNotice"));
      return;
    }
    if (!selectedCompanyId || selectedEmailPermissions.length === 0) return;
    setSavingPermissionKey(true);
    setCreatedPermissionToken(null);
    try {
      const result = await api<{ key: EmailPermissionKey & { rawToken: string } }>(`/companies/${selectedCompanyId}/api-keys`, {
        method: "POST",
        body: JSON.stringify({ name: permissionKeyName.trim(), scopes: selectedEmailPermissions }),
      });
      setPermissionKeys((current) => [result.key, ...current]);
      setCreatedPermissionToken(result.key.rawToken);
      setPermissionKeyName("Email integration");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingPermissionKey(false);
    }
  }

  async function revokePermissionKey(keyId: string) {
    if (!selectedCompanyId || !await confirmModal({ title: t("emailSettings.dialogs.revokeKeyTitle"), message: t("emailSettings.dialogs.revokeKeyMsg"), confirmText: t("emailSettings.dialogs.revokeKeyConfirm"), isDanger: true })) return;
    await api(`/companies/${permissionKeys.find(key => key.id === keyId)?.companyId || selectedCompanyId}/api-keys/${keyId}`, { method: "DELETE" });
    setPermissionKeys((current) => current.filter((key) => key.id !== keyId));
  }

  function openCreateDrawer() {
    if (selectedCompanyId === ALL_COMPANIES) setSelectedCompanyId("personal");
    setEditingId(null);
    setEmailAddress("");
    setDisplayName("");
    setAgentId("");
    setAccountFormError(null);
    setAccountFieldErrors({});
    setMode("approval");
    setTestMode(false);
    setProvider("imap_smtp");
    setSenderPolicy("allowlist");
    setAllowedSenders("");
    setAllowedDomains("");
    setRequireAuthenticatedSender(true);
    setOutboundPolicy("approval_required");
    setConfidenceThreshold(0.8);
    setLanguageMode("auto");
    setMailAuthType("password");
    setOauthAccessToken("");
    setOauthRefreshToken(""); setOauthTokenUrl(""); setOauthClientId(""); setOauthClientSecret("");
    setOauthAuthorizationUrl(""); setOauthScopes(""); setOauthRedirectUri(`${window.location.origin}/api/email/oauth/callback`);
    setImapHost("");
    setImapPort(993);
    setImapSecure(true);
    setImapUser("");
    setImapPass("");
    setSmtpHost("");
    setSmtpPort(465);
    setSmtpSecure(true);
    setSmtpUser("");
    setSmtpPass("");
    setMaxPerHour(50);
    setMaxPerDay(500);
    setMaxPerRecipientDaily(100);
    setMaxCompanyPerHour(500);
    setMaxCompanyPerDay(5000);
    setFollowupEnabled(false);
    setFollowupDelayDays(2);
    setFollowupMax(2);
    setFollowupAction("draft");
    setGreeting("Hello,");
    setSignature("Best regards,\nCustomer Support");
    setFooter("");
    setDrawerOpen(true);
  }

  function openEditDrawer(account: EmailAccount) {
    if (account.companyId) setSelectedCompanyId(account.companyId);
    setEditingId(account.id);
    setEmailAddress(account.emailAddress);
    setDisplayName(account.displayName || "");
    setAgentId(account.agentId || "");
    setAccountFormError(null);
    setAccountFieldErrors({});
    setMode(account.mode);
    setTestMode(account.testMode);
    setConfidenceThreshold(account.confidenceThreshold);
    setProvider(account.provider || "imap_smtp");
    setSenderPolicy(account.senderPolicy || "allowlist");
    setAllowedSenders((account.allowedSenders || []).join("\n"));
    setAllowedDomains((account.allowedDomains || []).join("\n"));
    setRequireAuthenticatedSender(account.requireAuthenticatedSender ?? true);
    setOutboundPolicy(account.outboundPolicy || "approval_required");
    setLanguageMode(account.languageMode || "auto");
    setMailAuthType(account.imapConfig.authType || account.smtpConfig.authType || "password");
    setOauthAccessToken("");
    setOauthRefreshToken("");
    setOauthTokenUrl(account.imapConfig.tokenUrl || account.smtpConfig.tokenUrl || "");
    setOauthClientId(account.imapConfig.clientId || account.smtpConfig.clientId || "");
    setOauthClientSecret("");
    setOauthAuthorizationUrl("");
    setOauthScopes("");
    setOauthRedirectUri(`${window.location.origin}/api/email/oauth/callback`);
    setImapHost(account.imapConfig.host || "");
    setImapPort(account.imapConfig.port || 993);
    setImapSecure(account.imapConfig.secure ?? true);
    setImapUser(account.imapConfig.username || "");
    setImapPass("");
    setSmtpHost(account.smtpConfig.host || "");
    setSmtpPort(account.smtpConfig.port || 465);
    setSmtpSecure(account.smtpConfig.secure ?? true);
    setSmtpUser(account.smtpConfig.username || "");
    setSmtpPass("");
    setMaxPerHour(account.rateLimits.maxPerHour);
    setMaxPerDay(account.rateLimits.maxPerDay);
    setMaxPerRecipientDaily(account.rateLimits.maxPerRecipientDaily);
    setMaxCompanyPerHour(account.rateLimits.maxCompanyPerHour ?? 500);
    setMaxCompanyPerDay(account.rateLimits.maxCompanyPerDay ?? 5000);
    setFollowupEnabled(account.followupConfig?.enabled || false);
    setFollowupDelayDays(account.followupConfig?.delayDays || 2);
    setFollowupMax(account.followupConfig?.maxFollowups || 2);
    setFollowupAction(account.followupConfig?.action || "draft");
    setGreeting(account.signatureConfig.greeting || "Hello,");
    setSignature(account.signatureConfig.signature || "Best regards,\nCustomer Support");
    setFooter(account.signatureConfig.footer || "");
    setDrawerOpen(true);
  }

  async function saveAccount(e: FormEvent) {
    e.preventDefault();
    const errors: Record<string, string> = {};
    const normalizedEmail = emailAddress.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) errors.emailAddress = t("emailSettings.messages.emailInvalid");
    if (!imapHost.trim()) errors.imapHost = t("emailSettings.messages.imapHostReq");
    if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) errors.imapPort = t("emailSettings.messages.imapPortReq");
    if (!imapUser.trim()) errors.imapUser = t("emailSettings.messages.imapUserReq");
    if (!smtpHost.trim()) errors.smtpHost = t("emailSettings.messages.smtpHostReq");
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) errors.smtpPort = t("emailSettings.messages.smtpPortReq");
    if (!smtpUser.trim()) errors.smtpUser = t("emailSettings.messages.smtpUserReq");
    if (mailAuthType === "password" && !editingId && !imapPass) errors.imapPass = t("emailSettings.messages.imapPassReq");
    if (mailAuthType === "password" && !editingId && !smtpPass) errors.smtpPass = t("emailSettings.messages.smtpPassReq");
    if (mailAuthType === "oauth2" && !editingId && !oauthAccessToken && (!oauthAuthorizationUrl || !oauthTokenUrl || !oauthClientId)) {
      errors.oauth = t("emailSettings.messages.oauthReq");
    }
    const duplicate = accounts.find((account) => account.id !== editingId && account.emailAddress.trim().toLowerCase() === normalizedEmail);
    if (duplicate) errors.emailAddress = t("emailSettings.messages.duplicateEmail");
    if (Object.keys(errors).length) {
      setAccountFieldErrors(errors);
      setAccountFormError(t("emailSettings.messages.correctFields"));
      const firstField = Object.keys(errors)[0];
      requestAnimationFrame(() => (document.querySelector(`[data-email-field="${firstField}"]`) as HTMLElement | null)?.focus());
      return;
    }
    setAccountFieldErrors({});
    setAccountFormError(null);
    setSaving(true);
    try {
      const payload = {
        emailAddress: normalizedEmail,
        displayName: displayName.trim() || undefined,
        agentId: agentId || undefined,
        mode,
        testMode,
        confidenceThreshold,
        languageMode,
        provider,
        connectionScope,
        senderPolicy,
        allowedSenders: allowedSenders.split(/[\n,]+/).map((value) => value.trim().toLowerCase()).filter(Boolean),
        allowedDomains: allowedDomains.split(/[\n,]+/).map((value) => value.trim().toLowerCase().replace(/^\*?@/, "")).filter(Boolean),
        requireAuthenticatedSender,
        outboundPolicy,
        imapConfig: {
          authType: mailAuthType,
          host: imapHost,
          port: imapPort,
          secure: imapSecure,
          tls: !imapSecure,
          username: imapUser,
          ...(imapPass ? { password: imapPass } : {}),
          ...(oauthAccessToken ? { accessToken: oauthAccessToken } : {}),
          ...(oauthRefreshToken ? { refreshToken: oauthRefreshToken } : {}),
          ...(oauthTokenUrl ? { tokenUrl: oauthTokenUrl } : {}),
          ...(oauthClientId ? { clientId: oauthClientId } : {}),
          ...(oauthClientSecret ? { clientSecret: oauthClientSecret } : {}),
        },
        smtpConfig: {
          authType: mailAuthType,
          host: smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          username: smtpUser,
          ...(smtpPass ? { password: smtpPass } : {}),
          ...(oauthAccessToken ? { accessToken: oauthAccessToken } : {}),
          ...(oauthRefreshToken ? { refreshToken: oauthRefreshToken } : {}),
          ...(oauthTokenUrl ? { tokenUrl: oauthTokenUrl } : {}),
          ...(oauthClientId ? { clientId: oauthClientId } : {}),
          ...(oauthClientSecret ? { clientSecret: oauthClientSecret } : {}),
        },
        rateLimits: { maxPerHour, maxPerDay, maxPerRecipientDaily, maxFollowups: followupMax, maxCompanyPerHour, maxCompanyPerDay },
        followupConfig: { enabled: followupEnabled, delayDays: followupDelayDays, maxFollowups: followupMax, action: followupAction },
        signatureConfig: { greeting, signature, footer },
      };

      if (editingId) {
        const res = await api<{ account: EmailAccount }>(
          `/companies/${selectedCompanyId}/email-accounts/${editingId}`,
          { method: "PATCH", body: JSON.stringify(payload) }
        );
        accountsVersion.current++;
        invalidateEmailSettings(selectedCompanyId);
        setAccounts((prev) => prev.map((a) => (a.id === editingId ? { ...res.account, companyId: selectedCompanyId } : a)));
      } else {
        const res = await api<{ account: EmailAccount }>(
          `/companies/${selectedCompanyId}/email-accounts`,
          { method: "POST", body: JSON.stringify(payload) }
        );
        accountsVersion.current++;
        invalidateEmailSettings(selectedCompanyId);
        setAccounts((prev) => [...prev, { ...res.account, companyId: selectedCompanyId }]);
      }
      setDrawerOpen(false);
    } catch (err: any) {
      setAccountFormError(err.message);
      if (/already connected/i.test(err.message)) setAccountFieldErrors({ emailAddress: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function deleteAccount(id: string) {
    const ok = await confirmModal({
      title: t("emailSettings.dialogs.deleteAccountTitle"),
      message: t("emailSettings.dialogs.deleteAccountMsg"),
      isDanger: true,
    });
    if (!ok) return;

    try {
      const ownerId = accounts.find(account => account.id === id)?.companyId || selectedCompanyId;
      await api(`/companies/${ownerId}/email-accounts/${id}`, { method: "DELETE" });
      accountsVersion.current++;
      invalidateEmailSettings(ownerId);
      invalidateIntegrationsCatalog();
      setAccounts((prev) => prev.filter((a) => a.id !== id));
    } catch (err: any) {
      setNotice(err.message);
    }
  }

  async function startOAuthAuthorization() {
    if (!editingId) {
      setNotice(t("emailSettings.messages.oauthSaveNotice"));
      return;
    }
    try {
      const response = await api<{ authorizationUrl: string }>(
        `/companies/${selectedCompanyId}/email-accounts/${editingId}/oauth/authorize`,
        {
          method: "POST",
          body: JSON.stringify({
            authorizationUrl: oauthAuthorizationUrl,
            tokenUrl: oauthTokenUrl,
            clientId: oauthClientId,
            clientSecret: oauthClientSecret || undefined,
            scopes: oauthScopes.split(/[ ,]+/).map((value) => value.trim()).filter(Boolean),
            redirectUri: oauthRedirectUri,
          }),
        }
      );
      window.open(response.authorizationUrl, "npati-email-oauth", "popup,width=640,height=760,noopener,noreferrer");
      setNotice(t("emailSettings.messages.oauthOpenedNotice"));
    } catch (error: any) {
      setNotice(error.message);
    }
  }

  async function runConnectionTest(account: EmailAccount) {
    setTestingId(account.id);
    setTestResult(null);
    try {
      const res = await api<{ result: { success: boolean; error?: string; imapStatus?: any; smtpStatus?: any } }>(
        `/companies/${account.companyId || selectedCompanyId}/email-accounts/${account.id}/test-connection`,
        { method: "POST" }
      );
      setTestResult({
        id: account.id,
        success: res.result.success,
        message: res.result.success
          ? t("emailSettings.messages.verifiedConnection")
          : res.result.error || t("emailSettings.messages.failedConnection"),
      });
      const ownerId = account.companyId || selectedCompanyId;
      const updated = await api<{ accounts: EmailAccount[] }>(`/companies/${ownerId}/email-accounts`);
      accountsVersion.current++;
      invalidateEmailSettings(ownerId);
      setAccounts(previous => [...previous.filter(item => (item.companyId || selectedCompanyId) !== ownerId), ...updated.accounts.map(item => ({ ...item, companyId: ownerId }))]);
    } catch (err: any) {
      setTestResult({ id: account.id, success: false, message: err.message });
    } finally {
      setTestingId(null);
    }
  }

  async function openDnsCheck(account: EmailAccount) {
    setDnsAccount(account);
    setDnsResult(null);
    setDnsDrawerOpen(true);
    setDnsChecking(true);
    try {
      const res = await api<{ result: DnsCheckResult }>(
        `/companies/${account.companyId || selectedCompanyId}/email-accounts/${account.id}/dns-check`,
        { method: "POST" }
      );
      setDnsResult(res.result);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setDnsChecking(false);
    }
  }

  const filteredAccounts = useMemo(() => {
    if (!searchQuery.trim()) return accounts;
    const q = searchQuery.toLowerCase();
    return accounts.filter((acc) => {
      const name = (acc.displayName || "").toLowerCase();
      const addr = acc.emailAddress.toLowerCase();
      const agent = agents.find((a) => a.id === acc.agentId)?.name.toLowerCase() || "";
      return name.includes(q) || addr.includes(q) || agent.includes(q) || acc.mode.includes(q);
    });
  }, [accounts, searchQuery, agents]);

  const getPermissionLabel = (scope: string) => {
    switch (scope) {
      case "email:view": return t("emailSettings.permissionsTab.permissions.view");
      case "email:manage_accounts": return t("emailSettings.permissionsTab.permissions.manageAccounts");
      case "email:read_messages": return t("emailSettings.permissionsTab.permissions.readMessages");
      case "email:send_messages": return t("emailSettings.permissionsTab.permissions.sendMessages");
      case "email:delete_messages": return t("emailSettings.permissionsTab.permissions.deleteMessages");
      case "email:approve_drafts": return t("emailSettings.permissionsTab.permissions.approveDrafts");
      case "email:configure_autopilot": return t("emailSettings.permissionsTab.permissions.configureAutopilot");
      case "email:configure_agents": return t("emailSettings.permissionsTab.permissions.configureAgents");
      case "email:view_analytics": return t("emailSettings.permissionsTab.permissions.viewAnalytics");
      default: return scope;
    }
  };

  return (
    <main className="goals-container automations-container">
      {/* Hero Header matching /settings/automations and /settings/activity */}
      <EmailSettingsHeroHeader t={t} selectedCompanyId={selectedCompanyId} openCreateDrawer={openCreateDrawer} />

      {/* Mailbox Scope & Quick Actions Toolbar */}
      <EmailSettingsOverviewBlock selectedCompanyId={selectedCompanyId} t={t} setSelectedCompanyId={setSelectedCompanyId} setAgentId={setAgentId} setRuleAgentId={setRuleAgentId} setRuleWorkflowId={setRuleWorkflowId} setRuleCreateTask={setRuleCreateTask} setAccounts={setAccounts} setAnalytics={setAnalytics} companies={companies} accounts={accounts} />

      {/* 4 Stat Overview Cards matching /settings/activity and /settings/capabilities */}
      <EmailSettingsStatsCards analytics={analytics} loading={loading} t={t} />

      {analytics && (
        <EmailSettingsAccountFormSection analytics={analytics} t={t} setAnalyticsExpanded={setAnalyticsExpanded} analyticsExpanded={analyticsExpanded} />
      )}

      {/* Search & Tabs Controls Bar matching /settings/automations */}
      <EmailSettingsHeaderBlock t={t} searchQuery={searchQuery} setSearchQuery={setSearchQuery} activeTab={activeTab} accounts={accounts} setActiveTab={setActiveTab} rules={rules} templates={templates} contacts={contacts} permissionKeys={permissionKeys} />

      {notice && (
        <div className="workspace-notice" style={{ marginBottom: 16 }}>
          {notice}
          <button
            type="button"
            onClick={() => setNotice(null)}
            style={{ float: "right", background: "none", border: "none", cursor: "pointer", fontWeight: "bold" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ACCOUNTS TAB */}
      {activeTab === "accounts" && (
        <EmailSettingsInboxPanel t={t} filteredAccounts={filteredAccounts} accounts={accounts} loading={loading} openCreateDrawer={openCreateDrawer} agents={agents} testingId={testingId} testResult={testResult} selectedCompanyId={selectedCompanyId} runConnectionTest={runConnectionTest} openDnsCheck={openDnsCheck} openEditDrawer={openEditDrawer} deleteAccount={deleteAccount} />
      )}

      {/* RULES TAB */}
      {activeTab === "rules" && (
        <EmailSettingsInboxBlock t={t} openCreateRuleDrawer={() => { if (selectedCompanyId === ALL_COMPANIES) setSelectedCompanyId("personal"); openCreateRuleDrawer(); }} rules={rules} mode={mode} agents={agents} openEditRuleDrawer={(rule: EmailRule) => { if (rule.companyId) setSelectedCompanyId(rule.companyId); openEditRuleDrawer(rule); }} handleDeleteRule={handleDeleteRule} />
      )}

      {/* TEMPLATES TAB */}
      {activeTab === "templates" && (
        <EmailSettingsSidebarBlock t={t} openCreateTemplateDrawer={() => { if (selectedCompanyId === ALL_COMPANIES) setSelectedCompanyId("personal"); openCreateTemplateDrawer(); }} templates={templates} openEditTemplateDrawer={(template: EmailTemplate) => { if (template.companyId) setSelectedCompanyId(template.companyId); openEditTemplateDrawer(template); }} handleDeleteTemplate={handleDeleteTemplate} />
      )}

      {/* CONTACTS & VIP TAB */}
      {activeTab === "contacts" && (
        <EmailSettingsTestBlock t={t} openCreateContactDrawer={() => { if (selectedCompanyId === ALL_COMPANIES) setSelectedCompanyId("personal"); openCreateContactDrawer(); }} contacts={contacts} openEditContactDrawer={(contact: ContactItem) => { if (contact.companyId) setSelectedCompanyId(contact.companyId); openEditContactDrawer(contact); }} companies={companies} selectedCompanyId={selectedCompanyId} setContacts={setContacts} />
      )}

      {/* GRANULAR EMAIL PERMISSIONS */}
      {activeTab === "permissions" && (
        selectedCompanyId === "personal" ? (
          <div className="automations-empty-card">
            <div className="automations-empty-icon">🔒</div>
            <h3>{t("emailSettings.permissionsTab.personalEmptyTitle")}</h3>
            <p>{t("emailSettings.permissionsTab.personalEmptyDesc")}</p>
          </div>
        ) : (
        <EmailSettingsFooterBlock t={t} createPermissionKey={createPermissionKey} permissionKeyName={permissionKeyName} setPermissionKeyName={setPermissionKeyName} selectedEmailPermissions={selectedEmailPermissions} setSelectedEmailPermissions={setSelectedEmailPermissions} getPermissionLabel={getPermissionLabel} savingPermissionKey={savingPermissionKey} createdPermissionToken={createdPermissionToken} notice={notice} permissionKeys={permissionKeys} language={language} revokePermissionKey={revokePermissionKey} />
        )
      )}

      {/* ADD / EDIT ACCOUNT DRAWER */}
      {drawerOpen && (
        <EmailSettingsTemplatesSection setDrawerOpen={setDrawerOpen} t={t} editingId={editingId} saveAccount={saveAccount} accountFormError={accountFormError} notice={notice} selectedCompanyId={selectedCompanyId} setSelectedCompanyId={setSelectedCompanyId} setAgentId={setAgentId} setRuleAgentId={setRuleAgentId} setRuleWorkflowId={setRuleWorkflowId} setRuleCreateTask={setRuleCreateTask} setAccounts={setAccounts} setAnalytics={setAnalytics} companies={companies} emailAddress={emailAddress} accountFieldErrors={accountFieldErrors} setEmailAddress={setEmailAddress} setAccountFieldErrors={setAccountFieldErrors} displayName={displayName} setDisplayName={setDisplayName} agentId={agentId} agents={agents} provider={provider} setProvider={setProvider} setMailAuthType={setMailAuthType} setImapHost={setImapHost} setImapPort={setImapPort} setImapSecure={setImapSecure} setSmtpHost={setSmtpHost} setSmtpPort={setSmtpPort} setSmtpSecure={setSmtpSecure} setOauthAuthorizationUrl={setOauthAuthorizationUrl} accounts={accounts} setOauthTokenUrl={setOauthTokenUrl} setOauthScopes={setOauthScopes} outboundPolicy={outboundPolicy} setOutboundPolicy={setOutboundPolicy} mode={mode} setMode={setMode} confidenceThreshold={confidenceThreshold} setConfidenceThreshold={setConfidenceThreshold} testMode={testMode} setTestMode={setTestMode} mailAuthType={mailAuthType} oauthAccessToken={oauthAccessToken} setOauthAccessToken={setOauthAccessToken} oauthRefreshToken={oauthRefreshToken} setOauthRefreshToken={setOauthRefreshToken} oauthTokenUrl={oauthTokenUrl} oauthAuthorizationUrl={oauthAuthorizationUrl} oauthClientId={oauthClientId} setOauthClientId={setOauthClientId} oauthClientSecret={oauthClientSecret} setOauthClientSecret={setOauthClientSecret} oauthScopes={oauthScopes} oauthRedirectUri={oauthRedirectUri} setOauthRedirectUri={setOauthRedirectUri} startOAuthAuthorization={startOAuthAuthorization} imapHost={imapHost} imapPort={imapPort} imapUser={imapUser} setImapUser={setImapUser} imapPass={imapPass} setImapPass={setImapPass} imapSecure={imapSecure} smtpHost={smtpHost} smtpPort={smtpPort} smtpUser={smtpUser} setSmtpUser={setSmtpUser} smtpPass={smtpPass} setSmtpPass={setSmtpPass} smtpSecure={smtpSecure} senderPolicy={senderPolicy} setSenderPolicy={setSenderPolicy} requireAuthenticatedSender={requireAuthenticatedSender} setRequireAuthenticatedSender={setRequireAuthenticatedSender} allowedSenders={allowedSenders} setAllowedSenders={setAllowedSenders} allowedDomains={allowedDomains} setAllowedDomains={setAllowedDomains} rules={rules} connectionScope={connectionScope} maxPerHour={maxPerHour} setMaxPerHour={setMaxPerHour} maxPerDay={maxPerDay} setMaxPerDay={setMaxPerDay} maxPerRecipientDaily={maxPerRecipientDaily} setMaxPerRecipientDaily={setMaxPerRecipientDaily} maxCompanyPerHour={maxCompanyPerHour} setMaxCompanyPerHour={setMaxCompanyPerHour} maxCompanyPerDay={maxCompanyPerDay} setMaxCompanyPerDay={setMaxCompanyPerDay} followupEnabled={followupEnabled} setFollowupEnabled={setFollowupEnabled} followupDelayDays={followupDelayDays} setFollowupDelayDays={setFollowupDelayDays} followupMax={followupMax} setFollowupMax={setFollowupMax} followupAction={followupAction} setFollowupAction={setFollowupAction} greeting={greeting} setGreeting={setGreeting} signature={signature} setSignature={setSignature} footer={footer} saving={saving} />
      )}

      {/* ADD / EDIT ROUTING RULE DRAWER */}
      {ruleDrawerOpen && (
        <EmailSettingsAnalyticsBlock setRuleDrawerOpen={setRuleDrawerOpen} t={t} editingRuleId={editingRuleId} handleSaveRule={handleSaveRule} ruleName={ruleName} setRuleName={setRuleName} ruleSubjectKeywords={ruleSubjectKeywords} setRuleSubjectKeywords={setRuleSubjectKeywords} ruleSenders={ruleSenders} setRuleSenders={setRuleSenders} ruleDomains={ruleDomains} setRuleDomains={setRuleDomains} ruleBodyKeywords={ruleBodyKeywords} setRuleBodyKeywords={setRuleBodyKeywords} ruleDetectedIntent={ruleDetectedIntent} setRuleDetectedIntent={setRuleDetectedIntent} ruleAttachmentTypes={ruleAttachmentTypes} setRuleAttachmentTypes={setRuleAttachmentTypes} ruleIsVip={ruleIsVip} setRuleIsVip={setRuleIsVip} rulePriority={rulePriority} setRulePriority={setRulePriority} ruleMode={ruleMode} setRuleMode={setRuleMode} ruleAgentId={ruleAgentId} setRuleAgentId={setRuleAgentId} selectedCompanyId={selectedCompanyId} agents={agents} ruleTemplateId={ruleTemplateId} setRuleTemplateId={setRuleTemplateId} templates={templates} ruleWorkflowId={ruleWorkflowId} setRuleWorkflowId={setRuleWorkflowId} workflows={workflows} ruleRequireApproval={ruleRequireApproval} setRuleRequireApproval={setRuleRequireApproval} ruleCreateTask={ruleCreateTask} setRuleCreateTask={setRuleCreateTask} ruleAutoTagSpam={ruleAutoTagSpam} setRuleAutoTagSpam={setRuleAutoTagSpam} footer={footer} savingRule={savingRule} />
      )}

      {/* ADD / EDIT RESPONSE TEMPLATE DRAWER */}
      {templateDrawerOpen && (
        <EmailSettingsPermissionsBlock setTemplateDrawerOpen={setTemplateDrawerOpen} t={t} editingTemplateId={editingTemplateId} handleSaveTemplate={handleSaveTemplate} templateTitle={templateTitle} setTemplateTitle={setTemplateTitle} templateCategory={templateCategory} setTemplateCategory={setTemplateCategory} templateSubject={templateSubject} setTemplateSubject={setTemplateSubject} setTemplateBody={setTemplateBody} templateBody={templateBody} footer={footer} savingTemplate={savingTemplate} />
      )}

      {/* ADD / EDIT CONTACT DRAWER */}
      {contactDrawerOpen && (
        <EmailSettingsRulesSection setContactDrawerOpen={setContactDrawerOpen} t={t} editingContactEmail={editingContactEmail} handleSaveContact={handleSaveContact} contactEmail={contactEmail} setContactEmail={setContactEmail} contactName={contactName} setContactName={setContactName} contactCompanyName={contactCompanyName} setContactCompanyName={setContactCompanyName} contactPhone={contactPhone} setContactPhone={setContactPhone} contactIsVip={contactIsVip} setContactIsVip={setContactIsVip} contactIsBlacklisted={contactIsBlacklisted} setContactIsBlacklisted={setContactIsBlacklisted} contactNotes={contactNotes} setContactNotes={setContactNotes} footer={footer} savingContact={savingContact} />
      )}

      {/* DNS AUDIT DRAWER */}
      {dnsDrawerOpen && (
        <EmailSettingsContactsSection setDnsDrawerOpen={setDnsDrawerOpen} t={t} dnsAccount={dnsAccount} dnsChecking={dnsChecking} dnsResult={dnsResult} name={name} footer={footer} />
      )}
    </main>
  );
}
