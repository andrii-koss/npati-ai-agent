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

        // Find existing draft if any
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
      // Release lock
      await api(`/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}/lock`, {
        method: "POST",
        body: JSON.stringify({ action: "release" }),
      });
      // Refresh thread
      const res = await api<{ thread: EmailThread; messages: EmailMessage[] }>(
        `/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}`
      );
      setActiveThread(res.thread);
      setMessages(res.messages);
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
      // First save edited text if draft was modified
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
      // Reload
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
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 70px)", overflow: "hidden" }}>
      {/* Top Banner / Actions Bar */}
      <div style={{ padding: "12px 24px", background: "white", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h2 style={{ margin: 0, fontSize: "20px" }}>Email / AI Inbox</h2>
          {companies.length > 1 && (
            <select
              value={selectedCompanyId}
              onChange={(e) => setSelectedCompanyId(e.target.value)}
              style={{ padding: "4px 8px", borderRadius: "6px", border: "1px solid #ccc", fontSize: "13px" }}
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button type="button" className="button-secondary" onClick={handleSimulateEmail} title="Simulate incoming client email">
            ⚡ Simulate Inbound Email
          </button>
          <Link to="/settings/email" className="button-secondary">
            ⚙️ Email Settings
          </Link>
        </div>
      </div>

      {notice && (
        <div className="workspace-notice info" style={{ margin: "8px 24px" }}>
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} style={{ background: "none", border: "none", cursor: "pointer" }}>✕</button>
        </div>
      )}

      {/* 3-Column Layout */}
      <div style={{ display: "grid", gridTemplateColumns: "220px 380px 1fr", flex: 1, minHeight: 0 }}>
        {/* Left: Folders & Accounts */}
        <aside style={{ background: "#f9fafb", borderRight: "1px solid #e5e7eb", padding: "16px 12px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div>
            <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "#6b7280", letterSpacing: "0.05em" }}>
              Accounts
            </span>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              style={{ width: "100%", marginTop: "6px", padding: "6px", borderRadius: "6px", border: "1px solid #d1d5db", fontSize: "13px" }}
            >
              <option value="all">All Accounts ({accounts.length})</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.displayName || a.emailAddress}</option>
              ))}
            </select>
          </div>

          <nav style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "#6b7280", letterSpacing: "0.05em", marginBottom: "4px" }}>
              Folders
            </span>
            {(["inbox", "sent", "drafts", "archived", "spam"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFolder(f)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: "none",
                  textAlign: "left",
                  fontSize: "14px",
                  fontWeight: folder === f ? 600 : 400,
                  background: folder === f ? "#e5e7eb" : "transparent",
                  color: folder === f ? "#111827" : "#4b5563",
                  cursor: "pointer",
                }}
              >
                <span style={{ textTransform: "capitalize" }}>{f}</span>
              </button>
            ))}
          </nav>
        </aside>

        {/* Middle: Thread List */}
        <div style={{ background: "white", borderRight: "1px solid #e5e7eb", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Search & Filter pills */}
          <div style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", display: "flex", flexDirection: "column", gap: "8px" }}>
            <input
              type="text"
              placeholder="Search emails..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #d1d5db", fontSize: "13px" }}
            />
            <div style={{ display: "flex", gap: "6px" }}>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                style={{ flex: 1, padding: "4px 6px", fontSize: "12px", borderRadius: "4px", border: "1px solid #d1d5db" }}
              >
                <option value="all">All Statuses</option>
                <option value="new">New</option>
                <option value="draft_ready">Draft Ready</option>
                <option value="waiting_approval">Waiting Approval</option>
                <option value="answered">Answered</option>
              </select>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                style={{ flex: 1, padding: "4px 6px", fontSize: "12px", borderRadius: "4px", border: "1px solid #d1d5db" }}
              >
                <option value="all">All Priorities</option>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="normal">Normal</option>
              </select>
            </div>
          </div>

          {/* List items */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {threads.length === 0 ? (
              <div style={{ padding: "32px", textAlign: "center", color: "#888", fontSize: "13px" }}>
                No emails in {folder}.
              </div>
            ) : (
              threads.map((t) => {
                const isSelected = t.id === selectedThreadId;
                return (
                  <div
                    key={t.id}
                    onClick={() => setSelectedThreadId(t.id)}
                    style={{
                      padding: "12px 14px",
                      borderBottom: "1px solid #f3f4f6",
                      cursor: "pointer",
                      background: isSelected ? "#eff6ff" : t.unreadCount > 0 ? "#f9fafb" : "white",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                      <span style={{ fontWeight: t.unreadCount > 0 ? 700 : 500, fontSize: "14px", color: "#111827" }}>
                        {t.isVip && <span style={{ color: "#eab308", marginRight: "4px" }}>★</span>}
                        {t.customerName || t.customerEmail}
                      </span>
                      <span style={{ fontSize: "11px", color: "#9ca3af" }}>
                        {new Date(t.lastMessageAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                      </span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: "13px", color: "#374151", marginBottom: "3px" }}>
                      {t.subject}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "6px" }}>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          padding: "2px 6px",
                          borderRadius: "4px",
                          textTransform: "uppercase",
                          background:
                            t.priority === "urgent" ? "#fee2e2" : t.priority === "high" ? "#ffedd5" : "#f3f4f6",
                          color:
                            t.priority === "urgent" ? "#b91c1c" : t.priority === "high" ? "#c2410c" : "#4b5563",
                        }}
                      >
                        {t.priority}
                      </span>
                      <span
                        style={{
                          fontSize: "11px",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          background: t.status === "answered" ? "#dcfce7" : t.status === "draft_ready" ? "#f3e8ff" : "#fef3c7",
                          color: t.status === "answered" ? "#15803d" : t.status === "draft_ready" ? "#7e22ce" : "#b45309",
                        }}
                      >
                        {t.status.replace("_", " ")}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Thread Detail & Messages Pane */}
        {activeThread ? (
          <div style={{ background: "white", display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
            {/* Thread Header */}
            <div style={{ padding: "16px 24px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "18px" }}>{activeThread.subject}</h3>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "6px", fontSize: "13px", color: "#6b7280" }}>
                  <span>From: <strong>{activeThread.customerEmail}</strong></span>
                  <span>·</span>
                  <span>Priority: <strong style={{ textTransform: "capitalize" }}>{activeThread.priority}</strong></span>
                  {activeThread.isVip && <span style={{ color: "#ca8a04", fontWeight: 600 }}>★ VIP</span>}
                  {activeThread.isHumanTakeover && (
                    <span style={{ color: "#dc2626", fontWeight: 600, background: "#fee2e2", padding: "2px 6px", borderRadius: "4px" }}>
                      Human Takeover Active
                    </span>
                  )}
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  className={`automation-action-btn ${activeThread.isHumanTakeover ? "run-btn" : ""}`}
                  onClick={handleToggleTakeover}
                  title="Take over to pause AI auto-replies in this thread"
                >
                  {activeThread.isHumanTakeover ? "Return to AI" : "Take Over"}
                </button>
                <button
                  type="button"
                  className="automation-action-btn"
                  onClick={handleToggleVip}
                >
                  {activeThread.isVip ? "★ Remove VIP" : "☆ Mark VIP"}
                </button>
              </div>
            </div>

            {/* Collision Banner if locked by another user */}
            {activeThread.lockedByUserId && (
              <div style={{ background: "#fffbeb", borderBottom: "1px solid #fef3c7", padding: "8px 24px", fontSize: "13px", color: "#92400e" }}>
                🔒 <strong>Collision Protection Active:</strong> This thread is currently being edited. AI auto-responses are temporarily paused.
              </div>
            )}

            {/* Messages Scroll Area */}
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px" }}>
              {messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                    padding: "16px",
                    background: m.direction === "outbound" ? "#f9fafb" : "white",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                    <div>
                      <strong>{m.fromName || m.fromAddress}</strong>
                      <span style={{ fontSize: "12px", color: "#6b7280", marginLeft: "8px" }}>
                        to {m.toAddresses.join(", ")}
                      </span>
                      {m.isAiGenerated && (
                        <span className="automation-cron-pill" style={{ marginLeft: "8px", background: "#f3e8ff", color: "#7e22ce" }}>
                          AI Generated
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: "12px", color: "#9ca3af" }}>
                      {new Date(m.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", fontSize: "14px", lineHeight: "1.5", color: "#1f2937" }}>
                    {m.bodyText}
                  </div>
                  {m.attachments && m.attachments.length > 0 && (
                    <div style={{ marginTop: "12px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      {m.attachments.map((att, i) => (
                        <span key={i} style={{ border: "1px solid #d1d5db", borderRadius: "4px", padding: "4px 8px", fontSize: "12px" }}>
                          📎 {att.filename} ({Math.round(att.sizeBytes / 1024)} KB)
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {/* AI Draft Card if available */}
              {draftMessageId && (
                <div style={{ border: "2px solid #a855f7", borderRadius: "8px", padding: "16px", background: "#faf5ff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                    <div>
                      <strong style={{ color: "#7e22ce" }}>✨ AI Response Draft (Waiting for Review)</strong>
                      <div style={{ fontSize: "12px", color: "#6b7280" }}>
                        Confidence: {Math.round((activeThread.aiConfidenceScore ?? 0.88) * 100)}% · Review and approve to send.
                      </div>
                    </div>
                    <button
                      type="button"
                      className="automation-action-btn"
                      onClick={() => setDraftEditing(!draftEditing)}
                    >
                      {draftEditing ? "Cancel Edit" : "Edit Draft"}
                    </button>
                  </div>

                  {draftEditing ? (
                    <textarea
                      rows={6}
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid #d8b4fe", fontSize: "14px" }}
                    />
                  ) : (
                    <div style={{ whiteSpace: "pre-wrap", fontSize: "14px", lineHeight: "1.5", color: "#1f2937", background: "white", padding: "12px", borderRadius: "6px", border: "1px solid #f3e8ff" }}>
                      {draftText}
                    </div>
                  )}

                  <div style={{ marginTop: "12px", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                    <button
                      type="button"
                      className="button-primary"
                      disabled={sending}
                      onClick={handleApproveDraft}
                    >
                      {sending ? "Sending..." : "✓ Approve & Send Reply"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Bottom Composer */}
            {!draftMessageId && (
              <form onSubmit={handleSendReply} style={{ borderTop: "1px solid #e5e7eb", padding: "16px 24px", background: "#f9fafb" }}>
                <textarea
                  rows={3}
                  placeholder="Write a reply... (typing acquires Collision Protection lock)"
                  value={replyText}
                  onFocus={onReplyFocus}
                  onChange={(e) => setReplyText(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid #d1d5db", fontSize: "14px", resize: "vertical" }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "8px" }}>
                  <button type="submit" className="button-primary" disabled={sending || !replyText.trim()}>
                    {sending ? "Sending..." : "Send Reply"}
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <div style={{ display: "grid", placeItems: "center", color: "#9ca3af" }}>
            Select an email to view the conversation.
          </div>
        )}
      </div>
    </div>
  );
}
