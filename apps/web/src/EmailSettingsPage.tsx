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
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
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
        const selected = requested && res.companies.some((c) => c.id === requested)
          ? requested
          : res.companies[0]?.id ?? "";
        setSelectedCompanyId(selected);
      })
      .catch((e) => setNotice(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Load accounts, agents and analytics when company changes
  useEffect(() => {
    if (!selectedCompanyId) return;
    setLoading(true);
    Promise.all([
      api<{ accounts: EmailAccount[] }>(`/companies/${selectedCompanyId}/email-accounts`),
      api<{ agents: Agent[] }>(`/companies/${selectedCompanyId}/agents`),
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
        api<{ automations: CompanyAutomation[] }>(`/companies/${selectedCompanyId}/automations`),
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
      api<{ keys: EmailPermissionKey[] }>(`/companies/${selectedCompanyId}/api-keys`)
        .then((r) => setPermissionKeys(r.keys.filter((key) => key.scopes.some((scope) => scope.startsWith("email:")))))
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    }
  }, [selectedCompanyId, activeTab]);

  async function createPermissionKey(event: FormEvent) {
    event.preventDefault();
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
    setAgentId(agents[0]?.id || "");
    setMode("approval");
    setTestMode(false);
    setConfidenceThreshold(0.8);
    setLanguageMode("auto");
    setMailAuthType("password");
    setOauthAccessToken("");
    setOauthRefreshToken(""); setOauthTokenUrl(""); setOauthClientId(""); setOauthClientSecret("");
    setOauthAuthorizationUrl(""); setOauthScopes(""); setOauthRedirectUri(`${window.location.origin}/api/email/oauth/callback`);
    setImapHost("imap.company.com");
    setImapPort(993);
    setImapSecure(true);
    setImapUser("");
    setImapPass("");
    setSmtpHost("smtp.company.com");
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
    if (!emailAddress.includes("@")) {
      setNotice("Please enter a valid email address.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        emailAddress,
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
      setNotice(err.message);
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
      if (ruleAgentId) actions.setAgentId = ruleAgentId;
      if (ruleRequireApproval) actions.requireApproval = true;
      if (ruleCreateTask) actions.createTask = true;
      if (ruleAutoTagSpam) actions.autoTagSpam = true;
      if (ruleTemplateId) actions.autoReplyTemplateId = ruleTemplateId;
      if (ruleWorkflowId) actions.startWorkflowId = ruleWorkflowId;

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
            {companies.length > 1 && (
              <select
                aria-label="Select company"
                value={selectedCompanyId}
                onChange={(e) => {
                  setSelectedCompanyId(e.target.value);
                  setSearchParams({ company: e.target.value }, { replace: true });
                }}
                className="page-size-select"
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <Link
              to={`/settings/email/inbox?company=${encodeURIComponent(selectedCompanyId)}&compose=1`}
              className="button-primary automations-action-primary"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
              title={accounts.length ? "Write and send a new email" : "Add an email address, then compose a message"}
              aria-disabled={accounts.length === 0}
            >
              + Compose Email
            </Link>
            <Link
              to={`/settings/email/inbox?company=${encodeURIComponent(selectedCompanyId)}`}
              className="button-secondary automations-action-primary"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              Open AI Inbox →
            </Link>
            <button
              type="button"
              className="button-secondary automations-action-primary"
              onClick={openCreateDrawer}
            >
              + Add Email Address
            </button>
          </div>
        </div>
      </header>

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
        <>
          <section className="email-stats-grid" aria-label="Detailed email analytics">
            {[
              ["AI Answered", analytics.aiAnswered],
              ["Human Answered", analytics.humanAnswered],
              ["Approved by Human", analytics.approvedByHuman],
              ["Escalated to Human", analytics.escalatedToHuman],
              ["Edited AI Responses", analytics.editedAiResponsesCount],
              ["Failed", analytics.failedEmails],
              ["Bounced", analytics.bouncedEmails],
              ["Avg. Response", `${analytics.averageResponseTimeMinutes} min`],
              ["Avg. First Response", `${analytics.averageFirstResponseTimeMinutes} min`],
              ["High Confidence", analytics.confidenceDistribution.high],
              ["Medium Confidence", analytics.confidenceDistribution.medium],
              ["Low Confidence", analytics.confidenceDistribution.low],
            ].map(([label, value]) => (
              <div key={label}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </section>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 20 }}>
            <section className="automations-panel-card">
              <h3>Email Volume by Day</h3>
              <table className="automations-table"><thead><tr><th>Date</th><th>Received</th><th>Sent</th></tr></thead><tbody>
                {analytics.volumeByDay.map((row) => <tr key={row.date}><td>{row.date}</td><td>{row.received}</td><td>{row.sent}</td></tr>)}
              </tbody></table>
            </section>
            <section className="automations-panel-card">
              <h3>Volume by Agent</h3>
              <table className="automations-table"><thead><tr><th>Agent</th><th>Messages</th></tr></thead><tbody>
                {analytics.volumeByAgent.map((row) => <tr key={row.agentId}><td>{row.agentName}</td><td>{row.count}</td></tr>)}
              </tbody></table>
            </section>
            <section className="automations-panel-card">
              <h3>Volume by Account</h3>
              <table className="automations-table"><thead><tr><th>Account</th><th>Messages</th></tr></thead><tbody>
                {analytics.volumeByAccount.map((row) => <tr key={row.accountId}><td>{row.email}</td><td>{row.count}</td></tr>)}
              </tbody></table>
            </section>
          </div>
        </>
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
      )}

      {/* ADD / EDIT ACCOUNT DRAWER */}
      {drawerOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>Email Accounts</span>
                <h2>{editingId ? "Edit Email Account" : "Add Corporate Email Account"}</h2>
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

            <form onSubmit={saveAccount}>
              <section>
                <h3>Account & Agent Assignment</h3>
                <label>
                  <span>Email Address</span>
                  <input
                    type="email"
                    required
                    placeholder="support@company.com"
                    value={emailAddress}
                    onChange={(e) => setEmailAddress(e.target.value)}
                  />
                </label>
                <label>
                  <span>Display Name / Sender Label</span>
                  <input
                    placeholder="Customer Support Team"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </label>
                <label>
                  <span>Assigned Company Agent</span>
                  <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                    <option value="">Unassigned (Manual Routing)</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.role})
                      </option>
                    ))}
                  </select>
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
                <label>
                  <span>Authentication</span>
                  <select value={mailAuthType} onChange={(e) => setMailAuthType(e.target.value as "password" | "oauth2")}>
                    <option value="password">Username and password</option>
                    <option value="oauth2">OAuth 2.0 / XOAUTH2 access token</option>
                  </select>
                </label>
                {mailAuthType === "oauth2" && (
                  <>
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
                    <span>IMAP Host</span>
                    <input
                      placeholder="imap.company.com"
                      value={imapHost}
                      onChange={(e) => setImapHost(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>Port</span>
                    <input
                      type="number"
                      placeholder="993"
                      value={imapPort}
                      onChange={(e) => setImapPort(parseInt(e.target.value, 10))}
                    />
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label>
                    <span>IMAP Username</span>
                    <input
                      placeholder="support@company.com"
                      value={imapUser}
                      onChange={(e) => setImapUser(e.target.value)}
                    />
                  </label>
                  {mailAuthType === "password" && <label>
                    <span>IMAP Password</span>
                    <input
                      type="password"
                      placeholder="••••••••••••"
                      value={imapPass}
                      onChange={(e) => setImapPass(e.target.value)}
                    />
                  </label>}
                </div>
              </section>

              <section>
                <h3>SMTP Connection (Outbound Mail)</h3>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
                  <label>
                    <span>SMTP Host</span>
                    <input
                      placeholder="smtp.company.com"
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>Port</span>
                    <input
                      type="number"
                      placeholder="465"
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(parseInt(e.target.value, 10))}
                    />
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label>
                    <span>SMTP Username</span>
                    <input
                      placeholder="support@company.com"
                      value={smtpUser}
                      onChange={(e) => setSmtpUser(e.target.value)}
                    />
                  </label>
                  {mailAuthType === "password" && <label>
                    <span>SMTP Password</span>
                    <input
                      type="password"
                      placeholder="••••••••••••"
                      value={smtpPass}
                      onChange={(e) => setSmtpPass(e.target.value)}
                    />
                  </label>}
                </div>
              </section>

              <section>
                <h3>Safety Limits & Follow-up</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                  <label><span>Emails / hour</span><input type="number" min="1" value={maxPerHour} onChange={(e) => setMaxPerHour(Number(e.target.value))} /></label>
                  <label><span>Emails / day</span><input type="number" min="1" value={maxPerDay} onChange={(e) => setMaxPerDay(Number(e.target.value))} /></label>
                  <label><span>Per recipient / day</span><input type="number" min="1" value={maxPerRecipientDaily} onChange={(e) => setMaxPerRecipientDaily(Number(e.target.value))} /></label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label><span>Company emails / hour</span><input type="number" min="1" value={maxCompanyPerHour} onChange={(e) => setMaxCompanyPerHour(Number(e.target.value))} /></label>
                  <label><span>Company emails / day</span><input type="number" min="1" value={maxCompanyPerDay} onChange={(e) => setMaxCompanyPerDay(Number(e.target.value))} /></label>
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
                  <select value={ruleAgentId} onChange={(e) => setRuleAgentId(e.target.value)}>
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
                  <select value={ruleWorkflowId} onChange={(e) => setRuleWorkflowId(e.target.value)}>
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
                  <input type="checkbox" checked={ruleCreateTask} onChange={(e) => setRuleCreateTask(e.target.checked)} />
                  <span>Create an Agent Task when this rule matches</span>
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
