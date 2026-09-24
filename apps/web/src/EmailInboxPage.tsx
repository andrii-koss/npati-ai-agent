import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useWorkspace } from "./BusinessWorkspace";
import { confirmModal } from "./ConfirmDialog";

interface Company {
  id: string;
  name: string;
}

interface EmailAccount {
  id: string;
  emailAddress: string;
  displayName?: string | null;
  agentId?: string | null;
  mode: "manual" | "approval" | "autopilot";
  testMode: boolean;
}

interface EmailThread {
  id: string;
  subject: string;
  customerEmail: string;
  customerName?: string | null;
  customerCompany?: string | null;
  customerPhone?: string | null;
  status: "new" | "ai_processing" | "draft_ready" | "waiting_approval" | "waiting_customer" | "waiting_human" | "answered" | "closed" | "failed";
  priority: "low" | "normal" | "high" | "urgent";
  folder: "inbox" | "sent" | "drafts" | "archived" | "spam";
  assignedAgentId?: string | null;
  isVip: boolean;
  isBlacklisted: boolean;
  isHumanTakeover: boolean;
  lockedByUserId?: string | null;
  lockedAt?: string | null;
  lastMessageAt: string;
  unreadCount: number;
  aiConfidenceScore?: number | null;
  aiClassificationSummary?: string | null;
  detectedLanguage?: string | null;
}

interface EmailMessage {
  id: string;
  threadId: string;
  direction: "inbound" | "outbound";
  fromAddress: string;
  fromName?: string | null;
  toAddresses: string[];
  subject: string;
  bodyText: string;
  attachments?: Array<{ filename: string; contentType: string; sizeBytes: number }>;
  isDraft: boolean;
  isAiGenerated: boolean;
  deliveryStatus: string;
  createdAt: string;
}

