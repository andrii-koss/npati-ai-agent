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
  status?: "connected" | "pending" | "auth_error" | "imap_error" | "smtp_error" | "dns_error" | "disabled";
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
  ccAddresses?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  attachments?: Array<{ filename: string; contentType: string; sizeBytes: number; url?: string; contentBase64?: string }>;
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
  lastActivityAt?: string | null;
  previousThreadsCount?: number;
}

function sanitizeEmailHtml(rawHtml: string): string {
  const source = new DOMParser().parseFromString(rawHtml, "text/html");
  const target = document.implementation.createHTMLDocument("");
  const allowedTags = new Set([
    "a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "i", "li", "ol", "p", "pre", "span", "strong", "sub", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
  ]);
  const blockedTags = new Set(["base", "embed", "form", "iframe", "input", "link", "math", "meta", "object", "script", "style", "svg", "textarea"]);

  const copyNode = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) return target.createTextNode(node.textContent || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (blockedTags.has(tag)) return null;
    const children = Array.from(element.childNodes).map(copyNode).filter((child): child is Node => child !== null);
    if (!allowedTags.has(tag)) {
      const fragment = target.createDocumentFragment();
      children.forEach((child) => fragment.appendChild(child));
      return fragment;
    }
    const clean = target.createElement(tag);
    if (tag === "a") {
      const href = element.getAttribute("href")?.trim();
      if (href && /^https?:\/\//i.test(href)) {
        clean.setAttribute("href", "#");
        clean.setAttribute("data-email-url", href);
        clean.setAttribute("rel", "noopener noreferrer nofollow");
      }
    }
    if ((tag === "td" || tag === "th") && /^\d{1,2}$/.test(element.getAttribute("colspan") || "")) {
      clean.setAttribute("colspan", element.getAttribute("colspan")!);
    }
    children.forEach((child) => clean.appendChild(child));
    return clean;
  };

  Array.from(source.body.childNodes).map(copyNode).filter((node): node is Node => node !== null)
    .forEach((node) => target.body.appendChild(node));
  return target.body.innerHTML;
}

interface CustomerContext {
  previousThreads: Array<{ id: string; subject: string; status: string; priority: string; lastMessageAt: string }>;
  tasks: Array<{ id: string; task: string; status: string; createdAt: string }>;
}

interface EmailNotification {
  id: string;
  threadId?: string | null;
  notificationType: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}

interface EmailAuditEntry {
  id: string;
  action: string;
  userId: string;
  details: Record<string, unknown>;
  createdAt: string;
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

async function fileToEmailAttachment(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
  return {
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    contentBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
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
  const [customerContext, setCustomerContext] = useState<CustomerContext>({ previousThreads: [], tasks: [] });
  const [notifications, setNotifications] = useState<EmailNotification[]>([]);
  const [auditHistory, setAuditHistory] = useState<EmailAuditEntry[]>([]);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");

  // Composer State
  const [replyText, setReplyText] = useState("");
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const [composerMode, setComposerMode] = useState<"reply" | "reply_all" | "forward">("reply");
  const [forwardTo, setForwardTo] = useState("");
  const [draftEditing, setDraftEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftMessageId, setDraftMessageId] = useState<string | null>(null);
  const [draftIsAiGenerated, setDraftIsAiGenerated] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // New outbound message composer
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeAccountId, setComposeAccountId] = useState("");
  const [composeTo, setComposeTo] = useState("");
  const [composeCc, setComposeCc] = useState("");
  const [composeBcc, setComposeBcc] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeFiles, setComposeFiles] = useState<File[]>([]);
  const [composeSending, setComposeSending] = useState(false);

  function openCompose() {
    setComposeAccountId(selectedAccountId !== "all" ? selectedAccountId : accounts[0]?.id || "");
    setComposeTo(""); setComposeCc(""); setComposeBcc(""); setComposeSubject(""); setComposeBody(""); setComposeFiles([]);
    setComposeOpen(true);
  }

