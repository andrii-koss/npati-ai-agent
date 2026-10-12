import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { chooseAvailableCompanyId, getInitialCompanyScope, readCachedCompanies, writeActiveCompanyId, writeCachedCompanies } from "./active-company";
import { useWorkspace } from "./BusinessWorkspace";
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

export interface Company {
  id: string;
  name: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
}

export interface CompanyAutomation {
  id: string;
  name: string;
  status: "active" | "paused" | "deleted";
}

export interface EmailAccount {
  id: string;
  emailAddress: string;
  provider: "gmail" | "microsoft" | "imap_smtp";
  connectionScope: "account" | "company" | "agent";
  senderPolicy: "pairing" | "allowlist" | "open" | "disabled";
  allowedSenders: string[];
  allowedDomains: string[];
  requireAuthenticatedSender: boolean;
  outboundPolicy: "draft_only" | "approval_required" | "auto_send";
  displayName?: string | null;
  agentId?: string | null;
  mode: "manual" | "approval" | "autopilot";
  status: "connected" | "pending" | "auth_error" | "imap_error" | "smtp_error" | "dns_error" | "disabled";
  testMode: boolean;
  confidenceThreshold: number;
  languageMode: string;
  fallbackLanguage: string;
  imapConfig: { authType?: "password" | "oauth2"; host?: string; port?: number; secure?: boolean; tls?: boolean; username?: string; password?: string; tokenUrl?: string; clientId?: string; tokenExpiresAt?: string; lastError?: string | null };
  smtpConfig: { authType?: "password" | "oauth2"; host?: string; port?: number; secure?: boolean; username?: string; password?: string; tokenUrl?: string; clientId?: string; tokenExpiresAt?: string; fromName?: string; replyTo?: string; lastError?: string | null };
  rateLimits: { maxPerHour: number; maxPerDay: number; maxPerRecipientDaily: number; maxFollowups: number; maxCompanyPerHour?: number; maxCompanyPerDay?: number };
  followupConfig: { enabled: boolean; delayDays: number; maxFollowups: number; action: "draft" | "auto_send" | "create_task" | "notify_user" };
  signatureConfig: { greeting?: string; signature?: string; footer?: string };
  createdAt: string;
  updatedAt: string;
}

export interface DnsRecordCheck {
  recordType: "MX" | "SPF" | "DKIM" | "DMARC";
  name: string;
  found: boolean;
  valid: boolean;
  currentValue?: string;
  expectedValueHint?: string;
  recommendation?: string;
}

export interface DnsCheckResult {
  domain: string;
  verified: boolean;
  records: DnsRecordCheck[];
  summary: string;
}

export interface EmailRule {
  id: string;
  name: string;
  priorityOrder: number;
  isActive: boolean;
  conditions: { senders?: string[]; domains?: string[]; subjectKeywords?: string[]; bodyKeywords?: string[]; detectedIntent?: string; attachmentTypes?: string[]; isVip?: boolean };
  actions: { setMode?: string; setPriority?: string; setAgentId?: string; requireApproval?: boolean; createTask?: boolean; autoTagSpam?: boolean; autoReplyTemplateId?: string; startWorkflowId?: string };
}

export interface EmailTemplate {
  id: string;
  title: string;
  category: string;
  subjectTemplate?: string;
  bodyTemplate: string;
}

export interface ContactItem {
  id: string;
  email: string;
  name?: string | null;
  companyName?: string | null;
  phone?: string | null;
  isVip: boolean;
  isBlacklisted: boolean;
  notes?: string | null;
}