interface ContactDetails {
  email: string;
  name?: string | null;
  companyName?: string | null;
  phone?: string | null;
  isVip: boolean;
  isBlacklisted: boolean;
  notes?: string | null;
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

export function EmailInboxPage() {
  const { overview } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("all");

  const [folder, setFolder] = useState<"inbox" | "sent" | "drafts" | "archived" | "spam">("inbox");
  const [threads, setThreads] = useState<EmailThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<EmailThread | null>(null);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [contact, setContact] = useState<ContactDetails | null>(null);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");

  // Composer State
  const [replyText, setReplyText] = useState("");
  const [draftEditing, setDraftEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftMessageId, setDraftMessageId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Load companies
  useEffect(() => {
    api<{ companies: Company[] }>("/companies")
      .then((res) => {
        setCompanies(res.companies);
        const sel = res.companies[0]?.id ?? "";
        setSelectedCompanyId(sel);
      })
      .catch((e) => setNotice(e.message));
  }, []);

  // Load accounts when company changes
  useEffect(() => {
    if (!selectedCompanyId) return;
    api<{ accounts: EmailAccount[] }>(`/companies/${selectedCompanyId}/email-accounts`)
      .then((res) => setAccounts(res.accounts))
      .catch(() => undefined);
  }, [selectedCompanyId]);

  // Load threads
  async function loadThreads() {
    if (!selectedCompanyId) return;
    try {
      const q = new URLSearchParams();
      q.set("folder", folder);
      if (selectedAccountId !== "all") q.set("accountId", selectedAccountId);
      if (statusFilter !== "all") q.set("status", statusFilter);
      if (priorityFilter !== "all") q.set("priority", priorityFilter);
      if (searchQuery.trim()) q.set("search", searchQuery.trim());

      const res = await api<{ threads: EmailThread[] }>(
        `/companies/${selectedCompanyId}/email-inbox/threads?${q.toString()}`
      );
      setThreads(res.threads);
      if (res.threads.length > 0 && !selectedThreadId) {
        setSelectedThreadId(res.threads[0]!.id);
      }
    } catch (err: any) {
      setNotice(err.message);
    }
  }

  useEffect(() => {
    loadThreads();
  }, [selectedCompanyId, folder, selectedAccountId, statusFilter, priorityFilter, searchQuery]);

  // Load thread detail
  useEffect(() => {
    if (!selectedCompanyId || !selectedThreadId) {
      setActiveThread(null);
      setMessages([]);
      setContact(null);
      return;
    }

    api<{ thread: EmailThread; messages: EmailMessage[]; contact: ContactDetails | null }>(
      `/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}`
    )
      .then((res) => {
        setActiveThread(res.thread);
        setMessages(res.messages);
        setContact(res.contact);

        const draft = res.messages.find((m) => m.isDraft);
        if (draft) {
          setDraftMessageId(draft.id);
          setDraftText(draft.bodyText);
        } else {
          setDraftMessageId(null);
          setDraftText("");
        }
      })
      .catch((e) => setNotice(e.message));
  }, [selectedCompanyId, selectedThreadId]);

  // Handle Acquire Lock when typing reply
  async function onReplyFocus() {
    if (!selectedCompanyId || !selectedThreadId) return;
    await api(`/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}/lock`, {
      method: "POST",
      body: JSON.stringify({ action: "acquire" }),
    }).catch(() => undefined);
  }

  // Handle Send Reply
  async function handleSendReply(e: FormEvent) {
    e.preventDefault();
    if (!selectedCompanyId || !selectedThreadId || !replyText.trim()) return;

    setSending(true);
    try {
      await api(`/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ bodyText: replyText, isDraft: false }),
      });
      setReplyText("");
      await api(`/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}/lock`, {
        method: "POST",
        body: JSON.stringify({ action: "release" }),
      });
      const res = await api<{ thread: EmailThread; messages: EmailMessage[] }>(
        `/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}`
      );
      setActiveThread(res.thread);
      setMessages(res.messages);
      loadThreads();
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setSending(false);
    }
  }

  // Handle Approve AI Draft
  async function handleApproveDraft() {
    if (!selectedCompanyId || !selectedThreadId || !draftMessageId) return;
    setSending(true);
    try {
      if (draftEditing) {
        await api(
          `/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}/messages/${draftMessageId}`,
          { method: "PATCH", body: JSON.stringify({ bodyText: draftText }) }
        );
      }

      await api(`/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ approvedDraftMessageId: draftMessageId, bodyText: draftText }),
      });

      setDraftMessageId(null);
      setDraftEditing(false);
      const res = await api<{ thread: EmailThread; messages: EmailMessage[] }>(
        `/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}`
      );
      setActiveThread(res.thread);
      setMessages(res.messages);
      loadThreads();
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setSending(false);
    }
  }

  // Handle Takeover toggle
  async function handleToggleTakeover() {
    if (!selectedCompanyId || !activeThread) return;
    const next = !activeThread.isHumanTakeover;
    try {
      const res = await api<{ thread: EmailThread }>(
        `/companies/${selectedCompanyId}/email-inbox/threads/${activeThread.id}/takeover`,
        { method: "POST", body: JSON.stringify({ takeover: next }) }
      );
      setActiveThread(res.thread);
      loadThreads();
    } catch (err: any) {
      setNotice(err.message);
    }
  }

  // Handle VIP toggle
  async function handleToggleVip() {
    if (!selectedCompanyId || !activeThread) return;
    const nextVip = !activeThread.isVip;
    try {
      await api(`/companies/${selectedCompanyId}/email-inbox/contacts/${encodeURIComponent(activeThread.customerEmail)}`, {
        method: "PATCH",
        body: JSON.stringify({ isVip: nextVip }),
      });
      setActiveThread((prev) => (prev ? { ...prev, isVip: nextVip } : null));
      loadThreads();
    } catch (err: any) {
      setNotice(err.message);
    }
  }

  // Simulate Inbound Email
  async function handleSimulateEmail() {
    if (!selectedCompanyId) return;
    try {
      const res = await api<{ thread: EmailThread }>(
        `/companies/${selectedCompanyId}/email-inbox/simulate`,
        { method: "POST", body: JSON.stringify({}) }
      );
      setNotice("Simulated inbound email processed successfully!");
      loadThreads();
      if (res.thread) setSelectedThreadId(res.thread.id);
    } catch (err: any) {
      setNotice(err.message);
    }
  }

  return (
    <main className="goals-container automations-container">
      {/* Top Header matching /settings/email and /settings/goals */}
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">Settings · Email & AI Inbox</p>
            <h1>
              <Link
                to="/settings/email"
                className="marketplace-back-button"
                aria-label="Back to Email Settings"
                title="Back to Email Settings"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>AI Inbox & Email Threads</span>
            </h1>
            <p className="hero-copy">
              Unified corporate email inbox, autonomous AI draft reviews, multi-account routing, and collision-protected operator takeover.
            </p>
          </div>
          <div className="automations-header-actions">
            {companies.length > 1 && (
              <select
                aria-label="Select company"
                value={selectedCompanyId}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="page-size-select"
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="button-secondary automations-action-primary"
              onClick={handleSimulateEmail}
              title="Simulate incoming client email"
            >
              ⚡ Simulate Inbound Email
            </button>
            <Link
              to="/settings/email"
              className="button-primary automations-action-primary"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              ⚙️ Email Settings
            </Link>
          </div>
        </div>
      </header>

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

      {/* 3-Column Unified Inbox Card */}
      <div className="email-inbox-card">
        {/* Left Column: Folders & Accounts */}
        <aside className="email-inbox-sidebar">
          <div>
            <span className="email-inbox-label">Account</span>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="email-inbox-select"
            >
              <option value="all">All Accounts ({accounts.length})</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName || a.emailAddress}
                </option>
              ))}
            </select>
          </div>

          <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="email-inbox-label">Folders</span>
            {[
              { id: "inbox", label: "Inbox", icon: "📥" },
              { id: "sent", label: "Sent", icon: "📤" },
              { id: "drafts", label: "Drafts", icon: "📝" },
              { id: "archived", label: "Archived", icon: "📁" },
              { id: "spam", label: "Spam", icon: "🚫" },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                className={`email-inbox-folder-btn ${folder === f.id ? "active" : ""}`}
                onClick={() => setFolder(f.id as any)}
              >
                <span>
                  <span style={{ marginRight: 8 }}>{f.icon}</span>
                  <span>{f.label}</span>
                </span>
                {folder === f.id && threads.length > 0 && (
                  <span style={{ fontSize: "11px", opacity: 0.8 }}>({threads.length})</span>
                )}
              </button>
            ))}
          </nav>
        </aside>

        {/* Middle Column: Threads List */}
        <div className="email-inbox-threads-col">
          {/* Search & Filter Bar */}
          <div className="email-inbox-threads-header">
            <div className="inspector-search-box" style={{ width: "100%" }}>
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                type="text"
                placeholder="Search email threads..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="inspector-search-input"
                aria-label="Search email threads"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setSearchQuery("")}
                >
                  ×
                </button>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="email-inbox-select"
                style={{ height: 34, fontSize: 12 }}
              >
                <option value="all">All Statuses</option>
                <option value="new">New</option>
                <option value="draft_ready">Draft Ready</option>
                <option value="waiting_approval">Needs Approval</option>
                <option value="answered">Answered</option>
              </select>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                className="email-inbox-select"
                style={{ height: 34, fontSize: 12 }}
              >
                <option value="all">All Priorities</option>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="normal">Normal</option>
              </select>
            </div>
          </div>

          {/* Threads Scroll List */}
          <div className="email-inbox-threads-scroll">
            {threads.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "#64748b" }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
                <strong style={{ display: "block", marginBottom: 4 }}>No emails in {folder}</strong>
                <small>Incoming messages will appear here automatically.</small>
              </div>
            ) : (
              threads.map((t) => {
                const isSelected = t.id === selectedThreadId;
                return (
                  <div
                    key={t.id}
                    onClick={() => setSelectedThreadId(t.id)}
                    className={`email-inbox-thread-card ${isSelected ? "active" : ""} ${t.unreadCount > 0 ? "unread" : ""}`}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 13, fontWeight: t.unreadCount > 0 ? 700 : 600, color: "#0f172a" }}>
                        {t.isVip && <span style={{ color: "#eab308", marginRight: 4 }}>★</span>}
                        {t.customerName || t.customerEmail}
                      </span>
                      <small style={{ fontSize: 11, color: "#64748b" }}>
                        {new Date(t.lastMessageAt).toLocaleDateString()}
                      </small>
                    </div>

                    <div style={{ fontSize: 13, color: "#334155", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.subject}
                    </div>

                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                      <span
                        className={`automation-status-btn ${
                          t.status === "answered" ? "active" : t.status === "draft_ready" ? "paused" : ""
                        }`}
                        style={{ fontSize: 10, padding: "2px 8px", cursor: "default" }}
                      >
                        <span className="automation-status-dot" />
                        {t.status === "draft_ready"
                          ? "AI Draft Ready"
                          : t.status.replace("_", " ")}
                      </span>

                      {t.priority === "urgent" && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#dc2626", background: "#fef2f2", padding: "2px 6px", borderRadius: 4 }}>
                          Urgent
                        </span>
                      )}
                      {t.priority === "high" && (
                        <span style={{ fontSize: 10, fontWeight: 600, color: "#d97706", background: "#fffbeb", padding: "2px 6px", borderRadius: 4 }}>
                          High
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Active Thread Detail & Messages Timeline */}
        <div className="email-inbox-detail-col">
          {!activeThread ? (
            <div className="email-inbox-empty-detail">
              <div style={{ fontSize: 44, marginBottom: 12 }}>✉️</div>
              <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 700, color: "#0f172a" }}>
                Select an email thread
              </h3>
              <p style={{ margin: 0, fontSize: 13, maxWidth: 360, lineHeight: 1.5 }}>
                Choose a conversation from the list to view history, review AI-generated drafts, or send a reply.
              </p>
            </div>
          ) : (
            <>
              {/* Thread Header */}
              <div className="email-inbox-detail-header">
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0f172a" }}>
                      {activeThread.subject}
                    </h2>
                    {activeThread.isVip && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "#fef3c7", padding: "2px 8px", borderRadius: 999 }}>
                        ★ VIP
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    From: <strong>{activeThread.customerName || activeThread.customerEmail}</strong> &lt;{activeThread.customerEmail}&gt;
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="automation-action-btn"
                    onClick={handleToggleTakeover}
                    title="Toggle manual operator takeover vs autonomous AI handling"
                  >
                    {activeThread.isHumanTakeover ? "Return to AI" : "Take Over"}
                  </button>
                  <button
                    type="button"
                    className="automation-action-btn"
                    onClick={handleToggleVip}
                    title="Toggle client VIP status"
                  >
                    {activeThread.isVip ? "★ VIP Customer" : "☆ Make VIP"}
                  </button>
                </div>
              </div>

              {/* Collision Protection Warning */}
              {activeThread.lockedByUserId && (
                <div style={{ margin: "12px 22px 0", padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#dc2626", fontSize: 12 }}>
                  ⚠️ Another operator is currently replying to this thread. Take care to avoid collisions.
                </div>
              )}

              {/* AI Draft Box (if draft is ready) */}
              {draftMessageId && (
                <div className="email-inbox-draft-box">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: "#92400e" }}>🤖 AI Response Draft</span>
                      {activeThread.aiConfidenceScore != null && (
                        <span style={{ fontSize: 11, fontWeight: 600, background: "#fde68a", color: "#78350f", padding: "2px 6px", borderRadius: 4 }}>
                          {Math.round(activeThread.aiConfidenceScore * 100)}% Confidence
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className="button-primary automations-action-primary"
                        style={{ fontSize: 12, padding: "5px 12px" }}
                        disabled={sending}
                        onClick={handleApproveDraft}
                      >
                        {sending ? "Sending..." : "✓ Send AI Draft"}
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        style={{ fontSize: 12, padding: "5px 10px" }}
                        onClick={() => setDraftEditing(!draftEditing)}
                      >
                        {draftEditing ? "Done" : "✏️ Edit"}
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        style={{ fontSize: 12, padding: "5px 10px" }}
                        onClick={() => {
                          setDraftMessageId(null);
                          setDraftEditing(false);
                        }}
                      >
                        Discard
                      </button>
                    </div>
                  </div>

                  {draftEditing ? (
                    <textarea
                      rows={4}
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      style={{ width: "100%", borderRadius: 6, border: "1px solid #cbd5e1", padding: 8, fontFamily: "inherit", fontSize: 13 }}
                    />
                  ) : (
                    <div style={{ fontSize: 13, color: "#451a03", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                      {draftText}
                    </div>
                  )}
                </div>
              )}

              {/* Messages Scroll Timeline */}
              <div className="email-inbox-messages-scroll">
                {messages.map((m) => {
                  const isInbound = m.direction === "inbound";
                  return (
                    <div
                      key={m.id}
                      className={`email-inbox-message-bubble ${
                        isInbound ? "inbound" : m.isAiGenerated ? "ai-generated" : "outbound"
                      }`}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(0,0,0,0.06)", paddingBottom: 6 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>
                          {isInbound ? m.fromName || m.fromAddress : m.isAiGenerated ? "🤖 AI Assistant" : "👤 Support Agent"}
                        </div>
                        <small style={{ fontSize: 11, color: "#64748b" }}>
                          {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </small>
                      </div>

                      <div style={{ fontSize: 13.5, color: "#1e293b", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                        {m.bodyText}
                      </div>

                      {m.attachments && m.attachments.length > 0 && (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                          {m.attachments.map((att, i) => (
                            <span key={i} className="automation-cron-pill" style={{ fontSize: 11 }}>
                              📎 {att.filename} ({Math.round(att.sizeBytes / 1024)} KB)
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Composer */}
              <form onSubmit={handleSendReply} className="email-inbox-composer">
                <textarea
                  placeholder={`Write a reply to ${activeThread.customerName || activeThread.customerEmail}...`}
                  value={replyText}
                  onFocus={onReplyFocus}
                  onChange={(e) => setReplyText(e.target.value)}
                />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <small style={{ color: "#64748b", fontSize: 11.5 }}>
                    Typing will temporarily lock this thread to prevent collisions.
                  </small>
                  <button
                    type="submit"
                    className="button-primary automations-action-primary"
                    disabled={sending || !replyText.trim()}
                    style={{ fontSize: 13, padding: "7px 18px" }}
                  >
                    {sending ? "Sending..." : "Send Reply"}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