  async function submitCompose(isDraft: boolean) {
    if (!selectedCompanyId || !composeAccountId) {
      setNotice("Connect or select a company email account first.");
      return;
    }
    const splitAddresses = (value: string) => value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
    setComposeSending(true);
    try {
      const attachments = await Promise.all(composeFiles.map(fileToEmailAttachment));
      const result = await api<{ thread: EmailThread; status: "draft" | "queued" | "simulated_send" }>(
        `/companies/${selectedCompanyId}/email-inbox/compose`,
        {
          method: "POST",
          body: JSON.stringify({
            accountId: composeAccountId,
            toAddresses: splitAddresses(composeTo), ccAddresses: splitAddresses(composeCc), bccAddresses: splitAddresses(composeBcc),
            subject: composeSubject, bodyText: composeBody, isDraft, attachments,
          }),
        }
      );
      setComposeOpen(false);
      setFolder(isDraft ? "drafts" : "sent");
      setSelectedAccountId(composeAccountId);
      setSelectedThreadId(result.thread.id);
      setNotice(isDraft ? "Draft saved." : result.status === "simulated_send" ? "Test Mode: email was simulated and not sent externally." : "Email queued for SMTP delivery.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setComposeSending(false);
    }
  }

  async function openInspectedLink(url: string, senderEmail?: string) {
    const inspected = await api<{ check: { requiresHumanApproval: boolean; warnings: string[] } }>(
      `/companies/${selectedCompanyId}/email-inbox/inspect-link`,
      { method: "POST", body: JSON.stringify({ url, senderEmail }) }
    );
    if (inspected.check.requiresHumanApproval) {
      const approved = await confirmModal({
        title: "Open external link?",
        message: inspected.check.warnings.join(" ") || "This link requires human approval.",
        isDanger: true,
      });
      if (!approved) return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function openAttachment(attachment: NonNullable<EmailMessage["attachments"]>[number]) {
    if (attachment.contentBase64) {
      const binary = atob(attachment.contentBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.contentType }));
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = attachment.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } else if (attachment.url) {
      if (attachment.url.startsWith("/api/")) {
        const headers = new Headers();
        const token = getStoredAuthToken();
        if (token) headers.set("authorization", `Bearer ${token}`);
        const response = await fetch(attachment.url, { headers });
        if (!response.ok) throw new Error(`Attachment download failed (${response.status}).`);
        const objectUrl = URL.createObjectURL(await response.blob());
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = attachment.filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      } else {
        await openInspectedLink(attachment.url, activeThread?.customerEmail);
      }
    } else {
      setNotice("Attachment content is not available for download.");
    }
  }

  // Load companies
  useEffect(() => {
    api<{ companies: Company[] }>("/companies")
      .then((res) => {
        setCompanies(res.companies);
        const requested = searchParams.get("company");
        const sel = requested && res.companies.some((company) => company.id === requested) ? requested : res.companies[0]?.id ?? "";
        setSelectedCompanyId(sel);
      })
      .catch((e) => setNotice(e.message));
  }, []);

  // Load accounts when company changes
  useEffect(() => {
    if (!selectedCompanyId) return;
    Promise.all([
      api<{ accounts: EmailAccount[] }>(`/companies/${selectedCompanyId}/email-accounts`),
      api<{ notifications: EmailNotification[] }>(`/companies/${selectedCompanyId}/email-inbox/notifications`),
    ])
      .then(([accountResult, notificationResult]) => {
        setAccounts(accountResult.accounts);
        setNotifications(notificationResult.notifications);
        const requestedAccount = searchParams.get("account");
        const initialAccount = requestedAccount && accountResult.accounts.some((account) => account.id === requestedAccount)
          ? requestedAccount
          : accountResult.accounts[0]?.id;
        if (initialAccount) setComposeAccountId(initialAccount);
        if (searchParams.get("compose") === "1") {
          setComposeOpen(true);
          setSearchParams({ company: selectedCompanyId }, { replace: true });
        }
      })
      .catch(() => undefined);
  }, [selectedCompanyId]);

  async function openNotification(notification: EmailNotification) {
    if (notification.threadId) setSelectedThreadId(notification.threadId);
    if (!notification.isRead) {
      await api(`/companies/${selectedCompanyId}/email-inbox/notifications/${notification.id}/read`, { method: "PATCH" });
      setNotifications((items) => items.map((item) => item.id === notification.id ? { ...item, isRead: true } : item));
    }
  }

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
      setCustomerContext({ previousThreads: [], tasks: [] });
      setAuditHistory([]);
      return;
    }