export interface EmailAnalytics {
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

export interface EmailPermissionKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const EMAIL_PERMISSION_OPTIONS = [
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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
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

export function readCachedAccounts(companyId: string): EmailAccount[] {
  try {
    const raw = sessionStorage.getItem(`npati_email_accounts_${companyId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function writeCachedAccounts(companyId: string, accounts: EmailAccount[]): void {
  try {
    sessionStorage.setItem(`npati_email_accounts_${companyId}`, JSON.stringify(accounts));
  } catch {}
}

export function readCachedAnalytics(companyId: string): EmailAnalytics | null {
  try {
    const raw = sessionStorage.getItem(`npati_email_analytics_${companyId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeCachedAnalytics(companyId: string, analytics: EmailAnalytics | null): void {
  try {
    if (analytics) {
      sessionStorage.setItem(`npati_email_analytics_${companyId}`, JSON.stringify(analytics));
    }
  } catch {}
}

export function EmailSettingsPage() {
  const { t, language } = useTranslation();
  const { overview } = useWorkspace();
  const [companies, setCompanies] = useState<Company[]>(readCachedCompanies);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>(() => {
    const currentUrl = new URL(window.location.href);
    return getInitialCompanyScope(currentUrl.searchParams.get("company"));
  });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [accounts, setAccounts] = useState<EmailAccount[]>(() => {
    const currentUrl = new URL(window.location.href);
    const scope = getInitialCompanyScope(currentUrl.searchParams.get("company"));
    return readCachedAccounts(scope);
  });
  const [activeTab, setActiveTab] = useState<"accounts" | "rules" | "templates" | "contacts" | "permissions">("accounts");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
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
  const [analytics, setAnalytics] = useState<EmailAnalytics | null>(() => {
    const currentUrl = new URL(window.location.href);
    const scope = getInitialCompanyScope(currentUrl.searchParams.get("company"));
    return readCachedAnalytics(scope);
  });
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
        writeCachedCompanies(res.companies);
        const currentUrl = new URL(window.location.href);
        const requested = currentUrl.searchParams.get("company");
        const selected = requested === "personal"
          ? "personal"
          : chooseAvailableCompanyId(res.companies, { requested, fallback: "personal" });
        if (selected !== selectedCompanyId) {
          setSelectedCompanyId(selected);
          writeActiveCompanyId(selected === "personal" ? "" : selected);
        }
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
    const personalScope = selectedCompanyId === "personal";
    Promise.all([
      api<{ accounts: EmailAccount[] }>(`/companies/${selectedCompanyId}/email-accounts`),
      personalScope ? Promise.resolve({ agents: [] as Agent[] }) : api<{ agents: Agent[] }>(`/companies/${selectedCompanyId}/agents`),
      api<{ analytics: EmailAnalytics }>(`/companies/${selectedCompanyId}/email-inbox/analytics`).catch(() => ({ analytics: null })),
    ])
      .then(([accRes, agentRes, analRes]) => {
        setAccounts(accRes.accounts);
        writeCachedAccounts(selectedCompanyId, accRes.accounts);
        setAgents(agentRes.agents);
        if (analRes.analytics) {
          setAnalytics(analRes.analytics);
          writeCachedAnalytics(selectedCompanyId, analRes.analytics);
        }
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
              to={selectedCompanyId && selectedCompanyId !== "personal" ? `/settings/email/inbox?company=${encodeURIComponent(selectedCompanyId)}` : "/settings/email/inbox"}
              className="button-secondary"
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
      <EmailSettingsOverviewBlock selectedCompanyId={selectedCompanyId} t={t} setSelectedCompanyId={setSelectedCompanyId} setAgentId={setAgentId} setRuleAgentId={setRuleAgentId} setRuleWorkflowId={setRuleWorkflowId} setRuleCreateTask={setRuleCreateTask} setAccounts={setAccounts} setAnalytics={setAnalytics} companies={companies} accounts={accounts} />

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
        <EmailSettingsInboxBlock t={t} openCreateRuleDrawer={openCreateRuleDrawer} rules={rules} mode={mode} agents={agents} openEditRuleDrawer={openEditRuleDrawer} handleDeleteRule={handleDeleteRule} />
      )}

      {/* TEMPLATES TAB */}
      {activeTab === "templates" && (
        <EmailSettingsSidebarBlock t={t} openCreateTemplateDrawer={openCreateTemplateDrawer} templates={templates} openEditTemplateDrawer={openEditTemplateDrawer} handleDeleteTemplate={handleDeleteTemplate} />
      )}

      {/* CONTACTS & VIP TAB */}
      {activeTab === "contacts" && (
        <EmailSettingsTestBlock t={t} openCreateContactDrawer={openCreateContactDrawer} contacts={contacts} openEditContactDrawer={openEditContactDrawer} companies={companies} selectedCompanyId={selectedCompanyId} setContacts={setContacts} />
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
