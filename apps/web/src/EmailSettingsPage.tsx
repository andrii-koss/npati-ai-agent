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
  imapConfig: { host?: string; port?: number; secure?: boolean; username?: string; password?: string; lastError?: string | null };
  smtpConfig: { host?: string; port?: number; secure?: boolean; username?: string; password?: string; fromName?: string; replyTo?: string; lastError?: string | null };
  rateLimits: { maxPerHour: number; maxPerDay: number; maxPerRecipientDaily: number; maxFollowups: number };
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
  conditions: { senders?: string[]; subjectKeywords?: string[]; isVip?: boolean };
  actions: { setMode?: string; setPriority?: string; setAgentId?: string };
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
  automationRate: number;
  confidenceDistribution: { high: number; medium: number; low: number };
  volumeByDay: Array<{ date: string; received: number; sent: number }>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = (await response.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body;
}

export function EmailSettingsPage() {
  const { overview } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [activeTab, setActiveTab] = useState<"accounts" | "rules" | "templates" | "contacts">("accounts");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  // Editor Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [emailAddress, setEmailAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [mode, setMode] = useState<"manual" | "approval" | "autopilot">("approval");
  const [testMode, setTestMode] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.8);
  const [languageMode, setLanguageMode] = useState("auto");
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

  // Rules & Templates & Contacts & Analytics
  const [rules, setRules] = useState<EmailRule[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [analytics, setAnalytics] = useState<EmailAnalytics | null>(null);

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
      api<{ rules: EmailRule[] }>(`/companies/${selectedCompanyId}/email-inbox/rules`)
        .then((r) => setRules(r.rules))
        .catch(() => undefined);
    } else if (activeTab === "templates") {
      api<{ templates: EmailTemplate[] }>(`/companies/${selectedCompanyId}/email-inbox/templates`)
        .then((r) => setTemplates(r.templates))
        .catch(() => undefined);
    } else if (activeTab === "contacts") {
      api<{ contacts: ContactItem[] }>(`/companies/${selectedCompanyId}/email-inbox/contacts`)
        .then((r) => setContacts(r.contacts))
        .catch(() => undefined);
    }
  }, [selectedCompanyId, activeTab]);

  function openCreateDrawer() {
    setEditingId(null);
    setEmailAddress("");
    setDisplayName("");
    setAgentId(agents[0]?.id || "");
    setMode("approval");
    setTestMode(false);
    setConfidenceThreshold(0.8);
    setLanguageMode("auto");
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
    setImapHost(account.imapConfig.host || "");
    setImapPort(account.imapConfig.port || 993);
    setImapSecure(account.imapConfig.secure ?? true);
    setImapUser(account.imapConfig.username || "");
    setImapPass(account.imapConfig.password || "");
    setSmtpHost(account.smtpConfig.host || "");
    setSmtpPort(account.smtpConfig.port || 465);
    setSmtpSecure(account.smtpConfig.secure ?? true);
    setSmtpUser(account.smtpConfig.username || "");
    setSmtpPass(account.smtpConfig.password || "");
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
        imapConfig: { host: imapHost, port: imapPort, secure: imapSecure, username: imapUser, password: imapPass },
        smtpConfig: { host: smtpHost, port: smtpPort, secure: smtpSecure, username: smtpUser, password: smtpPass },
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
      // Refresh accounts status
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
    <main className="automations-container">
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
              to="/inbox"
              className="button-secondary automations-action-primary"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              Open AI Inbox →
            </Link>
            <button
              type="button"
              className="button-primary automations-action-primary"
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
          <strong>{Math.round((analytics?.automationRate ?? 0) * 100)}%</strong>
          <span>AI Automation Rate</span>
          <small>Autonomously handled</small>
        </div>
        <div>
          <strong>{analytics?.draftedByAi ?? 0}</strong>
          <span>Drafts Prepared</span>
          <small>Awaiting human review</small>
        </div>
      </section>

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
              onClick={async () => {
                const name = prompt("Rule name (e.g. Invoices to Billing Agent):");
                if (!name) return;
                const r = await api<{ rule: EmailRule }>(`/companies/${selectedCompanyId}/email-inbox/rules`, {
                  method: "POST",
                  body: JSON.stringify({ name, conditions: { subjectKeywords: ["invoice", "payment", "billing"] }, actions: { setPriority: "high" } }),
                });
                setRules((prev) => [...prev, r.rule]);
              }}
            >
              + Add Rule
            </button>
          </div>
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ width: "240px" }}>Rule Name</th>
                <th>Conditions</th>
                <th>Actions</th>
                <th style={{ width: "120px", textAlign: "right" }}>Actions</th>
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
                rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      <div className="automation-title-cell">
                        <strong>{rule.name}</strong>
                      </div>
                    </td>
                    <td>
                      <span className="automation-cron-pill">
                        {JSON.stringify(rule.conditions)}
                      </span>
                    </td>
                    <td>
                      <span className="automation-agent-badge">
                        {JSON.stringify(rule.actions)}
                      </span>
                    </td>
                    <td>
                      <div className="automation-actions-cell">
                        <button
                          type="button"
                          className="automation-action-btn danger"
                          onClick={async () => {
                            await api(`/companies/${selectedCompanyId}/email-inbox/rules/${rule.id}`, { method: "DELETE" });
                            setRules((prev) => prev.filter((r) => r.id !== rule.id));
                          }}
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
              onClick={async () => {
                const title = prompt("Template title (e.g. Greeting & Acknowledgment):");
                if (!title) return;
                const body = prompt("Template body text:");
                if (!body) return;
                const res = await api<{ template: EmailTemplate }>(`/companies/${selectedCompanyId}/email-inbox/templates`, {
                  method: "POST",
                  body: JSON.stringify({ title, bodyTemplate: body }),
                });
                setTemplates((prev) => [...prev, res.template]);
              }}
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
                <th style={{ width: "120px", textAlign: "right" }}>Actions</th>
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
                      </div>
                    </td>
                    <td>
                      <span className="automation-cron-pill">{t.category}</span>
                    </td>
                    <td>
                      <div className="automation-prompt-preview" style={{ maxWidth: "500px" }}>
                        {t.bodyTemplate}
                      </div>
                    </td>
                    <td>
                      <div className="automation-actions-cell">
                        <button
                          type="button"
                          className="automation-action-btn danger"
                          onClick={async () => {
                            await api(`/companies/${selectedCompanyId}/email-inbox/templates/${t.id}`, { method: "DELETE" });
                            setTemplates((prev) => prev.filter((item) => item.id !== t.id));
                          }}
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
              onClick={async () => {
                const email = prompt("Contact email (e.g. partner@corp.com):");
                if (!email) return;
                const name = prompt("Contact name:") || undefined;
                const res = await api<{ contact: ContactItem }>(`/companies/${selectedCompanyId}/email-inbox/contacts`, {
                  method: "POST",
                  body: JSON.stringify({ email, name, isVip: true }),
                });
                setContacts((prev) => [...prev.filter((c) => c.email !== email), res.contact]);
              }}
            >
              + Add VIP Contact
            </button>
          </div>
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ minWidth: "220px" }}>Contact</th>
                <th style={{ minWidth: "140px" }}>VIP Status</th>
                <th style={{ minWidth: "140px" }}>Blacklisted</th>
                <th>Notes</th>
                <th style={{ width: "120px", textAlign: "right" }}>Actions</th>
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
                      </div>
                    </td>
                    <td>
                      <span className={`automation-status-btn ${contact.isVip ? "active" : "paused"}`} style={{ cursor: "default" }}>
                        <span className="automation-status-dot" />
                        {contact.isVip ? "VIP Sender" : "Standard"}
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

      {/* ADD / EDIT ACCOUNT DRAWER */}
      {drawerOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()} style={{ width: "min(680px, 95vw)" }}>
            <header>
              <div>
                <span>Email Accounts</span>
                <h2>{editingId ? "Edit Email Account" : "Add Corporate Email Account"}</h2>
              </div>
              <button
                type="button"
                className="automations-drawer-close"
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
                  <label>
                    <span>IMAP Password</span>
                    <input
                      type="password"
                      placeholder="••••••••••••"
                      value={imapPass}
                      onChange={(e) => setImapPass(e.target.value)}
                    />
                  </label>
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
                  <label>
                    <span>SMTP Password</span>
                    <input
                      type="password"
                      placeholder="••••••••••••"
                      value={smtpPass}
                      onChange={(e) => setSmtpPass(e.target.value)}
                    />
                  </label>
                </div>
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

      {/* DNS AUDIT DRAWER */}
      {dnsDrawerOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setDnsDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()} style={{ width: "min(640px, 95vw)" }}>
            <header>
              <div>
                <span>DNS Verification</span>
                <h2>{dnsAccount?.emailAddress.split("@")[1] || "Domain"} Audit</h2>
              </div>
              <button
                type="button"
                className="automations-drawer-close"
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
