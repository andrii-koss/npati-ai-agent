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
  const [activeTab, setActiveTab] = useState<"accounts" | "rules" | "contacts" | "templates" | "analytics">("accounts");
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

  // Load accounts and agents when company changes
  useEffect(() => {
    if (!selectedCompanyId) return;
    setLoading(true);
    Promise.all([
      api<{ accounts: EmailAccount[] }>(`/companies/${selectedCompanyId}/email-accounts`),
      api<{ agents: Agent[] }>(`/companies/${selectedCompanyId}/agents`),
    ])
      .then(([accRes, agentRes]) => {
        setAccounts(accRes.accounts);
        setAgents(agentRes.agents);
      })
      .catch((e) => setNotice(e.message))
      .finally(() => setLoading(false));
  }, [selectedCompanyId]);

  // Load tabs data on demand
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
    } else if (activeTab === "analytics") {
      api<{ analytics: EmailAnalytics }>(`/companies/${selectedCompanyId}/email-inbox/analytics`)
        .then((r) => setAnalytics(r.analytics))
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

  return (
    <div className="automations-page-container">
      {/* Top Header */}
      <div className="page-heading">
        <p className="eyebrow">Communications & Automation</p>
        <div className="automations-header-row">
          <div>
            <h1>Email / AI Inbox Settings</h1>
            <p>Connect corporate email addresses, verify DNS, and configure AI agent inbox automation.</p>
          </div>
          <div className="automations-header-actions">
            <Link to="/inbox" className="button-secondary">
              Open AI Inbox &rarr;
            </Link>
            <button type="button" className="button-primary" onClick={openCreateDrawer}>
              + Add Email Address
            </button>
          </div>
        </div>
      </div>

      {notice && (
        <div className="workspace-notice error" style={{ margin: "16px 0" }}>
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>✕</button>
        </div>
      )}

      {/* Filter / Tabs Bar */}
      <div className="automations-filter-bar">
        <div className="automations-filter-group">
          {companies.length > 1 && (
            <select
              className="automations-status-filter"
              value={selectedCompanyId}
              onChange={(e) => {
                setSelectedCompanyId(e.target.value);
                setSearchParams({ company: e.target.value });
              }}
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className={`automation-action-btn ${activeTab === "accounts" ? "run-btn" : ""}`}
              onClick={() => setActiveTab("accounts")}
            >
              Email Accounts ({accounts.length})
            </button>
            <button
              type="button"
              className={`automation-action-btn ${activeTab === "rules" ? "run-btn" : ""}`}
              onClick={() => setActiveTab("rules")}
            >
              Email Rules
            </button>
            <button
              type="button"
              className={`automation-action-btn ${activeTab === "templates" ? "run-btn" : ""}`}
              onClick={() => setActiveTab("templates")}
            >
              Templates
            </button>
            <button
              type="button"
              className={`automation-action-btn ${activeTab === "analytics" ? "run-btn" : ""}`}
              onClick={() => setActiveTab("analytics")}
            >
              Analytics
            </button>
          </div>
        </div>
      </div>

      {/* ACCOUNTS TAB */}
      {activeTab === "accounts" && (
        <div className="automations-table-container">
          {accounts.length === 0 && !loading ? (
            <div className="empty-state" style={{ padding: "48px 24px", textAlign: "center" }}>
              <h3>No email addresses connected yet</h3>
              <p style={{ color: "#666", marginBottom: "16px" }}>
                Add your company email address (e.g. support@company.com) to automate responses with AI agents.
              </p>
              <button type="button" className="button-primary" onClick={openCreateDrawer}>
                + Add Email Address
              </button>
            </div>
          ) : (
            <table className="automations-table">
              <thead>
                <tr>
                  <th>Email Account</th>
                  <th>Assigned Agent</th>
                  <th>Operational Mode</th>
                  <th>Connection & DNS</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((acc) => {
                  const assigned = agents.find((a) => a.id === acc.agentId);
                  const isTesting = testingId === acc.id;
                  const testFeedback = testResult?.id === acc.id ? testResult : null;

                  return (
                    <tr key={acc.id}>
                      <td>
                        <strong>{acc.displayName || acc.emailAddress}</strong>
                        <div style={{ fontSize: "13px", color: "#666" }}>{acc.emailAddress}</div>
                        {acc.testMode && (
                          <span className="automation-cron-pill" style={{ background: "#fef3c7", color: "#b45309", marginTop: "4px" }}>
                            Test Mode Active
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="automation-agent-badge">
                          <span>🤖</span>
                          <span>{assigned ? assigned.name : "Unassigned"}</span>
                        </span>
                      </td>
                      <td>
                        <span
                          className={`automation-status-badge ${
                            acc.mode === "autopilot" ? "active" : acc.mode === "approval" ? "paused" : ""
                          }`}
                          style={{ textTransform: "capitalize" }}
                        >
                          {acc.mode} Mode
                        </span>
                        <div style={{ fontSize: "11px", color: "#888", marginTop: "3px" }}>
                          Threshold: {Math.round(acc.confidenceThreshold * 100)}%
                        </div>
                      </td>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <span
                            className={`automation-status-badge ${acc.status === "connected" ? "active" : "paused"}`}
                            style={{ width: "fit-content" }}
                          >
                            {acc.status === "connected" ? "Connected" : acc.status.replace("_", " ")}
                          </span>
                          {testFeedback && (
                            <div style={{ fontSize: "12px", color: testFeedback.success ? "#16a34a" : "#dc2626" }}>
                              {testFeedback.message}
                            </div>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="automation-actions-cell" style={{ justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            className="automation-action-btn"
                            disabled={isTesting}
                            onClick={() => runConnectionTest(acc)}
                          >
                            {isTesting ? "Testing..." : "Test Connection"}
                          </button>
                          <button
                            type="button"
                            className="automation-action-btn"
                            onClick={() => openDnsCheck(acc)}
                          >
                            Check DNS
                          </button>
                          <button
                            type="button"
                            className="automation-action-btn"
                            onClick={() => openEditDrawer(acc)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="automation-action-btn danger"
                            onClick={() => deleteAccount(acc.id)}
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
          )}
        </div>
      )}

      {/* RULES TAB */}
      {activeTab === "rules" && (
        <div className="automations-table-container">
          <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #eee" }}>
            <div>
              <h3 style={{ margin: 0 }}>Email Routing Rules</h3>
              <small style={{ color: "#666" }}>Configure custom routing, priority overrides, and approval conditions.</small>
            </div>
            <button
              type="button"
              className="button-primary"
              onClick={async () => {
                const name = prompt("Rule name (e.g. Invoices to Billing Agent):");
                if (!name) return;
                const r = await api<{ rule: EmailRule }>(`/companies/${selectedCompanyId}/email-inbox/rules`, {
                  method: "POST",
                  body: JSON.stringify({ name, conditions: { subjectKeywords: ["invoice", "bill"] }, actions: { setPriority: "high" } }),
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
                <th>Rule Name</th>
                <th>Conditions</th>
                <th>Actions</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: "32px", color: "#666" }}>
                    No custom rules defined yet.
                  </td>
                </tr>
              ) : (
                rules.map((rule) => (
                  <tr key={rule.id}>
                    <td><strong>{rule.name}</strong></td>
                    <td>
                      <code>{JSON.stringify(rule.conditions)}</code>
                    </td>
                    <td>
                      <code>{JSON.stringify(rule.actions)}</code>
                    </td>
                    <td style={{ textAlign: "right" }}>
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
          <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #eee" }}>
            <div>
              <h3 style={{ margin: 0 }}>Response Templates & Signatures</h3>
              <small style={{ color: "#666" }}>Canned responses and brand greetings for support agents.</small>
            </div>
            <button
              type="button"
              className="button-primary"
              onClick={async () => {
                const title = prompt("Template title (e.g. Standard Refund Response):");
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
                <th>Title</th>
                <th>Category</th>
                <th>Body Preview</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: "32px", color: "#666" }}>
                    No response templates saved.
                  </td>
                </tr>
              ) : (
                templates.map((t) => (
                  <tr key={t.id}>
                    <td><strong>{t.title}</strong></td>
                    <td><span className="automation-cron-pill">{t.category}</span></td>
                    <td style={{ maxWidth: "350px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.bodyTemplate}
                    </td>
                    <td style={{ textAlign: "right" }}>
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
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ANALYTICS TAB */}
      {activeTab === "analytics" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px", marginTop: "16px" }}>
          <div className="action-card" style={{ padding: "20px" }}>
            <span style={{ fontSize: "13px", color: "#666" }}>Total Received</span>
            <h2 style={{ margin: "8px 0" }}>{analytics?.receivedEmails ?? 0}</h2>
          </div>
          <div className="action-card" style={{ padding: "20px" }}>
            <span style={{ fontSize: "13px", color: "#666" }}>Total Sent</span>
            <h2 style={{ margin: "8px 0" }}>{analytics?.sentEmails ?? 0}</h2>
          </div>
          <div className="action-card" style={{ padding: "20px" }}>
            <span style={{ fontSize: "13px", color: "#666" }}>AI Automation Rate</span>
            <h2 style={{ margin: "8px 0", color: "#16a34a" }}>{analytics?.automationRate ?? 0}%</h2>
          </div>
          <div className="action-card" style={{ padding: "20px" }}>
            <span style={{ fontSize: "13px", color: "#666" }}>Drafts Prepared</span>
            <h2 style={{ margin: "8px 0" }}>{analytics?.draftedByAi ?? 0}</h2>
          </div>
        </div>
      )}

      {/* ADD / EDIT ACCOUNT DRAWER */}
      {drawerOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()} style={{ width: "min(620px, 94vw)" }}>
            <header>
              <div>
                <span>Email Accounts</span>
                <h2>{editingId ? "Edit Email Account" : "Connect Email Address"}</h2>
              </div>
              <button type="button" className="automations-drawer-close" onClick={() => setDrawerOpen(false)}>✕</button>
            </header>
            <form onSubmit={saveAccount} style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
              <section>
                <h3>Account Information</h3>
                <label>
                  <span>Corporate Email Address *</span>
                  <input
                    required
                    type="email"
                    placeholder="e.g. support@company.com"
                    value={emailAddress}
                    onChange={(e) => setEmailAddress(e.target.value)}
                  />
                </label>
                <label>
                  <span>Display Name</span>
                  <input
                    placeholder="e.g. Customer Support"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </label>
                <label>
                  <span>Assigned AI Agent</span>
                  <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                    <option value="">No Agent (Human Only)</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
                    ))}
                  </select>
                </label>
              </section>

              <section>
                <h3>AI Operational Mode (Section 5)</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
                  <button
                    type="button"
                    className={`automation-action-btn ${mode === "manual" ? "run-btn" : ""}`}
                    onClick={() => setMode("manual")}
                  >
                    Manual
                  </button>
                  <button
                    type="button"
                    className={`automation-action-btn ${mode === "approval" ? "run-btn" : ""}`}
                    onClick={() => setMode("approval")}
                  >
                    Approval
                  </button>
                  <button
                    type="button"
                    className={`automation-action-btn ${mode === "autopilot" ? "run-btn" : ""}`}
                    onClick={() => setMode("autopilot")}
                  >
                    Autopilot
                  </button>
                </div>
                <p style={{ fontSize: "12px", color: "#666", marginTop: "6px" }}>
                  {mode === "manual" && "AI reads & classifies messages, but does not prepare or send replies."}
                  {mode === "approval" && "AI generates response draft; human reviews, edits, and approves before sending."}
                  {mode === "autopilot" && "AI autonomously sends response when confidence meets the threshold."}
                </p>

                <label style={{ marginTop: "12px" }}>
                  <span>Confidence Threshold ({Math.round(confidenceThreshold * 100)}%)</span>
                  <input
                    type="range"
                    min="0.5"
                    max="0.99"
                    step="0.05"
                    value={confidenceThreshold}
                    onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
                  />
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px", background: "#fef3c7", padding: "10px", borderRadius: "8px" }}>
                  <input
                    type="checkbox"
                    checked={testMode}
                    onChange={(e) => setTestMode(e.target.checked)}
                  />
                  <span>
                    <strong>Test Mode (Sandbox)</strong>
                    <div style={{ fontSize: "12px", color: "#78350f" }}>
                      AI simulates classifications, drafts, and responses without sending external emails.
                    </div>
                  </span>
                </label>
              </section>

              <section>
                <h3>IMAP & SMTP Settings</h3>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "8px" }}>
                  <label>
                    <span>IMAP Server</span>
                    <input placeholder="imap.company.com" value={imapHost} onChange={(e) => setImapHost(e.target.value)} />
                  </label>
                  <label>
                    <span>Port</span>
                    <input type="number" value={imapPort} onChange={(e) => setImapPort(Number(e.target.value))} />
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "8px" }}>
                  <label>
                    <span>SMTP Server</span>
                    <input placeholder="smtp.company.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
                  </label>
                  <label>
                    <span>Port</span>
                    <input type="number" value={smtpPort} onChange={(e) => setSmtpPort(Number(e.target.value))} />
                  </label>
                </div>
              </section>

              <footer style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "16px" }}>
                <button type="button" className="button-secondary" onClick={() => setDrawerOpen(false)}>Cancel</button>
                <button type="submit" className="button-primary" disabled={saving}>
                  {saving ? "Saving..." : editingId ? "Update Account" : "Connect Account"}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {/* DNS CHECK DRAWER */}
      {dnsDrawerOpen && dnsAccount && (
        <div className="company-drawer-backdrop" onMouseDown={() => setDnsDrawerOpen(false)}>
          <aside className="company-drawer" onMouseDown={(e) => e.stopPropagation()} style={{ width: "min(680px, 94vw)" }}>
            <header>
              <div>
                <span>DNS Verification</span>
                <h2>{dnsAccount.emailAddress.split("@")[1]}</h2>
              </div>
              <button type="button" className="automations-drawer-close" onClick={() => setDnsDrawerOpen(false)}>✕</button>
            </header>
            <div style={{ padding: "20px" }}>
              {dnsChecking ? (
                <div style={{ padding: "40px", textAlign: "center" }}>Checking DNS records (MX, SPF, DKIM, DMARC)...</div>
              ) : dnsResult ? (
                <div>
                  <div
                    className={`automation-status-badge ${dnsResult.verified ? "active" : "paused"}`}
                    style={{ marginBottom: "16px", padding: "8px 14px", fontSize: "14px" }}
                  >
                    {dnsResult.summary}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {dnsResult.records.map((record) => (
                      <div
                        key={record.recordType}
                        style={{
                          border: "1px solid #e5e7eb",
                          borderRadius: "8px",
                          padding: "14px",
                          background: record.valid ? "#f0fdf4" : "#fff1f2",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <strong>{record.recordType} Record ({record.name})</strong>
                          <span
                            style={{
                              fontWeight: 600,
                              fontSize: "12px",
                              color: record.valid ? "#16a34a" : "#dc2626",
                            }}
                          >
                            {record.valid ? "✓ Valid" : "✕ Attention Required"}
                          </span>
                        </div>
                        {record.currentValue && (
                          <div style={{ fontSize: "12px", fontFamily: "monospace", marginTop: "6px", wordBreak: "break-all" }}>
                            Value: {record.currentValue}
                          </div>
                        )}
                        {record.recommendation && (
                          <div style={{ fontSize: "13px", color: "#4b5563", marginTop: "6px" }}>
                            Recommendation: {record.recommendation}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