    Promise.all([
      api<{ thread: EmailThread; messages: EmailMessage[]; contact: ContactDetails | null; customerContext: CustomerContext }>(
        `/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}`
      ),
      api<{ logs: EmailAuditEntry[] }>(
        `/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}/audit`
      ).catch(() => ({ logs: [] })),
    ])
      .then(([res, audit]) => {
        setActiveThread(res.thread);
        setMessages(res.messages);
        setContact(res.contact);
        setCustomerContext(res.customerContext || { previousThreads: [], tasks: [] });
        setAuditHistory(audit.logs);

        const draft = res.messages.find((m) => m.isDraft);
        if (draft) {
          setDraftMessageId(draft.id);
          setDraftText(draft.bodyText);
          setDraftIsAiGenerated(draft.isAiGenerated);
        } else {
          setDraftMessageId(null);
          setDraftText("");
          setDraftIsAiGenerated(false);
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

  async function updateActiveThread(patch: Partial<Pick<EmailThread, "priority" | "status" | "folder">>) {
    if (!selectedCompanyId || !selectedThreadId) return;
    try {
      const response = await api<{ thread: EmailThread }>(
        `/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}`,
        { method: "PATCH", body: JSON.stringify(patch) }
      );
      if (patch.folder && patch.folder !== folder) {
        setThreads((current) => current.filter((thread) => thread.id !== response.thread.id));
        setSelectedThreadId(null);
        setActiveThread(null);
        setMessages([]);
      } else {
        setActiveThread(response.thread);
        setThreads((current) => current.map((thread) => thread.id === response.thread.id ? response.thread : thread));
      }
    } catch (error: any) {
      setNotice(error.message);
    }
  }

  async function deleteActiveThread() {
    if (!selectedCompanyId || !selectedThreadId) return;
    const approved = await confirmModal({
      title: "Delete email thread?",
      message: "This permanently deletes the thread and all of its messages.",
      confirmText: "Delete",
      isDanger: true,
    });
    if (!approved) return;
    try {
      await api(`/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}`, { method: "DELETE" });
      setSelectedThreadId(null); setActiveThread(null); setMessages([]);
      await loadThreads();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  // Handle Send Reply
  async function handleSendReply(e: FormEvent) {
    e.preventDefault();
    if (!selectedCompanyId || !selectedThreadId || !replyText.trim()) return;

    setSending(true);
    try {
      const latestInbound = [...messages].reverse().find((message) => message.direction === "inbound");
      const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
      const ownAddresses = new Set(accounts.map((account) => account.emailAddress.toLowerCase()));
      const replyAllCc = composerMode === "reply_all"
        ? [...(latestInbound?.toAddresses || []), ...(latestInbound?.ccAddresses || [])]
            .filter((address, index, all) => !ownAddresses.has(address.toLowerCase()) && all.indexOf(address) === index)
        : [];
      const toAddresses = composerMode === "forward"
        ? forwardTo.split(",").map((value) => value.trim()).filter(Boolean)
        : undefined;
      if (composerMode === "forward" && !toAddresses?.length) throw new Error("Enter at least one forwarding recipient.");
      const attachments = await Promise.all(replyFiles.map(fileToEmailAttachment));
      await api(`/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          bodyText: replyText,
          isDraft: false,
          toAddresses,
          ccAddresses: replyAllCc,
          subject: composerMode === "forward" ? `Fwd: ${activeThread?.subject || ""}` : undefined,
          fromAddress: selectedAccount?.emailAddress,
          attachments,
        }),
      });
      setReplyText("");
      setReplyFiles([]);
      setForwardTo("");
      setComposerMode("reply");
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
              className="button-primary automations-action-primary"
              onClick={openCompose}
              disabled={accounts.length === 0}
              title={accounts.length ? "Write and send a new email" : "Add an email account before composing"}
            >
              + Compose Email
            </button>
            <Link
              to="/settings/email"
              className="button-secondary automations-action-primary"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              ⚙️ Email Settings
            </Link>
            <button
              type="button"
              className="automation-action-btn"
              onClick={handleSimulateEmail}
              title="Process a simulated inbound client email without an external mailbox"
            >
              Simulate inbound
            </button>
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

      {notifications.some((item) => !item.isRead) && (
        <section className="workspace-notice" style={{ marginBottom: 16 }} aria-label="Email notifications">
          <strong>Email notifications</strong>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {notifications.filter((item) => !item.isRead).slice(0, 5).map((item) => (
              <button key={item.id} type="button" className="automation-action-btn" onClick={() => void openNotification(item)} title={item.body}>
                {item.title}
              </button>
            ))}
          </div>
        </section>
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
                  <select
                    className="email-inbox-select"
                    aria-label="Thread priority"
                    value={activeThread.priority}
                    onChange={(e) => void updateActiveThread({ priority: e.target.value as EmailThread["priority"] })}
                    style={{ width: 112 }}
                  >
                    <option value="low">Low</option><option value="normal">Normal</option>
                    <option value="high">High</option><option value="urgent">Urgent</option>
                  </select>
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
                  <button type="button" className="automation-action-btn" onClick={() => void updateActiveThread({ folder: "archived" })}>
                    Archive
                  </button>
                  <button type="button" className="automation-action-btn danger" onClick={() => void deleteActiveThread()}>
                    Delete
                  </button>
                </div>
              </div>

              <section style={{ margin: "12px 22px 0", padding: 14, border: "1px solid #e2e8f0", borderRadius: 10, background: "#f8fafc" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                  <div>
                    <strong style={{ display: "block", color: "#0f172a" }}>Customer Card</strong>
                    <span style={{ fontSize: 12, color: "#475569" }}>{contact?.name || activeThread.customerName || "Unknown customer"} · {activeThread.customerEmail}</span>
                    {contact?.companyName && <span style={{ display: "block", fontSize: 12, color: "#475569" }}>{contact.companyName}</span>}
                    {contact?.phone && <span style={{ display: "block", fontSize: 12, color: "#475569" }}>{contact.phone}</span>}
                    {contact?.notes && <p style={{ margin: "6px 0 0", fontSize: 12, color: "#334155" }}>{contact.notes}</p>}
                  </div>
                  <div style={{ display: "flex", gap: 18, fontSize: 12, color: "#475569" }}>
                    <span><strong>{contact?.previousThreadsCount ?? customerContext.previousThreads.length}</strong><br />previous emails</span>
                    <span><strong>{customerContext.tasks.length}</strong><br />related Tasks</span>
                    <span><strong>{contact?.lastActivityAt ? new Date(contact.lastActivityAt).toLocaleDateString() : "—"}</strong><br />last activity</span>
                  </div>
                </div>
                {(customerContext.previousThreads.length > 0 || customerContext.tasks.length > 0) && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Previous interactions and Tasks</summary>
                    <div style={{ display: "grid", gap: 5, marginTop: 7, fontSize: 11.5, color: "#475569" }}>
                      {customerContext.previousThreads.map((item) => <span key={item.id}>Email · {item.subject} · {item.status} · {item.priority}</span>)}
                      {customerContext.tasks.map((item) => <span key={item.id}>Task · {item.task.slice(0, 120)} · {item.status}</span>)}
                    </div>
                  </details>
                )}
              </section>

              {/* Collision Protection Warning */}
              {activeThread.lockedByUserId && (
                <div style={{ margin: "12px 22px 0", padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#dc2626", fontSize: 12 }}>
                  ⚠️ Another operator is currently replying to this thread. Take care to avoid collisions.
                </div>
              )}

              {/* Draft review box */}
              {draftMessageId && (
                <div className="email-inbox-draft-box">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: "#92400e" }}>{draftIsAiGenerated ? "🤖 AI Response Draft" : "Saved Email Draft"}</span>
                      {draftIsAiGenerated && activeThread.aiConfidenceScore != null && (
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
                        {sending ? "Sending..." : draftIsAiGenerated ? "✓ Send AI Draft" : "Send Draft"}
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

                      {m.bodyHtml ? (
                        <div
                          className="email-sanitized-html"
                          style={{ fontSize: 13.5, color: "#1e293b", lineHeight: 1.55 }}
                          onClick={(event) => {
                            const anchor = (event.target as Element).closest("a[data-email-url]") as HTMLAnchorElement | null;
                            if (!anchor) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const url = anchor.dataset.emailUrl;
                            if (url) void openInspectedLink(url, m.fromAddress);
                          }}
                          dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(m.bodyHtml) }}
                        />
                      ) : (
                        <div style={{ fontSize: 13.5, color: "#1e293b", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                          {m.bodyText.split(/(https?:\/\/[^\s<>"')]+)/gi).map((part, index) =>
                            /^https?:\/\//i.test(part) ? (
                              <button
                                key={`${m.id}-link-${index}`}
                                type="button"
                                onClick={() => void openInspectedLink(part, m.fromAddress)}
                                style={{ border: 0, padding: 0, background: "none", color: "#2563eb", textDecoration: "underline", cursor: "pointer", font: "inherit" }}
                              >
                                {part}
                              </button>
                            ) : part
                          )}
                        </div>
                      )}

                      {m.attachments && m.attachments.length > 0 && (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                          {m.attachments.map((att, i) => (
                            <button key={i} type="button" className="automation-cron-pill" style={{ fontSize: 11, cursor: "pointer" }} onClick={() => openAttachment(att)}>
                              📎 {att.filename} ({Math.round(att.sizeBytes / 1024)} KB)
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {auditHistory.length > 0 && (
                <details style={{ padding: "8px 14px", borderTop: "1px solid #e2e8f0", background: "#f8fafc" }}>
                  <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#334155" }}>
                    Thread history ({auditHistory.length})
                  </summary>
                  <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                    {auditHistory.map((entry) => (
                      <div key={entry.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11.5, color: "#475569" }}>
                        <span><strong>{entry.action.replace(/^email\./, "").replaceAll("_", " ")}</strong> · {entry.userId}</span>
                        <time>{new Date(entry.createdAt).toLocaleString()}</time>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Composer */}
              <form onSubmit={handleSendReply} className="email-inbox-composer">
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  {(["reply", "reply_all", "forward"] as const).map((modeOption) => (
                    <button key={modeOption} type="button" className={`automation-action-btn ${composerMode === modeOption ? "active" : ""}`} onClick={() => setComposerMode(modeOption)}>
                      {modeOption === "reply" ? "Reply" : modeOption === "reply_all" ? "Reply All" : "Forward"}
                    </button>
                  ))}
                </div>
                {composerMode === "forward" && (
                  <input
                    type="text"
                    placeholder="Forward to (comma-separated email addresses)"
                    value={forwardTo}
                    onChange={(e) => setForwardTo(e.target.value)}
                    style={{ width: "100%", marginBottom: 8, border: "1px solid #cbd5e1", borderRadius: 6, padding: "8px 10px" }}
                  />
                )}
                <textarea
                  placeholder={`Write a reply to ${activeThread.customerName || activeThread.customerEmail}...`}
                  value={replyText}
                  onFocus={onReplyFocus}
                  onChange={(e) => setReplyText(e.target.value)}
                />
                <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0", fontSize: 12, color: "#475569" }}>
                  <span>Attach files</span>
                  <input
                    type="file"
                    multiple
                    onChange={(event) => {
                      const files = Array.from(event.target.files || []);
                      if (files.some((file) => file.size > 10 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) {
                        setNotice("Each attachment must be at most 10 MB and the total at most 25 MB.");
                        event.target.value = "";
                        return;
                      }
                      setReplyFiles(files);
                    }}
                  />
                  {replyFiles.length > 0 && <span>{replyFiles.length} selected</span>}
                </label>
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

      {composeOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => !composeSending && setComposeOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(event) => event.stopPropagation()} aria-label="Compose email">
            <header>
              <div><span>Email / AI Inbox</span><h2>Compose Email</h2></div>
              <button type="button" className="company-drawer-close" aria-label="Close composer" onClick={() => setComposeOpen(false)} disabled={composeSending}>×</button>
            </header>
            <form onSubmit={(event) => { event.preventDefault(); void submitCompose(false); }}>
              <section>
                <h3>Sender and recipients</h3>
                <label>
                  <span>From</span>
                  <select value={composeAccountId} onChange={(event) => setComposeAccountId(event.target.value)} required>
                    <option value="">Select an email account</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.displayName ? `${account.displayName} — ` : ""}{account.emailAddress}{account.testMode ? " (Test Mode)" : account.status && account.status !== "connected" ? ` (${account.status.replaceAll("_", " ")})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label><span>To</span><input type="text" value={composeTo} onChange={(event) => setComposeTo(event.target.value)} placeholder="client@example.com, second@example.com" required /></label>
                <label><span>CC</span><input type="text" value={composeCc} onChange={(event) => setComposeCc(event.target.value)} placeholder="Optional, comma-separated" /></label>
                <label><span>BCC</span><input type="text" value={composeBcc} onChange={(event) => setComposeBcc(event.target.value)} placeholder="Optional, comma-separated" /></label>
              </section>
              <section>
                <h3>Message</h3>
                <label><span>Subject</span><input value={composeSubject} onChange={(event) => setComposeSubject(event.target.value)} maxLength={998} required /></label>
                <label><span>Body</span><textarea value={composeBody} onChange={(event) => setComposeBody(event.target.value)} rows={12} placeholder="Write your email…" required /></label>
                <label>
                  <span>Attachments</span>
                  <input
                    type="file"
                    multiple
                    onChange={(event) => {
                      const files = Array.from(event.target.files || []);
                      if (files.some((file) => file.size > 10 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) {
                        setNotice("Each attachment must be at most 10 MB and the total at most 25 MB.");
                        event.target.value = "";
                        return;
                      }
                      setComposeFiles(files);
                    }}
                  />
                </label>
                {composeFiles.length > 0 && <small>{composeFiles.map((file) => file.name).join(", ")}</small>}
                {accounts.find((account) => account.id === composeAccountId)?.testMode && (
                  <div className="workspace-notice">Test Mode is enabled for this account. Send will run the full flow without external SMTP delivery.</div>
                )}
              </section>
              <footer>
                <button type="button" className="button-secondary" disabled={composeSending || !composeAccountId || !composeTo.trim() || !composeSubject.trim() || !composeBody.trim()} onClick={() => void submitCompose(true)}>
                  Save Draft
                </button>
                <button type="submit" className="button-primary" disabled={composeSending || !composeAccountId || !composeTo.trim() || !composeSubject.trim() || !composeBody.trim()}>
                  {composeSending ? "Sending…" : "Send Email"}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}
    </main>
  );
}
