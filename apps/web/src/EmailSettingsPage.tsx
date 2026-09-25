import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useWorkspace } from "./BusinessWorkspace";
import { confirmModal } from "./ConfirmDialog";

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
  const { overview } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
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
        const requested = searchParams.get("company");
        const selected = requested === "personal" || (requested && res.companies.some((c) => c.id === requested))
          ? requested
          : "personal";
        setSelectedCompanyId(selected);
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
      setNotice("Scoped integration keys require a Company. Your signed-in user permissions protect the personal mailbox.");
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
    if (!selectedCompanyId || !await confirmModal({ title: "Revoke email access?", message: "This integration key will stop working immediately.", confirmText: "Revoke", isDanger: true })) return;
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) errors.emailAddress = "Enter a valid email address.";
    if (!imapHost.trim()) errors.imapHost = "IMAP host is required for receiving mail.";
    if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) errors.imapPort = "Enter a valid IMAP port (1–65535).";
    if (!imapUser.trim()) errors.imapUser = "IMAP username is required.";
    if (!smtpHost.trim()) errors.smtpHost = "SMTP host is required for sending mail.";
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) errors.smtpPort = "Enter a valid SMTP port (1–65535).";
    if (!smtpUser.trim()) errors.smtpUser = "SMTP username is required.";
    if (mailAuthType === "password" && !editingId && !imapPass) errors.imapPass = "IMAP password is required.";
    if (mailAuthType === "password" && !editingId && !smtpPass) errors.smtpPass = "SMTP password is required.";
    if (mailAuthType === "oauth2" && !editingId && !oauthAccessToken && (!oauthAuthorizationUrl || !oauthTokenUrl || !oauthClientId)) {
      errors.oauth = "Provide an access token, or the authorization endpoint, token endpoint, and client ID.";
    }
    const duplicate = accounts.find((account) => account.id !== editingId && account.emailAddress.trim().toLowerCase() === normalizedEmail);
    if (duplicate) errors.emailAddress = "This email address is already connected. Edit the existing account instead.";
    if (Object.keys(errors).length) {
      setAccountFieldErrors(errors);
      setAccountFormError("Please correct the highlighted required fields before saving.");
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
      title: "Delete Email Account",
      message: "Are you sure you want to delete this email account?",
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
      setNotice("Save the email account first, then edit it to start OAuth authorization.");
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
      setNotice("OAuth authorization opened. After completing it, run Test Connection.");
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
          ? "IMAP & SMTP connections verified successfully!"
          : res.result.error || "Connection failed. Check host credentials.",
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
      setNotice("Rule name is required.");
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
      title: "Delete Routing Rule",
      message: "Are you sure you want to delete this email rule?",
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

  function openEditTemplateDrawer(t: EmailTemplate) {
    setEditingTemplateId(t.id);
    setTemplateTitle(t.title);
    setTemplateCategory(t.category);
    setTemplateSubject(t.subjectTemplate || "");
    setTemplateBody(t.bodyTemplate);
    setTemplateDrawerOpen(true);
  }

  async function handleSaveTemplate(e: FormEvent) {
    e.preventDefault();
    if (!templateTitle.trim() || !templateBody.trim()) {
      setNotice("Title and body template are required.");
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
        setTemplates((prev) => prev.map((t) => (t.id === editingTemplateId ? res.template : t)));
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
      title: "Delete Response Template",
      message: "Are you sure you want to delete this email template?",
      isDanger: true,
    });
    if (!ok) return;
    try {
      await api(`/companies/${selectedCompanyId}/email-inbox/templates/${id}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((t) => t.id !== id));
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
      setNotice("A valid email address is required.");
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

  return (
    <main className="goals-container automations-container">
      {/* Hero Header matching /settings/automations and /settings/activity */}
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">Settings · Email & AI Inbox</p>
            <h1>
              <Link to="/settings" className="marketplace-back-button" aria-label="Back to settings" title="Back to settings">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>Email Accounts & AI Automation</span>
            </h1>
            <p className="hero-copy">
              Connect corporate email addresses, verify DNS records (MX, SPF, DKIM, DMARC), and configure autonomous AI inbox agents.
            </p>
          </div>
          <div className="automations-header-actions">
            <Link
              to={`/settings/email/inbox?company=${encodeURIComponent(selectedCompanyId)}`}
              className="button-secondary automations-action-primary"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              Open AI Inbox →
            </Link>
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={openCreateDrawer}
              title="Add an email address to the selected personal or Company scope"
            >
              + Add Email Address
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
              <span>Mailbox Scope:</span>
            </span>

            <div className="email-scope-select-wrap">
              <select
                aria-label="Select mailbox owner"
                value={selectedCompanyId}
                onChange={(e) => {
                  setSelectedCompanyId(e.target.value);
                setAgentId("");
                setRuleAgentId("");
                setRuleWorkflowId("");
                setRuleCreateTask(false);
                  setSearchParams({ company: e.target.value }, { replace: true });
                }}
                className="email-scope-select"
              >
                <option value="personal">Personal / No Company</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    Company: {c.name}
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
              ? "Personal mailboxes & individual routing"
              : `Company mailboxes for ${companies.find((c) => c.id === selectedCompanyId)?.name || "selected organization"}`}
          </span>
        </div>

        <div className="email-scope-right">
          <Link
            to={`/settings/email/inbox?company=${encodeURIComponent(selectedCompanyId)}&compose=1`}
            className="email-compose-btn"
            title={accounts.length ? "Write and send a new email" : "Add an email address, then compose a message"}
            aria-disabled={accounts.length === 0}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span>+ Compose Email</span>
          </Link>
        </div>
      </div>

      {/* 4 Stat Overview Cards matching /settings/activity and /settings/capabilities */}
      <section className="overview-grid inspector-stats-grid automations-stats-grid">
        <div>
          <strong>{analytics?.receivedEmails ?? 0}</strong>
          <span>Total Received</span>
          <small>Inbound emails processed</small>
        </div>
        <div>
          <strong>{analytics?.sentEmails ?? 0}</strong>
          <span>Total Sent</span>
          <small>Dispatched via SMTP & AI</small>
        </div>
        <div>
          <strong>{Math.round(analytics?.automationRate ?? 0)}%</strong>
          <span>AI Automation Rate</span>
          <small>Autonomously handled</small>
        </div>
        <div>
          <strong>{analytics?.draftedByAi ?? 0}</strong>
          <span>Drafts Prepared</span>
          <small>Awaiting human review</small>
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
                <h3>AI Inbox Analytics & Delivery Performance</h3>
                <p>Breakdown of automated vs. human responses, delivery health, response speed, and volume</p>
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
                    <span>Hide Details</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 15l-6-6-6 6" /></svg>
                  </>
                ) : (
                  <>
                    <span>Show Details</span>
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
                    <span>Handling & Resolution</span>
                  </div>
                  <div className="email-metric-items-list">
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-blue" />
                        <span className="email-metric-label">AI Answered</span>
                      </div>
                      <strong className="email-metric-val">{analytics.aiAnswered}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-indigo" />
                        <span className="email-metric-label">Human Answered</span>
                      </div>
                      <strong className="email-metric-val">{analytics.humanAnswered}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-emerald" />
                        <span className="email-metric-label">Approved by Human</span>
                      </div>
                      <strong className="email-metric-val">{analytics.approvedByHuman}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-amber" />
                        <span className="email-metric-label">Escalated to Human</span>
                      </div>
                      <strong className="email-metric-val">{analytics.escalatedToHuman}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-purple" />
                        <span className="email-metric-label">Edited AI Responses</span>
                      </div>
                      <strong className="email-metric-val">{analytics.editedAiResponsesCount}</strong>
                    </div>
                  </div>
                </div>

                {/* Category 2: Speed & Delivery Health */}
                <div className="email-metric-category-card">
                  <div className="email-metric-category-title">
                    <span className="email-cat-icon">⚡</span>
                    <span>Speed & Deliverability</span>
                  </div>
                  <div className="email-metric-items-list">
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-cyan" />
                        <span className="email-metric-label">Avg. Response</span>
                      </div>
                      <strong className="email-metric-val">{analytics.averageResponseTimeMinutes} min</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-teal" />
                        <span className="email-metric-label">Avg. First Response</span>
                      </div>
                      <strong className="email-metric-val">{analytics.averageFirstResponseTimeMinutes} min</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-rose" />
                        <span className="email-metric-label">Failed Deliveries</span>
                      </div>
                      <strong className={`email-metric-val ${analytics.failedEmails > 0 ? "val-danger" : ""}`}>
                        {analytics.failedEmails}
                      </strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-orange" />
                        <span className="email-metric-label">Bounced Emails</span>
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
                    <span>AI Confidence Level</span>
                  </div>
                  <div className="email-metric-items-list">
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-confidence-badge conf-high">High</span>
                        <span className="email-metric-label">High Confidence</span>
                      </div>
                      <strong className="email-metric-val">{analytics.confidenceDistribution.high}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-confidence-badge conf-med">Med</span>
                        <span className="email-metric-label">Medium Confidence</span>
                      </div>
                      <strong className="email-metric-val">{analytics.confidenceDistribution.medium}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-confidence-badge conf-low">Low</span>
                        <span className="email-metric-label">Low Confidence</span>
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
                      <h4>Email Volume by Day</h4>
                    </div>
                    <span className="email-volume-count-badge">{analytics.volumeByDay.length} days</span>
                  </div>
                  {analytics.volumeByDay.length === 0 ? (
                    <div className="email-volume-empty">
                      <p>No email traffic recorded for this period</p>
                    </div>
                  ) : (
                    <div className="email-volume-table-wrap">
                      <table className="automations-table">
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th style={{ textAlign: "right" }}>Received</th>
                            <th style={{ textAlign: "right" }}>Sent</th>
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
                      <h4>Volume by Agent</h4>
                    </div>
                    <span className="email-volume-count-badge">{analytics.volumeByAgent.length} agents</span>
                  </div>
                  {analytics.volumeByAgent.length === 0 ? (
                    <div className="email-volume-empty">
                      <p>No agent responses recorded yet</p>
                    </div>
                  ) : (
                    <div className="email-volume-table-wrap">
                      <table className="automations-table">
                        <thead>
                          <tr>
                            <th>Agent</th>
                            <th style={{ textAlign: "right" }}>Messages</th>
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
                      <h4>Volume by Account</h4>
                    </div>
                    <span className="email-volume-count-badge">{analytics.volumeByAccount.length} accounts</span>
                  </div>
                  {analytics.volumeByAccount.length === 0 ? (
                    <div className="email-volume-empty">
                      <p>No account activity recorded yet</p>
                    </div>
                  ) : (
                    <div className="email-volume-table-wrap">
                      <table className="automations-table">
                        <thead>
                          <tr>
                            <th>Account</th>
                            <th style={{ textAlign: "right" }}>Messages</th>
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
            placeholder="Filter accounts by email address, display name, agent..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="inspector-search-input"
            aria-label="Filter email accounts"
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
              title="Clear search"
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
            <span>Email Accounts</span>
            <small className="tab-count">{accounts.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "rules"}
            className={`inspector-tab ${activeTab === "rules" ? "active" : ""}`}
            onClick={() => setActiveTab("rules")}
          >
            <span>Routing Rules</span>
            <small className="tab-count">{rules.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "templates"}
            className={`inspector-tab ${activeTab === "templates" ? "active" : ""}`}
            onClick={() => setActiveTab("templates")}
          >
            <span>Response Templates</span>
            <small className="tab-count">{templates.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "contacts"}
            className={`inspector-tab ${activeTab === "contacts" ? "active" : ""}`}
            onClick={() => setActiveTab("contacts")}
          >
            <span>Contacts & VIP</span>
            <small className="tab-count">{contacts.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "permissions"}
            className={`inspector-tab ${activeTab === "permissions" ? "active" : ""}`}
            onClick={() => setActiveTab("permissions")}
          >
            <span>Permissions</span>
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
                Showing <strong>{filteredAccounts.length}</strong> of <strong>{accounts.length}</strong> email accounts
              </span>
            </div>
          </div>

          {filteredAccounts.length === 0 && !loading ? (
            <div className="automations-empty-card">
              <div className="automations-empty-icon">✉️</div>
              <h3>No email addresses connected yet</h3>
              <p>Connect your domain email address (e.g. support@company.com) to allow AI agents to handle corporate email.</p>
              <button
                type="button"
                className="button-primary automations-action-primary"
                onClick={openCreateDrawer}
              >
                + Add Email Address
              </button>
            </div>
          ) : (
            <div className="automations-table-container">
              <table className="automations-table">
                <thead>
                  <tr>
                    <th style={{ minWidth: "220px" }}>Email Account</th>
                    <th style={{ minWidth: "160px" }}>Assigned Agent</th>
                    <th style={{ minWidth: "150px" }}>Operational Mode</th>
                    <th style={{ minWidth: "180px" }}>Connection & DNS</th>
                    <th style={{ width: "240px", textAlign: "right" }}>Actions</th>
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
                                Sandbox / Test Mode Active
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className="automation-agent-badge">
                            <span>🤖</span>
                            <span>{assigned ? assigned.name : "Unassigned"}</span>
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
                              {acc.mode} Mode
                            </span>
                            <span className="automation-next-run">
                              Threshold: {Math.round(acc.confidenceThreshold * 100)}%
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
                              {acc.status === "connected" ? "Connected" : acc.status.replace("_", " ")}
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
                              to={`/settings/email/inbox?company=${encodeURIComponent(selectedCompanyId)}&compose=1&account=${encodeURIComponent(acc.id)}`}
                              className="automation-action-btn"
                              title={`Compose from ${acc.emailAddress}`}
                            >
                              Compose
                            </Link>
                            <button
                              type="button"
                              className="automation-action-btn"
                              disabled={isTesting}
                              onClick={() => runConnectionTest(acc)}
                              title="Test IMAP & SMTP socket connection"
                            >
                              {isTesting ? "Testing..." : "Test Connection"}
                            </button>
                            <button
                              type="button"
                              className="automation-action-btn"
                              onClick={() => openDnsCheck(acc)}
                              title="Inspect MX, SPF, DKIM, and DMARC records"
                            >
                              Check DNS
                            </button>
                            <button
                              type="button"
                              className="automation-action-btn"
                              onClick={() => openEditDrawer(acc)}
                              title="Edit account credentials and mode"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="automation-action-btn danger"
                              onClick={() => deleteAccount(acc.id)}
                              title="Remove email account"
                            >
                              Delete
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
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>Email Routing Rules</h3>
              <small style={{ color: "#64748b" }}>Configure automated routing, priority overrides, and VIP filtering rules.</small>
            </div>
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={openCreateRuleDrawer}
            >
              + Add Rule
            </button>
          </div>
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ width: "220px" }}>Rule Name</th>
                <th>Conditions</th>
                <th>Actions</th>
                <th style={{ width: "100px", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: "40px", color: "#64748b" }}>
                    No custom rules configured yet. Default company routing rules apply.
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
                            Active
                          </span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          {kw.length > 0 && (
                            <span className="automation-cron-pill">
                              Keywords: {kw.join(", ")}
                            </span>
                          )}
                          {senders.length > 0 && (
                            <span className="automation-cron-pill">
                              Senders: {senders.join(", ")}
                            </span>
                          )}
                          {isVip && (
                            <span className="automation-cron-pill" style={{ color: "#b45309", background: "#fef3c7" }}>
                              ★ VIP Only
                            </span>
                          )}
                          {!kw.length && !senders.length && !isVip && (
                            <span style={{ color: "#64748b", fontSize: 12 }}>All inbound messages</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          {rule.actions?.setPriority && (
                            <span className="automation-agent-badge" style={{ textTransform: "capitalize" }}>
                              Priority: {rule.actions.setPriority}
                            </span>
                          )}
                          {rule.actions?.setMode && (
                            <span className="automation-agent-badge" style={{ textTransform: "capitalize" }}>
                              Mode: {rule.actions.setMode}
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
                            title="Edit rule"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="automation-action-btn danger"
                            onClick={() => handleDeleteRule(rule.id)}
                            title="Delete rule"
                          >
                            Delete
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
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>Response Templates & Canned Replies</h3>
              <small style={{ color: "#64748b" }}>Standard corporate templates with placeholder support ({`{{customer_name}}`}, {`{{company_name}}`}).</small>
            </div>
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={openCreateTemplateDrawer}
            >
              + Add Template
            </button>
          </div>
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ width: "240px" }}>Title</th>
                <th style={{ width: "160px" }}>Category</th>
                <th>Body Preview</th>
                <th style={{ width: "140px", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: "40px", color: "#64748b" }}>
                    No response templates saved yet.
                  </td>
                </tr>
              ) : (
                templates.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div className="automation-title-cell">
                        <strong>{t.title}</strong>
                        {t.subjectTemplate && (
                          <small style={{ color: "#64748b", fontSize: 11 }}>Re: {t.subjectTemplate}</small>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="automation-cron-pill" style={{ textTransform: "capitalize" }}>{t.category}</span>
                    </td>
                    <td>
                      <div className="automation-prompt-preview" style={{ maxWidth: "480px" }}>
                        {t.bodyTemplate}
                      </div>
                    </td>
                    <td>
                      <div className="automation-actions-cell">
                        <button
                          type="button"
                          className="automation-action-btn"
                          onClick={() => openEditTemplateDrawer(t)}
                          title="Edit template"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn danger"
                          onClick={() => handleDeleteTemplate(t.id)}
                          title="Delete template"
                        >
                          Delete
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
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>Client Contacts & VIP Directory</h3>
              <small style={{ color: "#64748b" }}>Manage VIP prioritization, delivery bounce tracking, and blacklisted senders.</small>
            </div>
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={() => openCreateContactDrawer(true)}
            >
              + Add Contact
            </button>
          </div>
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ minWidth: "220px" }}>Contact</th>
                <th style={{ minWidth: "140px" }}>VIP Status</th>
                <th style={{ minWidth: "140px" }}>Blacklisted</th>
                <th>Notes</th>
                <th style={{ width: "160px", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {contacts.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", padding: "40px", color: "#64748b" }}>
                    No contacts recorded yet. Contacts will be populated automatically as inbound emails arrive.
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
                        {contact.isVip ? "★ VIP Sender" : "Standard"}
                      </span>
                    </td>
                    <td>
                      <span className={`automation-status-btn ${contact.isBlacklisted ? "active" : "paused"}`} style={{ cursor: "default" }}>
                        <span className="automation-status-dot" />
                        {contact.isBlacklisted ? "Blacklisted" : "Allowed"}
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
                          title="Edit contact"
                        >
                          Edit
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
                          {contact.isVip ? "Un-VIP" : "Make VIP"}
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
            <h3>Personal mailbox access</h3>
            <p>Your personal mailbox is protected by your signed-in user permissions. Scoped integration keys are available only when a Company mailbox owner is selected.</p>
          </div>
        ) : (
        <div className="automations-table-container">
          <div style={{ padding: "20px", borderBottom: "1px solid #f1f5f9" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Scoped Email Access</h3>
            <p style={{ margin: "0 0 18px", color: "#64748b", fontSize: 12 }}>
              Create a restricted integration identity using the existing company permission system. Company admins retain full access; each key receives only the selected email permissions.
            </p>
            <form onSubmit={createPermissionKey} style={{ display: "grid", gap: 14 }}>
              <label style={{ display: "grid", gap: 6, maxWidth: 460 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>Access profile name</span>
                <input value={permissionKeyName} onChange={(event) => setPermissionKeyName(event.target.value)} required maxLength={120} />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 8 }}>
                {EMAIL_PERMISSION_OPTIONS.map(([scope, label]) => (
                  <label key={scope} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={selectedEmailPermissions.includes(scope)}
                      onChange={(event) => setSelectedEmailPermissions((current) => event.target.checked
                        ? [...current, scope]
                        : current.filter((permission) => permission !== scope))}
                    />
                    <span>{label} <code style={{ color: "#64748b" }}>{scope}</code></span>
                  </label>
                ))}
              </div>
              <div>
                <button className="button-primary" disabled={savingPermissionKey || selectedEmailPermissions.length === 0}>
                  {savingPermissionKey ? "Creating…" : "Create scoped access key"}
                </button>
              </div>
            </form>
            {createdPermissionToken && (
              <div className="workspace-notice" style={{ marginTop: 16 }}>
                Copy this token now; it will not be shown again: <code style={{ wordBreak: "break-all" }}>{createdPermissionToken}</code>
              </div>
            )}
          </div>
          <table className="automations-table">
            <thead><tr><th>Name</th><th>Granted email permissions</th><th>Last used</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
            <tbody>
              {permissionKeys.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: "center", padding: 36, color: "#64748b" }}>No scoped email access profiles yet.</td></tr>
              ) : permissionKeys.map((key) => (
                <tr key={key.id}>
                  <td><strong>{key.name}</strong><div><code>{key.keyPrefix}…</code></div></td>
                  <td>{key.scopes.map((scope) => <span key={scope} className="record-status" style={{ margin: "2px 4px 2px 0" }}>{scope.replace("email:", "")}</span>)}</td>
                  <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "Never"}</td>
                  <td style={{ textAlign: "right" }}><button type="button" className="automation-action-btn" onClick={() => void revokePermissionKey(key.id)}>Revoke</button></td>
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
                <span>Email Accounts</span>
                <h2>{editingId ? "Edit Email Account" : "Add Email Account"}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label="Close"
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
                  <strong>Account was not saved.</strong> {accountFormError}
                </div>
              )}
              <section>
                <h3>Account & Agent Assignment</h3>
                <p style={{ margin: "-4px 0 12px", color: "#64748b", fontSize: 12 }}>
                  Fields marked <strong style={{ color: "#dc2626" }}>*</strong> are required. Company and AI agent assignment are optional.
                </p>
                <label>
                  <span>Mailbox Owner <strong style={{ color: "#dc2626" }}>*</strong></span>
                  <select value={selectedCompanyId} onChange={(e) => { setSelectedCompanyId(e.target.value); setAgentId(""); setRuleAgentId(""); setRuleWorkflowId(""); setRuleCreateTask(false); }}>
                    <option value="personal">Personal / No Company</option>
                    {companies.map((company) => <option key={company.id} value={company.id}>Company: {company.name}</option>)}
                  </select>
                  <small style={{ color: "#64748b" }}>Choose Personal to use email without creating or assigning a Company.</small>
                </label>
                <label>
                  <span>Email Address <strong style={{ color: "#dc2626" }}>*</strong></span>
                  <input
                    type="email"
                    placeholder="support@company.com"
                    value={emailAddress}
                    data-email-field="emailAddress"
                    aria-invalid={Boolean(accountFieldErrors.emailAddress)}
                    style={accountFieldErrors.emailAddress ? { borderColor: "#dc2626" } : undefined}
                    onChange={(e) => { setEmailAddress(e.target.value); setAccountFieldErrors((current) => ({ ...current, emailAddress: "" })); }}
                  />
                  {accountFieldErrors.emailAddress && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.emailAddress}</small>}
                </label>
                <label>
                  <span>Display Name / Sender Label <small>(optional)</small></span>
                  <input
                    placeholder="Customer Support Team"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </label>
                <label>
                  <span>Assigned Company Agent <small>(optional)</small></span>
                  <select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={selectedCompanyId === "personal"}>
                    <option value="">Unassigned / No Company Agent</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.role})
                      </option>
                    ))}
                  </select>
                  <small style={{ color: "#64748b" }}>{selectedCompanyId === "personal" ? "Personal mailboxes are not assigned to a Company agent." : "Leave unassigned to route and answer messages manually."}</small>
                </label>
              </section>

              <section>
                <h3>AI Operational Mode</h3>
                <label>
                  <span>Automation Level</span>
                  <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
                    <option value="approval">Approval Mode — AI drafts responses for human review</option>
                    <option value="autopilot">Autopilot Mode — AI sends responses autonomously when confident</option>
                    <option value="manual">Manual Mode — AI does not generate responses</option>
                  </select>
                </label>
                <label>
                  <span>Confidence Threshold ({Math.round(confidenceThreshold * 100)}%)</span>
                  <input
                    type="range"
                    min="0.5"
                    max="0.95"
                    step="0.05"
                    value={confidenceThreshold}
                    onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
                  />
                  <small style={{ color: "#64748b", fontSize: "11.5px" }}>
                    In Autopilot mode, responses with confidence below this threshold fall back to Approval mode.
                  </small>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={testMode}
                    onChange={(e) => setTestMode(e.target.checked)}
                  />
                  <span>Enable Sandbox Test Mode (captures emails without live SMTP dispatch)</span>
                </label>
              </section>

              <section>
                <h3>IMAP Connection (Inbound Mail)</h3>
                <p style={{ margin: "-4px 0 12px", color: "#64748b", fontSize: 12 }}>Required to receive and synchronize incoming messages.</p>
                <label>
                  <span>Authentication <strong style={{ color: "#dc2626" }}>*</strong></span>
                  <select value={mailAuthType} onChange={(e) => setMailAuthType(e.target.value as "password" | "oauth2")}>
                    <option value="password">Username and password</option>
                    <option value="oauth2">OAuth 2.0 / XOAUTH2 access token</option>
                  </select>
                </label>
                {mailAuthType === "oauth2" && (
                  <>
                    {accountFieldErrors.oauth && <small role="alert" data-email-field="oauth" tabIndex={-1} style={{ color: "#dc2626" }}>{accountFieldErrors.oauth}</small>}
                    <label><span>OAuth Access Token</span><input type="password" placeholder={editingId ? "Leave blank to keep the current token" : "Paste provider access token"} value={oauthAccessToken} onChange={(e) => setOauthAccessToken(e.target.value)} /></label>
                    <label><span>OAuth Refresh Token</span><input type="password" placeholder={editingId ? "Leave blank to keep the current token" : "Provider refresh token"} value={oauthRefreshToken} onChange={(e) => setOauthRefreshToken(e.target.value)} /></label>
                    <label><span>OAuth Token Endpoint</span><input placeholder="https://oauth2.googleapis.com/token" value={oauthTokenUrl} onChange={(e) => setOauthTokenUrl(e.target.value)} /></label>
                    <label><span>OAuth Authorization Endpoint</span><input placeholder="https://accounts.google.com/o/oauth2/v2/auth" value={oauthAuthorizationUrl} onChange={(e) => setOauthAuthorizationUrl(e.target.value)} /></label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <label><span>OAuth Client ID</span><input value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} /></label>
                      <label><span>OAuth Client Secret</span><input type="password" placeholder={editingId ? "Leave blank to keep it" : "Optional for PKCE/public clients"} value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} /></label>
                    </div>
                    <label><span>OAuth Scopes</span><input placeholder="openid email https://mail.google.com/" value={oauthScopes} onChange={(e) => setOauthScopes(e.target.value)} /></label>
                    <label><span>OAuth Redirect URI</span><input value={oauthRedirectUri} onChange={(e) => setOauthRedirectUri(e.target.value)} /></label>
                    <button type="button" className="button-secondary" disabled={!editingId || !oauthAuthorizationUrl || !oauthTokenUrl || !oauthClientId} onClick={() => void startOAuthAuthorization()}>
                      Connect with OAuth (PKCE)
                    </button>
                  </>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
                  <label>
                    <span>IMAP Host <strong style={{ color: "#dc2626" }}>*</strong></span>
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
                    <span>Port <strong style={{ color: "#dc2626" }}>*</strong></span>
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
                    <span>IMAP Username <strong style={{ color: "#dc2626" }}>*</strong></span>
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
                    <span>IMAP Password {!editingId && <strong style={{ color: "#dc2626" }}>*</strong>}</span>
                    <input
                      type="password"
                      placeholder="••••••••••••"
                      value={imapPass}
                      data-email-field="imapPass"
                      aria-invalid={Boolean(accountFieldErrors.imapPass)}
                      style={accountFieldErrors.imapPass ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setImapPass(e.target.value); setAccountFieldErrors((current) => ({ ...current, imapPass: "" })); }}
                    />
                    {editingId && <small style={{ color: "#64748b" }}>Leave blank to keep the saved password.</small>}
                    {accountFieldErrors.imapPass && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.imapPass}</small>}
                  </label>}
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={imapSecure} onChange={(e) => setImapSecure(e.target.checked)} />
                  <span>Use secure SSL/TLS for IMAP (normally enabled for port 993)</span>
                </label>
              </section>

              <section>
                <h3>SMTP Connection (Outbound Mail)</h3>
                <p style={{ margin: "-4px 0 12px", color: "#64748b", fontSize: 12 }}>Required to send new emails and replies.</p>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
                  <label>
                    <span>SMTP Host <strong style={{ color: "#dc2626" }}>*</strong></span>
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
                    <span>Port <strong style={{ color: "#dc2626" }}>*</strong></span>
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
                    <span>SMTP Username <strong style={{ color: "#dc2626" }}>*</strong></span>
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
                    <span>SMTP Password {!editingId && <strong style={{ color: "#dc2626" }}>*</strong>}</span>
                    <input
                      type="password"
                      placeholder="••••••••••••"
                      value={smtpPass}
                      data-email-field="smtpPass"
                      aria-invalid={Boolean(accountFieldErrors.smtpPass)}
                      style={accountFieldErrors.smtpPass ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setSmtpPass(e.target.value); setAccountFieldErrors((current) => ({ ...current, smtpPass: "" })); }}
                    />
                    {editingId && <small style={{ color: "#64748b" }}>Leave blank to keep the saved password.</small>}
                    {accountFieldErrors.smtpPass && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.smtpPass}</small>}
                  </label>}
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
                  <span>Use secure SSL/TLS for SMTP (normally enabled for port 465)</span>
                </label>
              </section>

              <section>
                <h3>Safety Limits & Follow-up</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                  <label><span>Emails / hour</span><input type="number" min="1" value={maxPerHour} onChange={(e) => setMaxPerHour(Number(e.target.value))} /></label>
                  <label><span>Emails / day</span><input type="number" min="1" value={maxPerDay} onChange={(e) => setMaxPerDay(Number(e.target.value))} /></label>
                  <label><span>Per recipient / day</span><input type="number" min="1" value={maxPerRecipientDaily} onChange={(e) => setMaxPerRecipientDaily(Number(e.target.value))} /></label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label><span>{selectedCompanyId === "personal" ? "Personal mailbox / hour" : "Company emails / hour"}</span><input type="number" min="1" value={maxCompanyPerHour} onChange={(e) => setMaxCompanyPerHour(Number(e.target.value))} /></label>
                  <label><span>{selectedCompanyId === "personal" ? "Personal mailbox / day" : "Company emails / day"}</span><input type="number" min="1" value={maxCompanyPerDay} onChange={(e) => setMaxCompanyPerDay(Number(e.target.value))} /></label>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={followupEnabled} onChange={(e) => setFollowupEnabled(e.target.checked)} />
                  <span>Enable automatic follow-up</span>
                </label>
                {followupEnabled && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  <label><span>Delay, days</span><input type="number" min="1" value={followupDelayDays} onChange={(e) => setFollowupDelayDays(Number(e.target.value))} /></label>
                  <label><span>Maximum</span><input type="number" min="1" value={followupMax} onChange={(e) => setFollowupMax(Number(e.target.value))} /></label>
                  <label><span>Action</span><select value={followupAction} onChange={(e) => setFollowupAction(e.target.value as any)}><option value="draft">Create draft</option><option value="auto_send">Send automatically</option><option value="create_task">Create Agent Task</option><option value="notify_user">Notify responsible user</option></select></label>
                </div>}
              </section>

              <section>
                <h3>Signatures & Greeting</h3>
                <label>
                  <span>Default Greeting</span>
                  <input
                    placeholder="Hello,"
                    value={greeting}
                    onChange={(e) => setGreeting(e.target.value)}
                  />
                </label>
                <label>
                  <span>Closing Signature</span>
                  <textarea
                    rows={3}
                    placeholder="Best regards,&#10;Support Team"
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
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary"
                  disabled={saving}
                >
                  {saving ? "Saving..." : editingId ? "Save Changes" : "Connect Account"}
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
                <span>Email Routing</span>
                <h2>{editingRuleId ? "Edit Routing Rule" : "Add Routing Rule"}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label="Close"
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
                <h3>Rule Parameters</h3>
                <label>
                  <span>Rule Name</span>
                  <input
                    required
                    placeholder="e.g. Invoices to Billing Agent"
                    value={ruleName}
                    onChange={(e) => setRuleName(e.target.value)}
                  />
                </label>
              </section>

              <section>
                <h3>Trigger Conditions</h3>
                <label>
                  <span>Subject Keywords (comma-separated)</span>
                  <input
                    placeholder="invoice, payment, bill, receipt"
                    value={ruleSubjectKeywords}
                    onChange={(e) => setRuleSubjectKeywords(e.target.value)}
                  />
                  <small style={{ color: "#64748b", fontSize: "11.5px" }}>Triggers when subject contains any of these words.</small>
                </label>
                <label>
                  <span>Sender Email or Domain Patterns (comma-separated)</span>
                  <input
                    placeholder="billing@, *@partner.com"
                    value={ruleSenders}
                    onChange={(e) => setRuleSenders(e.target.value)}
                  />
                </label>
                <label>
                  <span>Sender Domains (comma-separated)</span>
                  <input placeholder="partner.com, *.trusted.org" value={ruleDomains} onChange={(e) => setRuleDomains(e.target.value)} />
                </label>
                <label>
                  <span>Body Keywords (comma-separated)</span>
                  <input placeholder="refund, contract, verification" value={ruleBodyKeywords} onChange={(e) => setRuleBodyKeywords(e.target.value)} />
                </label>
                <label>
                  <span>Detected Intent</span>
                  <select value={ruleDetectedIntent} onChange={(e) => setRuleDetectedIntent(e.target.value)}>
                    <option value="">Any intent</option>
                    <option value="support">Support / technical issue</option>
                    <option value="billing">Billing / payment</option>
                    <option value="refund">Refund</option>
                    <option value="cancellation">Cancellation</option>
                    <option value="sales">Sales / quote</option>
                    <option value="marketing">Marketing / unsubscribe</option>
                    <option value="general">General</option>
                  </select>
                </label>
                <label>
                  <span>Attachment Types (comma-separated)</span>
                  <input
                    placeholder="application/pdf, image/*, .xlsx"
                    value={ruleAttachmentTypes}
                    onChange={(e) => setRuleAttachmentTypes(e.target.value)}
                  />
                  <small style={{ color: "#64748b", fontSize: "11.5px" }}>Supports MIME wildcards and filename extensions.</small>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={ruleIsVip}
                    onChange={(e) => setRuleIsVip(e.target.checked)}
                  />
                  <span>Apply only to VIP senders</span>
                </label>
              </section>

              <section>
                <h3>Automated Actions</h3>
                <label>
                  <span>Set Priority</span>
                  <select value={rulePriority} onChange={(e) => setRulePriority(e.target.value)}>
                    <option value="">Don't change priority</option>
                    <option value="urgent">Urgent</option>
                    <option value="high">High</option>
                    <option value="normal">Normal</option>
                    <option value="low">Low</option>
                  </select>
                </label>
                <label>
                  <span>Set AI Operational Mode</span>
                  <select value={ruleMode} onChange={(e) => setRuleMode(e.target.value)}>
                    <option value="">Don't change mode</option>
                    <option value="autopilot">Autopilot Mode (Auto-reply)</option>
                    <option value="approval">Approval Mode (Draft for human)</option>
                    <option value="manual">Manual Mode</option>
                  </select>
                </label>
                <label>
                  <span>Assign to Agent</span>
                  <select value={ruleAgentId} onChange={(e) => setRuleAgentId(e.target.value)} disabled={selectedCompanyId === "personal"}>
                    <option value="">Don't reassign agent</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.role})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Automatic Response Template</span>
                  <select value={ruleTemplateId} onChange={(e) => setRuleTemplateId(e.target.value)}>
                    <option value="">Generate a response with AI</option>
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>{template.title}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Start Existing Workflow</span>
                  <select value={ruleWorkflowId} onChange={(e) => setRuleWorkflowId(e.target.value)} disabled={selectedCompanyId === "personal"}>
                    <option value="">Do not start a workflow</option>
                    {workflows.map((workflow) => (
                      <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={ruleRequireApproval} onChange={(e) => setRuleRequireApproval(e.target.checked)} />
                  <span>Always require human approval</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={ruleCreateTask} disabled={selectedCompanyId === "personal"} onChange={(e) => setRuleCreateTask(e.target.checked)} />
                  <span>{selectedCompanyId === "personal" ? "Agent Tasks require a Company mailbox" : "Create an Agent Task when this rule matches"}</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={ruleAutoTagSpam} onChange={(e) => setRuleAutoTagSpam(e.target.checked)} />
                  <span>Move matching sender or domain to Spam without starting AI</span>
                </label>
              </section>

              <footer style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setRuleDrawerOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary"
                  disabled={savingRule}
                >
                  {savingRule ? "Saving..." : editingRuleId ? "Save Rule" : "Create Rule"}
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
                <span>Response Templates</span>
                <h2>{editingTemplateId ? "Edit Response Template" : "Add Response Template"}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label="Close"
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
                <h3>Template Details</h3>
                <label>
                  <span>Template Title</span>
                  <input
                    required
                    placeholder="e.g. Greeting & Ticket Acknowledgment"
                    value={templateTitle}
                    onChange={(e) => setTemplateTitle(e.target.value)}
                  />
                </label>
                <label>
                  <span>Category</span>
                  <select value={templateCategory} onChange={(e) => setTemplateCategory(e.target.value)}>
                    <option value="general">General</option>
                    <option value="support">Customer Support</option>
                    <option value="billing">Billing & Invoices</option>
                    <option value="sales">Sales & Partnerships</option>
                    <option value="information">Information & Onboarding</option>
                  </select>
                </label>
                <label>
                  <span>Subject Line Template (Optional)</span>
                  <input
                    placeholder="e.g. Re: {{customer_name}} - Ticket Confirmation"
                    value={templateSubject}
                    onChange={(e) => setTemplateSubject(e.target.value)}
                  />
                </label>
              </section>

              <section>
                <h3>Body Content & Placeholders</h3>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: "#64748b", alignSelf: "center", marginRight: 4 }}>Insert variable:</span>
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
                  <span>Body Template Text</span>
                  <textarea
                    required
                    rows={6}
                    placeholder="Hello {{customer_name}},&#10;&#10;Thank you for contacting {{company_name}}..."
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
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary"
                  disabled={savingTemplate}
                >
                  {savingTemplate ? "Saving..." : editingTemplateId ? "Save Template" : "Create Template"}
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
                <span>Client Contacts</span>
                <h2>{editingContactEmail ? "Edit Client Contact" : "Add Client Contact"}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label="Close"
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
                <h3>Contact Information</h3>
                <label>
                  <span>Email Address</span>
                  <input
                    type="email"
                    required
                    disabled={!!editingContactEmail}
                    placeholder="client@company.com"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                  />
                </label>
                <label>
                  <span>Full Name</span>
                  <input
                    placeholder="John Doe"
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                  />
                </label>
                <label>
                  <span>Company Name</span>
                  <input
                    placeholder="Acme Corp"
                    value={contactCompanyName}
                    onChange={(e) => setContactCompanyName(e.target.value)}
                  />
                </label>
                <label>
                  <span>Phone Number</span>
                  <input
                    placeholder="+1 555 019 2834"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                  />
                </label>
              </section>

              <section>
                <h3>Status & Priority Flags</h3>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={contactIsVip}
                    onChange={(e) => setContactIsVip(e.target.checked)}
                  />
                  <span>★ Mark as VIP Client (prioritizes emails automatically)</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={contactIsBlacklisted}
                    onChange={(e) => setContactIsBlacklisted(e.target.checked)}
                  />
                  <span>🚫 Blacklist Sender (route incoming messages to spam)</span>
                </label>
                <label style={{ marginTop: 10 }}>
                  <span>Notes & Internal Comments</span>
                  <textarea
                    rows={3}
                    placeholder="Key account details, preference notes..."
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
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary"
                  disabled={savingContact}
                >
                  {savingContact ? "Saving..." : editingContactEmail ? "Save Contact" : "Add Contact"}
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
                <span>DNS Verification</span>
                <h2>{dnsAccount?.emailAddress.split("@")[1] || "Domain"} Audit</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label="Close"
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
                  <p>Querying DNS resolvers for MX, SPF, DKIM, and DMARC records...</p>
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
                    <strong>{dnsResult.verified ? "Domain Fully Verified ✓" : "Configuration Action Recommended ⚠️"}</strong>
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
                          <span style={{ fontWeight: 700, fontSize: "14px" }}>{rec.recordType} Record ({rec.name})</span>
                          <span
                            className={`automation-status-btn ${rec.valid ? "active" : "paused"}`}
                            style={{ cursor: "default" }}
                          >
                            <span className="automation-status-dot" />
                            {rec.valid ? "Valid" : rec.found ? "Invalid Syntax" : "Missing"}
                          </span>
                        </div>

                        {rec.currentValue && (
                          <div style={{ fontSize: "12px", color: "#475569", marginBottom: 4, fontFamily: "monospace" }}>
                            Current: {rec.currentValue}
                          </div>
                        )}

                        {rec.recommendation && (
                          <div style={{ fontSize: "12px", color: "#b45309", background: "#fef3c7", padding: "6px 10px", borderRadius: "6px", marginTop: 6 }}>
                            💡 <strong>Recommendation:</strong> {rec.recommendation}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p>No DNS audit result available.</p>
              )}
            </div>

            <footer style={{ padding: "16px 24px", borderTop: "1px solid #f1f5f9", display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="button-primary automations-action-primary"
                onClick={() => setDnsDrawerOpen(false)}
              >
                Close Audit
              </button>
            </footer>
          </aside>
        </div>
      )}
    </main>
  );
}
