import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { chooseAvailableCompanyId, writeActiveCompanyId } from "./active-company";
import { useWorkspace } from "./BusinessWorkspace";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";

interface Company {
  id: string;
  name: string;
}

interface Agent {
  id: string;
  name: string;
  role: string;
}

interface CompanyAutomation {
  id: string;
  name: string;
  status: "active" | "paused" | "deleted";
}

interface EmailAccount {
  id: string;
  emailAddress: string;
  displayName?: string | null;
  agentId?: string | null;
  mode: "manual" | "approval" | "autopilot";
  status: "connected" | "pending" | "auth_error" | "imap_error" | "smtp_error" | "dns_error" | "disabled";
  testMode: boolean;
  confidenceThreshold: number;
  languageMode: string;
  fallbackLanguage: string;
  imapConfig: { authType?: "password" | "oauth2"; host?: string; port?: number; secure?: boolean; username?: string; password?: string; tokenUrl?: string; clientId?: string; tokenExpiresAt?: string; lastError?: string | null };
  smtpConfig: { authType?: "password" | "oauth2"; host?: string; port?: number; secure?: boolean; username?: string; password?: string; tokenUrl?: string; clientId?: string; tokenExpiresAt?: string; fromName?: string; replyTo?: string; lastError?: string | null };
  rateLimits: { maxPerHour: number; maxPerDay: number; maxPerRecipientDaily: number; maxFollowups: number; maxCompanyPerHour?: number; maxCompanyPerDay?: number };
  followupConfig: { enabled: boolean; delayDays: number; maxFollowups: number; action: "draft" | "auto_send" | "create_task" | "notify_user" };
  signatureConfig: { greeting?: string; signature?: string; footer?: string };
  createdAt: string;
  updatedAt: string;
}

interface DnsRecordCheck {
  recordType: "MX" | "SPF" | "DKIM" | "DMARC";
  name: string;
  found: boolean;
  valid: boolean;
  currentValue?: string;
  expectedValueHint?: string;
  recommendation?: string;
}

interface DnsCheckResult {
  domain: string;
  verified: boolean;
  records: DnsRecordCheck[];
  summary: string;
}

interface EmailRule {
  id: string;
  name: string;
  priorityOrder: number;
  isActive: boolean;
  conditions: { senders?: string[]; domains?: string[]; subjectKeywords?: string[]; bodyKeywords?: string[]; detectedIntent?: string; attachmentTypes?: string[]; isVip?: boolean };
  actions: { setMode?: string; setPriority?: string; setAgentId?: string; requireApproval?: boolean; createTask?: boolean; autoTagSpam?: boolean; autoReplyTemplateId?: string; startWorkflowId?: string };
}

interface EmailTemplate {
  id: string;
  title: string;
  category: string;
  subjectTemplate?: string;
  bodyTemplate: string;
}

interface ContactItem {
  id: string;
  email: string;
  name?: string | null;
  companyName?: string | null;
  phone?: string | null;
  isVip: boolean;
  isBlacklisted: boolean;
  notes?: string | null;
}

interface EmailAnalytics {
  receivedEmails: number;
  sentEmails: number;
  aiAnswered: number;
  humanAnswered: number;
  draftedByAi: number;
  approvedByHuman: number;
  escalatedToHuman: number;
  failedEmails: number;
  bouncedEmails: number;
  averageResponseTimeMinutes: number;
  averageFirstResponseTimeMinutes: number;
  editedAiResponsesCount: number;
  automationRate: number;
  confidenceDistribution: { high: number; medium: number; low: number };
  volumeByDay: Array<{ date: string; received: number; sent: number }>;
  volumeByAgent: Array<{ agentId: string; agentName: string; count: number }>;
  volumeByAccount: Array<{ accountId: string; email: string; count: number }>;
}

interface EmailPermissionKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const EMAIL_PERMISSION_OPTIONS = [
  ["email:view", "View email module"],
  ["email:manage_accounts", "Manage email accounts"],
  ["email:read_messages", "Read messages"],
  ["email:send_messages", "Send messages"],
  ["email:delete_messages", "Delete messages"],
  ["email:approve_drafts", "Approve AI drafts"],
  ["email:configure_autopilot", "Configure Autopilot"],
  ["email:configure_agents", "Configure agents and rules"],
  ["email:view_analytics", "View analytics"],
] as const;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = (await response.json().catch(() => null)) as T & { error?: { message?: string } | string; message?: string };
  if (!response.ok) {
    const apiMessage = typeof body?.error === "string" ? body?.message || body.error : body?.error?.message || body?.message;
    const deploymentHint = response.status === 404 && (!apiMessage || /^Route .* not found$/i.test(apiMessage))
      ? `${apiMessage ? `${apiMessage} ` : ""}Deploy/restart both the web and agent-api services from the same revision.`
      : undefined;
    throw new Error(apiMessage || deploymentHint || `Request failed (${response.status})`);
  }
  return body;
}

export function EmailSettingsPage() {
  const { t, language } = useTranslation();
  const { overview } = useWorkspace();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("personal");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [activeTab, setActiveTab] = useState<"accounts" | "rules" | "templates" | "contacts" | "permissions">("accounts");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  // Email Account Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [emailAddress, setEmailAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [mode, setMode] = useState<"manual" | "approval" | "autopilot">("approval");
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
  const [maxPerRecipientDaily, setMaxPerRecipientDaily] = useState(5);
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

  // Rules Drawer & State
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

  // Templates Drawer & State
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templateDrawerOpen, setTemplateDrawerOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateTitle, setTemplateTitle] = useState("");
  const [templateCategory, setTemplateCategory] = useState("general");
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Contacts Drawer & State
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [editingContactEmail, setEditingContactEmail] = useState<string | null>(null);
  const [contactEmail, setContactEmail] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactCompanyName, setContactCompanyName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactIsVip, setContactIsVip] = useState(false);
  const [contactIsBlacklisted, setContactIsBlacklisted] = useState(false);
  const [contactNotes, setContactNotes] = useState("");
  const [savingContact, setSavingContact] = useState(false);

  // Analytics
  const [analytics, setAnalytics] = useState<EmailAnalytics | null>(null);
  const [analyticsExpanded, setAnalyticsExpanded] = useState(true);

  // Granular permissions are delegated through the existing scoped API-key system.
  const [permissionKeys, setPermissionKeys] = useState<EmailPermissionKey[]>([]);
  const [permissionKeyName, setPermissionKeyName] = useState("Email integration");
  const [selectedEmailPermissions, setSelectedEmailPermissions] = useState<string[]>(["email:view", "email:read_messages"]);
  const [createdPermissionToken, setCreatedPermissionToken] = useState<string | null>(null);
  const [savingPermissionKey, setSavingPermissionKey] = useState(false);

  // Load companies
  useEffect(() => {
    api<{ companies: Company[] }>("/companies")
      .then((res) => {
        setCompanies(res.companies);
        const currentUrl = new URL(window.location.href);
        const requested = currentUrl.searchParams.get("company");
        const selected = requested === "personal"
          ? "personal"
          : chooseAvailableCompanyId(res.companies, { requested, fallback: "personal" });
        setSelectedCompanyId(selected);
        writeActiveCompanyId(selected === "personal" ? "" : selected);
        if (requested) {
          currentUrl.searchParams.delete("company");
          window.history.replaceState(window.history.state, "", currentUrl.pathname + currentUrl.search + currentUrl.hash);
        }
      })
      .catch((e) => setNotice(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Load accounts, agents and analytics when company changes
  useEffect(() => {
    if (!selectedCompanyId) return;
    setLoading(true);
    const personalScope = selectedCompanyId === "personal";
    Promise.all([
      api<{ accounts: EmailAccount[] }>(`/companies/${selectedCompanyId}/email-accounts`),
      personalScope ? Promise.resolve({ agents: [] as Agent[] }) : api<{ agents: Agent[] }>(`/companies/${selectedCompanyId}/agents`),
      api<{ analytics: EmailAnalytics }>(`/companies/${selectedCompanyId}/email-inbox/analytics`).catch(() => ({ analytics: null })),
    ])
      .then(([accRes, agentRes, analRes]) => {
        setAccounts(accRes.accounts);
        setAgents(agentRes.agents);
        if (analRes.analytics) setAnalytics(analRes.analytics);
      })
      .catch((e) => setNotice(e.message))
      .finally(() => setLoading(false));
  }, [selectedCompanyId]);

  // Load rules/templates/contacts on tab switch
  useEffect(() => {
    if (!selectedCompanyId) return;
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
        .then((r) => setPermissionKeys(r.keys.filter((key) => key.scopes.some((scope) => scope.startsWith("email:")))))
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    }
  }, [selectedCompanyId, activeTab]);

  async function createPermissionKey(event: FormEvent) {
    event.preventDefault();
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
    await api(`/companies/${selectedCompanyId}/api-keys/${keyId}`, { method: "DELETE" });
    setPermissionKeys((current) => current.filter((key) => key.id !== keyId));
  }

  function openCreateDrawer() {
    setEditingId(null);
    setEmailAddress("");
    setDisplayName("");
    setAgentId("");
    setAccountFormError(null);
    setAccountFieldErrors({});
    setMode("approval");
    setTestMode(false);
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
    setMaxPerRecipientDaily(5);
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
    setEditingId(account.id);
    setEmailAddress(account.emailAddress);
    setDisplayName(account.displayName || "");
    setAgentId(account.agentId || "");
    setAccountFormError(null);
    setAccountFieldErrors({});
    setMode(account.mode);
    setTestMode(account.testMode);
    setConfidenceThreshold(account.confidenceThreshold);
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
        imapConfig: {
          authType: mailAuthType,
          host: imapHost,
          port: imapPort,
          secure: imapSecure,
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
        setAccounts((prev) => prev.map((a) => (a.id === editingId ? res.account : a)));
      } else {
        const res = await api<{ account: EmailAccount }>(
          `/companies/${selectedCompanyId}/email-accounts`,
          { method: "POST", body: JSON.stringify(payload) }
        );
        setAccounts((prev) => [...prev, res.account]);
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
      await api(`/companies/${selectedCompanyId}/email-accounts/${id}`, { method: "DELETE" });
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
        `/companies/${selectedCompanyId}/email-accounts/${account.id}/test-connection`,
        { method: "POST" }
      );
      setTestResult({
        id: account.id,
        success: res.result.success,
        message: res.result.success
          ? t("emailSettings.messages.verifiedConnection")
          : res.result.error || t("emailSettings.messages.failedConnection"),
      });
      const updated = await api<{ accounts: EmailAccount[] }>(`/companies/${selectedCompanyId}/email-accounts`);
      setAccounts(updated.accounts);
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
        `/companies/${selectedCompanyId}/email-accounts/${account.id}/dns-check`,
        { method: "POST" }
      );
      setDnsResult(res.result);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setDnsChecking(false);
    }
  }

  // --- Rule Drawer Handlers ---
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
      await api(`/companies/${selectedCompanyId}/email-inbox/rules/${id}`, { method: "DELETE" });
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (err: any) {
      setNotice(err.message);
    }
  }

  // --- Template Drawer Handlers ---
  function openCreateTemplateDrawer() {
    setEditingTemplateId(null);
    setTemplateTitle("");
    setTemplateCategory("general");
    setTemplateSubject("");
    setTemplateBody("Hello {{customer_name}},\n\nThank you for reaching out to {{company_name}}.\n\nBest regards,\n{{agent_name}}");
    setTemplateDrawerOpen(true);
  }

  function openEditTemplateDrawer(tItem: EmailTemplate) {
    setEditingTemplateId(tItem.id);
    setTemplateTitle(tItem.title);
    setTemplateCategory(tItem.category);
    setTemplateSubject(tItem.subjectTemplate || "");
    setTemplateBody(tItem.bodyTemplate);
    setTemplateDrawerOpen(true);
  }

  async function handleSaveTemplate(e: FormEvent) {
    e.preventDefault();
    if (!templateTitle.trim() || !templateBody.trim()) {
      setNotice(t("emailSettings.messages.templateFieldsReq"));
      return;
    }
    setSavingTemplate(true);
    try {
      if (editingTemplateId) {
        const res = await api<{ template: EmailTemplate }>(`/companies/${selectedCompanyId}/email-inbox/templates/${editingTemplateId}`, {
          method: "PATCH",
          body: JSON.stringify({
            title: templateTitle.trim(),
            category: templateCategory,
            subjectTemplate: templateSubject.trim() || null,
            bodyTemplate: templateBody,
          }),
        });
        setTemplates((prev) => prev.map((item) => (item.id === editingTemplateId ? res.template : item)));
      } else {
        const res = await api<{ template: EmailTemplate }>(`/companies/${selectedCompanyId}/email-inbox/templates`, {
          method: "POST",
          body: JSON.stringify({
            title: templateTitle.trim(),
            category: templateCategory,
            subjectTemplate: templateSubject.trim() || undefined,
            bodyTemplate: templateBody,
          }),
        });
        setTemplates((prev) => [...prev, res.template]);
      }
      setTemplateDrawerOpen(false);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleDeleteTemplate(id: string) {
    const ok = await confirmModal({
      title: t("emailSettings.dialogs.deleteTemplateTitle"),
      message: t("emailSettings.dialogs.deleteTemplateMsg"),
      isDanger: true,
    });
    if (!ok) return;
    try {
      await api(`/companies/${selectedCompanyId}/email-inbox/templates/${id}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((item) => item.id !== id));
    } catch (err: any) {
      setNotice(err.message);
    }
  }

  // --- Contact Drawer Handlers ---
  function openCreateContactDrawer(isVip = true) {
    setEditingContactEmail(null);
    setContactEmail("");
    setContactName("");
    setContactCompanyName("");
    setContactPhone("");
    setContactIsVip(isVip);
    setContactIsBlacklisted(false);
    setContactNotes("");
    setContactDrawerOpen(true);
  }

  function openEditContactDrawer(c: ContactItem) {
    setEditingContactEmail(c.email);
    setContactEmail(c.email);
    setContactName(c.name || "");
    setContactCompanyName(c.companyName || "");
    setContactPhone(c.phone || "");
    setContactIsVip(c.isVip);
    setContactIsBlacklisted(c.isBlacklisted);
    setContactNotes(c.notes || "");
    setContactDrawerOpen(true);
  }

  async function handleSaveContact(e: FormEvent) {
    e.preventDefault();
    if (!contactEmail.includes("@")) {
      setNotice(t("emailSettings.messages.validContactEmailReq"));
      return;
    }
    setSavingContact(true);
    try {
      const res = await api<{ contact: ContactItem }>(`/companies/${selectedCompanyId}/email-inbox/contacts/${encodeURIComponent(contactEmail.trim().toLowerCase())}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: contactName.trim() || undefined,
          companyName: contactCompanyName.trim() || undefined,
          phone: contactPhone.trim() || undefined,
          isVip: contactIsVip,
          isBlacklisted: contactIsBlacklisted,
          notes: contactNotes.trim() || undefined,
        }),
      });
      setContacts((prev) => [...prev.filter((c) => c.email !== res.contact.email), res.contact]);
      setContactDrawerOpen(false);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setSavingContact(false);
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
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{t("emailSettings.eyebrow")}</p>
            <h1>
              <Link to="/settings" className="marketplace-back-button" aria-label={t("emailSettings.backAria")} title={t("emailSettings.backAria")}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{t("emailSettings.title")}</span>
            </h1>
            <p className="hero-copy">
              {t("emailSettings.heroCopy")}
            </p>
          </div>
          <div className="automations-header-actions">
            <Link
              to="/settings/email/inbox"
              className="button-secondary automations-action-primary"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              {t("emailSettings.openInbox")}
            </Link>
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={openCreateDrawer}
              title={t("emailSettings.addEmailTitle")}
            >
              {t("emailSettings.addEmailBtn")}
            </button>
          </div>
        </div>
      </header>

      {/* Mailbox Scope & Quick Actions Toolbar */}
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
                }}
                className="email-scope-select"
              >
                <option value="personal">{t("emailSettings.scope.personalScope")}</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {t("emailSettings.scope.companyScopePrefix")}{c.name}
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
            to="/settings/email/inbox?compose=1"
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

      {/* 4 Stat Overview Cards matching /settings/activity and /settings/capabilities */}
      <section className="overview-grid inspector-stats-grid automations-stats-grid">
        <div>
          <strong>{analytics?.receivedEmails ?? 0}</strong>
          <span>{t("emailSettings.stats.totalReceived")}</span>
          <small>{t("emailSettings.stats.totalReceivedDesc")}</small>
        </div>
        <div>
          <strong>{analytics?.sentEmails ?? 0}</strong>
          <span>{t("emailSettings.stats.totalSent")}</span>
          <small>{t("emailSettings.stats.totalSentDesc")}</small>
        </div>
        <div>
          <strong>{Math.round(analytics?.automationRate ?? 0)}%</strong>
          <span>{t("emailSettings.stats.automationRate")}</span>
          <small>{t("emailSettings.stats.automationRateDesc")}</small>
        </div>
        <div>
          <strong>{analytics?.draftedByAi ?? 0}</strong>
          <span>{t("emailSettings.stats.draftsPrepared")}</span>
          <small>{t("emailSettings.stats.draftsPreparedDesc")}</small>
        </div>
      </section>

      {analytics && (
        <div className="email-analytics-dashboard">
          <div className="email-analytics-dashboard-header">
            <div className="email-analytics-header-left">
              <div className="email-analytics-icon-badge">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <path d="M18 9l-5 5-4-4-6 6" />
                </svg>
              </div>
              <div>
                <h3>{t("emailSettings.analytics.dashboardTitle")}</h3>
                <p>{t("emailSettings.analytics.dashboardSubtitle")}</p>
              </div>
            </div>
            <div className="email-analytics-header-right">
              <button
                type="button"
                className="email-analytics-collapse-btn"
                onClick={() => setAnalyticsExpanded((prev) => !prev)}
                aria-expanded={analyticsExpanded}
              >
                {analyticsExpanded ? (
                  <>
                    <span>{t("emailSettings.analytics.hideDetails")}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 15l-6-6-6 6" /></svg>
                  </>
                ) : (
                  <>
                    <span>{t("emailSettings.analytics.showDetails")}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
                  </>
                )}
              </button>
            </div>
          </div>

          {analyticsExpanded && (
            <div className="email-analytics-dashboard-content">
              {/* 3 Metric Categories */}
              <div className="email-metrics-categories-grid">
                {/* Category 1: AI & Human Handling */}
                <div className="email-metric-category-card">
                  <div className="email-metric-category-title">
                    <span className="email-cat-icon">🤖</span>
                    <span>{t("emailSettings.analytics.handlingTitle")}</span>
                  </div>
                  <div className="email-metric-items-list">
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-blue" />
                        <span className="email-metric-label">{t("emailSettings.analytics.aiAnswered")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.aiAnswered}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-indigo" />
                        <span className="email-metric-label">{t("emailSettings.analytics.humanAnswered")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.humanAnswered}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-emerald" />
                        <span className="email-metric-label">{t("emailSettings.analytics.approvedByHuman")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.approvedByHuman}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-amber" />
                        <span className="email-metric-label">{t("emailSettings.analytics.escalatedToHuman")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.escalatedToHuman}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-purple" />
                        <span className="email-metric-label">{t("emailSettings.analytics.editedAiResponses")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.editedAiResponsesCount}</strong>
                    </div>
                  </div>
                </div>

                {/* Category 2: Speed & Delivery Health */}
                <div className="email-metric-category-card">
                  <div className="email-metric-category-title">
                    <span className="email-cat-icon">⚡</span>
                    <span>{t("emailSettings.analytics.speedTitle")}</span>
                  </div>
                  <div className="email-metric-items-list">
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-cyan" />
                        <span className="email-metric-label">{t("emailSettings.analytics.avgResponse")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.averageResponseTimeMinutes} {t("emailSettings.analytics.minutesUnit")}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-teal" />
                        <span className="email-metric-label">{t("emailSettings.analytics.avgFirstResponse")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.averageFirstResponseTimeMinutes} {t("emailSettings.analytics.minutesUnit")}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-rose" />
                        <span className="email-metric-label">{t("emailSettings.analytics.failedDeliveries")}</span>
                      </div>
                      <strong className={`email-metric-val ${analytics.failedEmails > 0 ? "val-danger" : ""}`}>
                        {analytics.failedEmails}
                      </strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-orange" />
                        <span className="email-metric-label">{t("emailSettings.analytics.bouncedEmails")}</span>
                      </div>
                      <strong className={`email-metric-val ${analytics.bouncedEmails > 0 ? "val-danger" : ""}`}>
                        {analytics.bouncedEmails}
                      </strong>
                    </div>
                  </div>
                </div>

                {/* Category 3: AI Confidence Distribution */}
                <div className="email-metric-category-card">
                  <div className="email-metric-category-title">
                    <span className="email-cat-icon">🎯</span>
                    <span>{t("emailSettings.analytics.confidenceTitle")}</span>
                  </div>
                  <div className="email-metric-items-list">
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-confidence-badge conf-high">{t("emailSettings.analytics.highBadge")}</span>
                        <span className="email-metric-label">{t("emailSettings.analytics.highConfidence")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.confidenceDistribution.high}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-confidence-badge conf-med">{t("emailSettings.analytics.medBadge")}</span>
                        <span className="email-metric-label">{t("emailSettings.analytics.medConfidence")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.confidenceDistribution.medium}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-confidence-badge conf-low">{t("emailSettings.analytics.lowBadge")}</span>
                        <span className="email-metric-label">{t("emailSettings.analytics.lowConfidence")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.confidenceDistribution.low}</strong>
                    </div>
                  </div>
                </div>
              </div>

              {/* 3 Volume Breakdown Tables */}
              <div className="email-volume-panels-grid">
                {/* Volume by Day */}
                <div className="email-volume-card">
                  <div className="email-volume-card-header">
                    <div className="email-volume-card-title">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                      <h4>{t("emailSettings.analytics.volumeByDayTitle")}</h4>
                    </div>
                    <span className="email-volume-count-badge">{t("emailSettings.analytics.daysCount").replace("{{count}}", String(analytics.volumeByDay.length))}</span>
                  </div>
                  {analytics.volumeByDay.length === 0 ? (
                    <div className="email-volume-empty">
                      <p>{t("emailSettings.analytics.noVolumeByDay")}</p>
                    </div>
                  ) : (
                    <div className="email-volume-table-wrap">
                      <table className="automations-table">
                        <thead>
                          <tr>
                            <th>{t("emailSettings.analytics.colDate")}</th>
                            <th style={{ textAlign: "right" }}>{t("emailSettings.analytics.colReceived")}</th>
                            <th style={{ textAlign: "right" }}>{t("emailSettings.analytics.colSent")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.volumeByDay.map((row) => (
                            <tr key={row.date}>
                              <td><strong>{row.date}</strong></td>
                              <td style={{ textAlign: "right" }}><span className="email-traffic-pill in">{row.received}</span></td>
                              <td style={{ textAlign: "right" }}><span className="email-traffic-pill out">{row.sent}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Volume by Agent */}
                <div className="email-volume-card">
                  <div className="email-volume-card-header">
                    <div className="email-volume-card-title">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><path d="M12 7v4" /><line x1="8" y1="16" x2="8" y2="16" /><line x1="16" y1="16" x2="16" y2="16" /></svg>
                      <h4>{t("emailSettings.analytics.volumeByAgentTitle")}</h4>
                    </div>
                    <span className="email-volume-count-badge">{t("emailSettings.analytics.agentsCount").replace("{{count}}", String(analytics.volumeByAgent.length))}</span>
                  </div>
                  {analytics.volumeByAgent.length === 0 ? (
                    <div className="email-volume-empty">
                      <p>{t("emailSettings.analytics.noVolumeByAgent")}</p>
                    </div>
                  ) : (
                    <div className="email-volume-table-wrap">
                      <table className="automations-table">
                        <thead>
                          <tr>
                            <th>{t("emailSettings.analytics.colAgent")}</th>
                            <th style={{ textAlign: "right" }}>{t("emailSettings.analytics.colMessages")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.volumeByAgent.map((row) => (
                            <tr key={row.agentId}>
                              <td>
                                <div className="email-table-agent-cell">
                                  <span className="agent-avatar-mini">🤖</span>
                                  <span>{row.agentName}</span>
                                </div>
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <span className="email-traffic-pill msg">{row.count}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Volume by Account */}
                <div className="email-volume-card">
                  <div className="email-volume-card-header">
                    <div className="email-volume-card-title">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
                      <h4>{t("emailSettings.analytics.volumeByAccountTitle")}</h4>
                    </div>
                    <span className="email-volume-count-badge">{t("emailSettings.analytics.accountsCount").replace("{{count}}", String(analytics.volumeByAccount.length))}</span>
                  </div>
                  {analytics.volumeByAccount.length === 0 ? (
                    <div className="email-volume-empty">
                      <p>{t("emailSettings.analytics.noVolumeByAccount")}</p>
                    </div>
                  ) : (
                    <div className="email-volume-table-wrap">
                      <table className="automations-table">
                        <thead>
                          <tr>
                            <th>{t("emailSettings.analytics.colAccount")}</th>
                            <th style={{ textAlign: "right" }}>{t("emailSettings.analytics.colMessages")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.volumeByAccount.map((row) => (
                            <tr key={row.accountId}>
                              <td>
                                <div className="email-table-account-cell">
                                  <span className="email-avatar-mini">✉️</span>
                                  <span className="email-truncate-address" title={row.email}>{row.email}</span>
                                </div>
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <span className="email-traffic-pill msg">{row.count}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Search & Tabs Controls Bar matching /settings/automations */}
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
        <>
          <div className="inspector-table-status">
            <div className="status-left">
              <span>
                {t("emailSettings.accountsTab.showingAccounts")
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
            <div className="automations-table-container">
              <table className="automations-table">
                <thead>
                  <tr>
                    <th style={{ minWidth: "220px" }}>{t("emailSettings.accountsTab.colAccount")}</th>
                    <th style={{ minWidth: "160px" }}>{t("emailSettings.accountsTab.colAssignedAgent")}</th>
                    <th style={{ minWidth: "150px" }}>{t("emailSettings.accountsTab.colMode")}</th>
                    <th style={{ minWidth: "180px" }}>{t("emailSettings.accountsTab.colConnectionDns")}</th>
                    <th style={{ width: "240px", textAlign: "right" }}>{t("emailSettings.accountsTab.colActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAccounts.map((acc) => {
                    const assigned = agents.find((a) => a.id === acc.agentId);
                    const isTesting = testingId === acc.id;
                    const testFeedback = testResult?.id === acc.id ? testResult : null;

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
                              to={`/settings/email/inbox?compose=1&account=${encodeURIComponent(acc.id)}`}
                              className="automation-action-btn"
                              title={t("emailSettings.accountsTab.actionComposeTitle").replace("{{email}}", acc.emailAddress)}
                            >
                              {t("emailSettings.accountsTab.actionCompose")}
                            </Link>
                            <button
                              type="button"
                              className="automation-action-btn"
                              disabled={isTesting}
                              onClick={() => runConnectionTest(acc)}
                              title={t("emailSettings.accountsTab.actionTestTitle")}
                            >
                              {isTesting ? t("emailSettings.accountsTab.actionTesting") : t("emailSettings.accountsTab.actionTest")}
                            </button>
                            <button
                              type="button"
                              className="automation-action-btn"
                              onClick={() => openDnsCheck(acc)}
                              title={t("emailSettings.accountsTab.actionDnsTitle")}
                            >
                              {t("emailSettings.accountsTab.actionDns")}
                            </button>
                            <button
                              type="button"
                              className="automation-action-btn"
                              onClick={() => openEditDrawer(acc)}
                              title={t("emailSettings.accountsTab.actionEditTitle")}
                            >
                              {t("emailSettings.accountsTab.actionEdit")}
                            </button>
                            <button
                              type="button"
                              className="automation-action-btn danger"
                              onClick={() => deleteAccount(acc.id)}
                              title={t("emailSettings.accountsTab.actionDeleteTitle")}
                            >
                              {t("emailSettings.accountsTab.actionDelete")}
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
      )}

      {/* RULES TAB */}
      {activeTab === "rules" && (
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
      )}

      {/* TEMPLATES TAB */}
      {activeTab === "templates" && (
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
      )}

      {/* CONTACTS & VIP TAB */}
      {activeTab === "contacts" && (
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
                            const updated = await api<{ contact: ContactItem }>(`/companies/${selectedCompanyId}/email-inbox/contacts/${encodeURIComponent(contact.email)}`, {
                              method: "PATCH",
                              body: JSON.stringify({ isVip: !contact.isVip }),
                            });
                            setContacts((prev) => prev.map((c) => (c.id === contact.id ? updated.contact : c)));
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
        <div className="automations-table-container">
          <div style={{ padding: "20px", borderBottom: "1px solid #f1f5f9" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>{t("emailSettings.permissionsTab.scopedAccessTitle")}</h3>
            <p style={{ margin: "0 0 18px", color: "#64748b", fontSize: 12 }}>
              {t("emailSettings.permissionsTab.scopedAccessDesc")}
            </p>
            <form onSubmit={createPermissionKey} style={{ display: "grid", gap: 14 }}>
              <label style={{ display: "grid", gap: 6, maxWidth: 460 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{t("emailSettings.permissionsTab.profileNameLabel")}</span>
                <input value={permissionKeyName} onChange={(event) => setPermissionKeyName(event.target.value)} required maxLength={120} />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 8 }}>
                {EMAIL_PERMISSION_OPTIONS.map(([scope]) => (
                  <label key={scope} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={selectedEmailPermissions.includes(scope)}
                      onChange={(event) => setSelectedEmailPermissions((current) => event.target.checked
                        ? [...current, scope]
                        : current.filter((permission) => permission !== scope))}
                    />
                    <span>{getPermissionLabel(scope)} <code style={{ color: "#64748b" }}>{scope}</code></span>
                  </label>
                ))}
              </div>
              <div>
                <button className="button-primary" disabled={savingPermissionKey || selectedEmailPermissions.length === 0}>
                  {savingPermissionKey ? t("emailSettings.permissionsTab.creatingKeyBtn") : t("emailSettings.permissionsTab.createKeyBtn")}
                </button>
              </div>
            </form>
            {createdPermissionToken && (
              <div className="workspace-notice" style={{ marginTop: 16 }}>
                {t("emailSettings.permissionsTab.tokenNotice")} <code style={{ wordBreak: "break-all" }}>{createdPermissionToken}</code>
              </div>
            )}
          </div>
          <table className="automations-table">
            <thead>
              <tr>
                <th>{t("emailSettings.permissionsTab.colName")}</th>
                <th>{t("emailSettings.permissionsTab.colGranted")}</th>
                <th>{t("emailSettings.permissionsTab.colLastUsed")}</th>
                <th style={{ textAlign: "right" }}>{t("emailSettings.permissionsTab.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {permissionKeys.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: "center", padding: 36, color: "#64748b" }}>{t("emailSettings.permissionsTab.empty")}</td></tr>
              ) : permissionKeys.map((key) => (
                <tr key={key.id}>
                  <td><strong>{key.name}</strong><div><code>{key.keyPrefix}…</code></div></td>
                  <td>{key.scopes.map((scope) => <span key={scope} className="record-status" style={{ margin: "2px 4px 2px 0" }}>{scope.replace("email:", "")}</span>)}</td>
                  <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString(language === "uk" ? "uk-UA" : language) : t("emailSettings.permissionsTab.neverUsed")}</td>
                  <td style={{ textAlign: "right" }}><button type="button" className="automation-action-btn" onClick={() => void revokePermissionKey(key.id)}>{t("emailSettings.permissionsTab.actionRevoke")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )
      )}

      {/* ADD / EDIT ACCOUNT DRAWER */}
      {drawerOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>{t("emailSettings.accountDrawer.kicker")}</span>
                <h2>{editingId ? t("emailSettings.accountDrawer.editTitle") : t("emailSettings.accountDrawer.newTitle")}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label={t("common.close")}
                onClick={() => setDrawerOpen(false)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <form onSubmit={saveAccount} noValidate>
              {accountFormError && (
                <div className="workspace-notice" role="alert" style={{ margin: "0 20px 12px", borderColor: "#dc2626", color: "#991b1b" }}>
                  <strong>{t("emailSettings.accountDrawer.alertNotSaved")}</strong> {accountFormError}
                </div>
              )}
              <section>
                <h3>{t("emailSettings.accountDrawer.sectionAssignment")}</h3>
                <p style={{ margin: "-4px 0 12px", color: "#64748b", fontSize: 12 }}>
                  {t("emailSettings.accountDrawer.requiredNotice")}
                </p>
                <label>
                  <span>{t("emailSettings.accountDrawer.mailboxOwnerLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                  <select value={selectedCompanyId} onChange={(e) => { const companyId = e.target.value; setSelectedCompanyId(companyId); writeActiveCompanyId(companyId === "personal" ? "" : companyId); setAgentId(""); setRuleAgentId(""); setRuleWorkflowId(""); setRuleCreateTask(false); }}>
                    <option value="personal">{t("emailSettings.scope.personalScope")}</option>
                    {companies.map((company) => <option key={company.id} value={company.id}>{t("emailSettings.scope.companyScopePrefix")}{company.name}</option>)}
                  </select>
                  <small style={{ color: "#64748b" }}>{t("emailSettings.accountDrawer.mailboxOwnerHint")}</small>
                </label>
                <label>
                  <span>{t("emailSettings.accountDrawer.emailAddressLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                  <input
                    type="email"
                    placeholder={t("emailSettings.accountDrawer.emailAddressPlaceholder")}
                    value={emailAddress}
                    data-email-field="emailAddress"
                    aria-invalid={Boolean(accountFieldErrors.emailAddress)}
                    style={accountFieldErrors.emailAddress ? { borderColor: "#dc2626" } : undefined}
                    onChange={(e) => { setEmailAddress(e.target.value); setAccountFieldErrors((current) => ({ ...current, emailAddress: "" })); }}
                  />
                  {accountFieldErrors.emailAddress && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.emailAddress}</small>}
                </label>
                <label>
                  <span>{t("emailSettings.accountDrawer.displayNameLabel")} <small>{t("emailSettings.accountDrawer.optionalSuffix")}</small></span>
                  <input
                    placeholder={t("emailSettings.accountDrawer.displayNamePlaceholder")}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("emailSettings.accountDrawer.assignedAgentLabel")} <small>{t("emailSettings.accountDrawer.optionalSuffix")}</small></span>
                  <select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={selectedCompanyId === "personal"}>
                    <option value="">{t("emailSettings.accountDrawer.unassignedOption")}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.role})
                      </option>
                    ))}
                  </select>
                  <small style={{ color: "#64748b" }}>{selectedCompanyId === "personal" ? t("emailSettings.accountDrawer.agentPersonalHint") : t("emailSettings.accountDrawer.agentCompanyHint")}</small>
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.accountDrawer.sectionMode")}</h3>
                <label>
                  <span>{t("emailSettings.accountDrawer.autoLevelLabel")}</span>
                  <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
                    <option value="approval">{t("emailSettings.accountDrawer.modeApproval")}</option>
                    <option value="autopilot">{t("emailSettings.accountDrawer.modeAutopilot")}</option>
                    <option value="manual">{t("emailSettings.accountDrawer.modeManual")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("emailSettings.accountDrawer.thresholdLabel").replace("{{percent}}", String(Math.round(confidenceThreshold * 100)))}</span>
                  <input
                    type="range"
                    min="0.5"
                    max="0.95"
                    step="0.05"
                    value={confidenceThreshold}
                    onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
                  />
                  <small style={{ color: "#64748b", fontSize: "11.5px" }}>
                    {t("emailSettings.accountDrawer.thresholdHint")}
                  </small>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={testMode}
                    onChange={(e) => setTestMode(e.target.checked)}
                  />
                  <span>{t("emailSettings.accountDrawer.testModeLabel")}</span>
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.accountDrawer.sectionImap")}</h3>
                <p style={{ margin: "-4px 0 12px", color: "#64748b", fontSize: 12 }}>{t("emailSettings.accountDrawer.imapDesc")}</p>
                <label>
                  <span>{t("emailSettings.accountDrawer.authLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                  <select value={mailAuthType} onChange={(e) => setMailAuthType(e.target.value as "password" | "oauth2")}>
                    <option value="password">{t("emailSettings.accountDrawer.authPassword")}</option>
                    <option value="oauth2">{t("emailSettings.accountDrawer.authOAuth")}</option>
                  </select>
                </label>
                {mailAuthType === "oauth2" && (
                  <>
                    {accountFieldErrors.oauth && <small role="alert" data-email-field="oauth" tabIndex={-1} style={{ color: "#dc2626" }}>{accountFieldErrors.oauth}</small>}
                    <label><span>{t("emailSettings.accountDrawer.oauthAccessTokenLabel")}</span><input type="password" placeholder={editingId ? t("emailSettings.accountDrawer.oauthAccessTokenPlaceholderKeep") : t("emailSettings.accountDrawer.oauthAccessTokenPlaceholderNew")} value={oauthAccessToken} onChange={(e) => setOauthAccessToken(e.target.value)} /></label>
                    <label><span>{t("emailSettings.accountDrawer.oauthRefreshTokenLabel")}</span><input type="password" placeholder={editingId ? t("emailSettings.accountDrawer.oauthRefreshTokenPlaceholderKeep") : t("emailSettings.accountDrawer.oauthRefreshTokenPlaceholderNew")} value={oauthRefreshToken} onChange={(e) => setOauthRefreshToken(e.target.value)} /></label>
                    <label><span>{t("emailSettings.accountDrawer.oauthTokenEndpointLabel")}</span><input placeholder="https://oauth2.googleapis.com/token" value={oauthTokenUrl} onChange={(e) => setOauthTokenUrl(e.target.value)} /></label>
                    <label><span>{t("emailSettings.accountDrawer.oauthAuthEndpointLabel")}</span><input placeholder="https://accounts.google.com/o/oauth2/v2/auth" value={oauthAuthorizationUrl} onChange={(e) => setOauthAuthorizationUrl(e.target.value)} /></label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <label><span>{t("emailSettings.accountDrawer.oauthClientIdLabel")}</span><input value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} /></label>
                      <label><span>{t("emailSettings.accountDrawer.oauthClientSecretLabel")}</span><input type="password" placeholder={editingId ? t("emailSettings.accountDrawer.oauthClientSecretPlaceholderKeep") : t("emailSettings.accountDrawer.oauthClientSecretPlaceholderNew")} value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} /></label>
                    </div>
                    <label><span>{t("emailSettings.accountDrawer.oauthScopesLabel")}</span><input placeholder="openid email https://mail.google.com/" value={oauthScopes} onChange={(e) => setOauthScopes(e.target.value)} /></label>
                    <label><span>{t("emailSettings.accountDrawer.oauthRedirectUriLabel")}</span><input value={oauthRedirectUri} onChange={(e) => setOauthRedirectUri(e.target.value)} /></label>
                    <button type="button" className="button-secondary" disabled={!editingId || !oauthAuthorizationUrl || !oauthTokenUrl || !oauthClientId} onClick={() => void startOAuthAuthorization()}>
                      {t("emailSettings.accountDrawer.connectOAuthBtn")}
                    </button>
                  </>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
                  <label>
                    <span>{t("emailSettings.accountDrawer.hostLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      placeholder="imap.company.com"
                      value={imapHost}
                      data-email-field="imapHost"
                      aria-invalid={Boolean(accountFieldErrors.imapHost)}
                      style={accountFieldErrors.imapHost ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setImapHost(e.target.value); setAccountFieldErrors((current) => ({ ...current, imapHost: "" })); }}
                    />
                    {accountFieldErrors.imapHost && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.imapHost}</small>}
                  </label>
                  <label>
                    <span>{t("emailSettings.accountDrawer.portLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      type="number"
                      placeholder="993"
                      value={imapPort}
                      data-email-field="imapPort"
                      aria-invalid={Boolean(accountFieldErrors.imapPort)}
                      style={accountFieldErrors.imapPort ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => setImapPort(parseInt(e.target.value, 10))}
                    />
                    {accountFieldErrors.imapPort && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.imapPort}</small>}
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label>
                    <span>{t("emailSettings.accountDrawer.usernameLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      placeholder="support@company.com"
                      value={imapUser}
                      data-email-field="imapUser"
                      aria-invalid={Boolean(accountFieldErrors.imapUser)}
                      style={accountFieldErrors.imapUser ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setImapUser(e.target.value); setAccountFieldErrors((current) => ({ ...current, imapUser: "" })); }}
                    />
                    {accountFieldErrors.imapUser && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.imapUser}</small>}
                  </label>
                  {mailAuthType === "password" && <label>
                    <span>{t("emailSettings.accountDrawer.passwordLabel")} {!editingId && <strong style={{ color: "#dc2626" }}>*</strong>}</span>
                    <input
                      type="password"
                      placeholder="••••••••••••"
                      value={imapPass}
                      data-email-field="imapPass"
                      aria-invalid={Boolean(accountFieldErrors.imapPass)}
                      style={accountFieldErrors.imapPass ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setImapPass(e.target.value); setAccountFieldErrors((current) => ({ ...current, imapPass: "" })); }}
                    />
                    {editingId && <small style={{ color: "#64748b" }}>{t("emailSettings.accountDrawer.passwordKeepHint")}</small>}
                    {accountFieldErrors.imapPass && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.imapPass}</small>}
                  </label>}
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={imapSecure} onChange={(e) => setImapSecure(e.target.checked)} />
                  <span>{t("emailSettings.accountDrawer.secureLabel")}</span>
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.accountDrawer.sectionSmtp")}</h3>
                <p style={{ margin: "-4px 0 12px", color: "#64748b", fontSize: 12 }}>{t("emailSettings.accountDrawer.smtpDesc")}</p>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
                  <label>
                    <span>{t("emailSettings.accountDrawer.smtpHostLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      placeholder="smtp.company.com"
                      value={smtpHost}
                      data-email-field="smtpHost"
                      aria-invalid={Boolean(accountFieldErrors.smtpHost)}
                      style={accountFieldErrors.smtpHost ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setSmtpHost(e.target.value); setAccountFieldErrors((current) => ({ ...current, smtpHost: "" })); }}
                    />
                    {accountFieldErrors.smtpHost && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.smtpHost}</small>}
                  </label>
                  <label>
                    <span>{t("emailSettings.accountDrawer.smtpPortLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      type="number"
                      placeholder="465"
                      value={smtpPort}
                      data-email-field="smtpPort"
                      aria-invalid={Boolean(accountFieldErrors.smtpPort)}
                      style={accountFieldErrors.smtpPort ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => setSmtpPort(parseInt(e.target.value, 10))}
                    />
                    {accountFieldErrors.smtpPort && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.smtpPort}</small>}
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label>
                    <span>{t("emailSettings.accountDrawer.smtpUserLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      placeholder="support@company.com"
                      value={smtpUser}
                      data-email-field="smtpUser"
                      aria-invalid={Boolean(accountFieldErrors.smtpUser)}
                      style={accountFieldErrors.smtpUser ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setSmtpUser(e.target.value); setAccountFieldErrors((current) => ({ ...current, smtpUser: "" })); }}
                    />
                    {accountFieldErrors.smtpUser && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.smtpUser}</small>}
                  </label>
                  {mailAuthType === "password" && <label>
                    <span>{t("emailSettings.accountDrawer.smtpPassLabel")} {!editingId && <strong style={{ color: "#dc2626" }}>*</strong>}</span>
                    <input
                      type="password"
                      placeholder="••••••••••••"
                      value={smtpPass}
                      data-email-field="smtpPass"
                      aria-invalid={Boolean(accountFieldErrors.smtpPass)}
                      style={accountFieldErrors.smtpPass ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setSmtpPass(e.target.value); setAccountFieldErrors((current) => ({ ...current, smtpPass: "" })); }}
                    />
                    {editingId && <small style={{ color: "#64748b" }}>{t("emailSettings.accountDrawer.passwordKeepHint")}</small>}
                    {accountFieldErrors.smtpPass && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.smtpPass}</small>}
                  </label>}
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
                  <span>{t("emailSettings.accountDrawer.smtpSecureLabel")}</span>
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.accountDrawer.sectionSafety")}</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                  <label><span>{t("emailSettings.accountDrawer.emailsPerHour")}</span><input type="number" min="1" value={maxPerHour} onChange={(e) => setMaxPerHour(Number(e.target.value))} /></label>
                  <label><span>{t("emailSettings.accountDrawer.emailsPerDay")}</span><input type="number" min="1" value={maxPerDay} onChange={(e) => setMaxPerDay(Number(e.target.value))} /></label>
                  <label><span>{t("emailSettings.accountDrawer.perRecipientDaily")}</span><input type="number" min="1" value={maxPerRecipientDaily} onChange={(e) => setMaxPerRecipientDaily(Number(e.target.value))} /></label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label><span>{selectedCompanyId === "personal" ? t("emailSettings.accountDrawer.personalPerHour") : t("emailSettings.accountDrawer.companyPerHour")}</span><input type="number" min="1" value={maxCompanyPerHour} onChange={(e) => setMaxCompanyPerHour(Number(e.target.value))} /></label>
                  <label><span>{selectedCompanyId === "personal" ? t("emailSettings.accountDrawer.personalPerDay") : t("emailSettings.accountDrawer.companyPerDay")}</span><input type="number" min="1" value={maxCompanyPerDay} onChange={(e) => setMaxCompanyPerDay(Number(e.target.value))} /></label>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={followupEnabled} onChange={(e) => setFollowupEnabled(e.target.checked)} />
                  <span>{t("emailSettings.accountDrawer.enableFollowup")}</span>
                </label>
                {followupEnabled && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  <label><span>{t("emailSettings.accountDrawer.delayDays")}</span><input type="number" min="1" value={followupDelayDays} onChange={(e) => setFollowupDelayDays(Number(e.target.value))} /></label>
                  <label><span>{t("emailSettings.accountDrawer.maximum")}</span><input type="number" min="1" value={followupMax} onChange={(e) => setFollowupMax(Number(e.target.value))} /></label>
                  <label><span>{t("emailSettings.accountDrawer.action")}</span><select value={followupAction} onChange={(e) => setFollowupAction(e.target.value as any)}><option value="draft">{t("emailSettings.accountDrawer.actionDraft")}</option><option value="auto_send">{t("emailSettings.accountDrawer.actionAutoSend")}</option><option value="create_task">{t("emailSettings.accountDrawer.actionCreateTask")}</option><option value="notify_user">{t("emailSettings.accountDrawer.actionNotifyUser")}</option></select></label>
                </div>}
              </section>

              <section>
                <h3>{t("emailSettings.accountDrawer.sectionSignatures")}</h3>
                <label>
                  <span>{t("emailSettings.accountDrawer.greetingLabel")}</span>
                  <input
                    placeholder={t("emailSettings.accountDrawer.greetingPlaceholder")}
                    value={greeting}
                    onChange={(e) => setGreeting(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("emailSettings.accountDrawer.signatureLabel")}</span>
                  <textarea
                    rows={3}
                    placeholder={t("emailSettings.accountDrawer.signaturePlaceholder")}
                    value={signature}
                    onChange={(e) => setSignature(e.target.value)}
                  />
                </label>
              </section>

              <footer style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setDrawerOpen(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary"
                  disabled={saving}
                >
                  {saving ? t("emailSettings.accountDrawer.saving") : editingId ? t("emailSettings.accountDrawer.saveChanges") : t("emailSettings.accountDrawer.connectAccount")}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {/* ADD / EDIT ROUTING RULE DRAWER */}
      {ruleDrawerOpen && (
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
      )}

      {/* ADD / EDIT RESPONSE TEMPLATE DRAWER */}
      {templateDrawerOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setTemplateDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>{t("emailSettings.templateDrawer.kicker")}</span>
                <h2>{editingTemplateId ? t("emailSettings.templateDrawer.editTitle") : t("emailSettings.templateDrawer.newTitle")}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label={t("common.close")}
                onClick={() => setTemplateDrawerOpen(false)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <form onSubmit={handleSaveTemplate}>
              <section>
                <h3>{t("emailSettings.templateDrawer.templateDetails")}</h3>
                <label>
                  <span>{t("emailSettings.templateDrawer.titleLabel")}</span>
                  <input
                    required
                    placeholder={t("emailSettings.templateDrawer.titlePlaceholder")}
                    value={templateTitle}
                    onChange={(e) => setTemplateTitle(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("emailSettings.templateDrawer.categoryLabel")}</span>
                  <select value={templateCategory} onChange={(e) => setTemplateCategory(e.target.value)}>
                    <option value="general">{t("emailSettings.templateDrawer.categories.general")}</option>
                    <option value="support">{t("emailSettings.templateDrawer.categories.support")}</option>
                    <option value="billing">{t("emailSettings.templateDrawer.categories.billing")}</option>
                    <option value="sales">{t("emailSettings.templateDrawer.categories.sales")}</option>
                    <option value="information">{t("emailSettings.templateDrawer.categories.information")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("emailSettings.templateDrawer.subjectLabel")}</span>
                  <input
                    placeholder={t("emailSettings.templateDrawer.subjectPlaceholder")}
                    value={templateSubject}
                    onChange={(e) => setTemplateSubject(e.target.value)}
                  />
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.templateDrawer.bodyDetails")}</h3>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: "#64748b", alignSelf: "center", marginRight: 4 }}>{t("emailSettings.templateDrawer.insertVariable")}</span>
                  {["{{customer_name}}", "{{company_name}}", "{{agent_name}}", "{{date}}"].map((v) => (
                    <button
                      key={v}
                      type="button"
                      className="automation-cron-pill"
                      style={{ cursor: "pointer", background: "#f1f5f9" }}
                      onClick={() => setTemplateBody((prev) => prev + " " + v)}
                    >
                      + {v}
                    </button>
                  ))}
                </div>
                <label>
                  <span>{t("emailSettings.templateDrawer.bodyLabel")}</span>
                  <textarea
                    required
                    rows={6}
                    placeholder={t("emailSettings.templateDrawer.bodyPlaceholder")}
                    value={templateBody}
                    onChange={(e) => setTemplateBody(e.target.value)}
                  />
                </label>
              </section>

              <footer style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setTemplateDrawerOpen(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary"
                  disabled={savingTemplate}
                >
                  {savingTemplate ? t("emailSettings.templateDrawer.savingTemplate") : editingTemplateId ? t("emailSettings.templateDrawer.saveTemplate") : t("emailSettings.templateDrawer.createTemplate")}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {/* ADD / EDIT CONTACT DRAWER */}
      {contactDrawerOpen && (
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
      )}

      {/* DNS AUDIT DRAWER */}
      {dnsDrawerOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setDnsDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>{t("emailSettings.dnsDrawer.kicker")}</span>
                <h2>{t("emailSettings.dnsDrawer.titleAudit").replace("{{domain}}", dnsAccount?.emailAddress.split("@")[1] || "Domain")}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label={t("common.close")}
                onClick={() => setDnsDrawerOpen(false)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <div style={{ padding: "20px 24px" }}>
              {dnsChecking ? (
                <div style={{ textAlign: "center", padding: "40px" }}>
                  <p>{t("emailSettings.dnsDrawer.queryingDns")}</p>
                </div>
              ) : dnsResult ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div
                    style={{
                    padding: "14px 16px",
                    borderRadius: "10px",
                    background: dnsResult.verified ? "#ecfdf5" : "#fffbeb",
                    border: `1px solid ${dnsResult.verified ? "#a7f3d0" : "#fde68a"}`,
                    color: dnsResult.verified ? "#065f46" : "#92400e",
                    fontSize: "13px",
                    lineHeight: 1.5,
                  }}
                  >
                    <strong>{dnsResult.verified ? t("emailSettings.dnsDrawer.domainVerified") : t("emailSettings.dnsDrawer.actionRecommended")}</strong>
                    <div>{dnsResult.summary}</div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {dnsResult.records.map((rec) => (
                      <div
                        key={rec.recordType}
                        style={{
                          padding: "14px 16px",
                          borderRadius: "10px",
                          border: "1px solid #e2e8f0",
                          background: "#ffffff",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                          <span style={{ fontWeight: 700, fontSize: "14px" }}>{t("emailSettings.dnsDrawer.recordHeading").replace("{{recordType}}", rec.recordType).replace("{{name}}", rec.name)}</span>
                          <span
                            className={`automation-status-btn ${rec.valid ? "active" : "paused"}`}
                            style={{ cursor: "default" }}
                          >
                            <span className="automation-status-dot" />
                            {rec.valid ? t("emailSettings.dnsDrawer.statusValid") : rec.found ? t("emailSettings.dnsDrawer.statusInvalid") : t("emailSettings.dnsDrawer.statusMissing")}
                          </span>
                        </div>

                        {rec.currentValue && (
                          <div style={{ fontSize: "12px", color: "#475569", marginBottom: 4, fontFamily: "monospace" }}>
                            {t("emailSettings.dnsDrawer.currentValue").replace("{{value}}", rec.currentValue)}
                          </div>
                        )}

                        {rec.recommendation && (
                          <div style={{ fontSize: "12px", color: "#b45309", background: "#fef3c7", padding: "6px 10px", borderRadius: "6px", marginTop: 6 }}>
                            💡 <strong>{t("emailSettings.dnsDrawer.recommendation")}</strong> {rec.recommendation}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p>{t("emailSettings.dnsDrawer.noResult")}</p>
              )}
            </div>

            <footer style={{ padding: "16px 24px", borderTop: "1px solid #f1f5f9", display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="button-primary automations-action-primary"
                onClick={() => setDnsDrawerOpen(false)}
              >
                {t("emailSettings.dnsDrawer.closeAudit")}
              </button>
            </footer>
          </aside>
        </div>
      )}
    </main>
  );
}
