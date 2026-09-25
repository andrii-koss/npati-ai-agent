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

function getStatusLabel(status: EmailThread["status"]): string {
  switch (status) {
    case "draft_ready":
      return "AI Draft Ready";
    case "waiting_approval":
      return "waiting approval";
    case "waiting_customer":
      return "waiting customer";
    case "waiting_human":
      return "waiting human";
    case "ai_processing":
      return "AI processing";
    case "answered":
      return "answered";
    case "closed":
      return "closed";
    case "failed":
      return "failed";
    case "new":
      return "new";
    default:
      return (status as string).replace("_", " ");
  }
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
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("personal");
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

  // Layout & Resizing Controls
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [readingFocus, setReadingFocus] = useState(false);
  const [threadsWidth, setThreadsWidth] = useState<number>(300);
  const [isResizing, setIsResizing] = useState(false);
  const [customerCardExpanded, setCustomerCardExpanded] = useState(false);
  const [threadHeaderExpanded, setThreadHeaderExpanded] = useState(false);
  const [draftExpanded, setDraftExpanded] = useState(true);

  // Thread History vertical resizing
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyHeight, setHistoryHeight] = useState(140);
  const [isResizingHistory, setIsResizingHistory] = useState(false);

  const startHistoryResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingHistory(true);
  };

  useEffect(() => {
    if (!isResizingHistory) return;
    const handleMouseMove = (e: MouseEvent) => {
      const composerEl = document.querySelector(".email-inbox-composer");
      if (!composerEl) return;
      const composerRect = composerEl.getBoundingClientRect();
      const newHeight = composerRect.top - e.clientY;
      if (newHeight >= 60 && newHeight <= 450) {
        setHistoryHeight(newHeight);
      }
    };
    const handleMouseUp = () => {
      setIsResizingHistory(false);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizingHistory]);

  const startResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const card = document.querySelector(".email-inbox-card");
      if (!card) return;
      const cardRect = card.getBoundingClientRect();
      const sidebarWidth = sidebarCollapsed ? 58 : 190;
      const newWidth = e.clientX - cardRect.left - sidebarWidth;
      if (newWidth >= 220 && newWidth <= 520) {
        setThreadsWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, sidebarCollapsed]);

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
        const sel = requested === "personal" || (requested && res.companies.some((company) => company.id === requested)) ? requested : "personal";
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
            <Link
              to={`/settings/email?company=${encodeURIComponent(selectedCompanyId)}`}
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
              Simulate Inbound
            </button>
          </div>
        </div>
      </header>

      {/* Mailbox Scope & Quick Actions Toolbar matching EmailSettingsPage */}
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
          <button
            type="button"
            className="email-compose-btn"
            onClick={openCompose}
            disabled={accounts.length === 0}
            title={accounts.length ? "Write and send a new email" : "Add an email account before composing"}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span>+ Compose Email</span>
          </button>
        </div>
      </div>

      {notice && (
        <div className="workspace-notice" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>ℹ️</span>
            <span>{notice}</span>
          </div>
          <button
            type="button"
            className="workspace-notice-close"
            onClick={() => setNotice(null)}
            aria-label="Dismiss notice"
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

      {/* 3-Column Unified Inbox Card with Resizing & Collapse */}
      <div
        className={`email-inbox-card ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${readingFocus ? "reading-focus" : ""}`}
        style={{ "--inbox-threads-w": `${threadsWidth}px` } as React.CSSProperties}
      >
        {/* Left Column: Folders & Accounts */}
        <aside className={`email-inbox-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <div className="email-inbox-sidebar-header">
            {!sidebarCollapsed && <span className="email-inbox-label">Account</span>}
            <button
              type="button"
              className="email-sidebar-toggle-btn"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? "Expand folders sidebar" : "Collapse folders sidebar"}
              aria-label={sidebarCollapsed ? "Expand folders sidebar" : "Collapse folders sidebar"}
            >
              {sidebarCollapsed ? "▶" : "◀"}
            </button>
          </div>

          {!sidebarCollapsed && (
            <div>
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="email-inbox-select"
                aria-label="Filter by email account"
              >
                <option value="all">All Accounts ({accounts.length})</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName || a.emailAddress}
                  </option>
                ))}
              </select>
            </div>
          )}

          <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {!sidebarCollapsed && <span className="email-inbox-label">Folders</span>}
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
                title={f.label}
              >
                <span className="email-folder-btn-content">
                  <span className="email-folder-icon">{f.icon}</span>
                  {!sidebarCollapsed && <span>{f.label}</span>}
                </span>
                {!sidebarCollapsed && folder === f.id && threads.length > 0 && (
                  <span className="email-folder-count">({threads.length})</span>
                )}
              </button>
            ))}
          </nav>
        </aside>

        {/* Middle Column: Threads List */}
        <div className={`email-inbox-threads-col ${readingFocus ? "hidden" : ""}`}>
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
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>

            <div className="email-threads-filters-row">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="email-inbox-select filter-select"
                aria-label="Filter by status"
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
                className="email-inbox-select filter-select"
                aria-label="Filter by priority"
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
                      <span className={`email-status-pill status-${t.status}`}>
                        <span className="email-status-dot" />
                        {getStatusLabel(t.status)}
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

        {/* Draggable Divider (User can resize columns!) */}
        {!readingFocus && (
          <div
            className={`email-inbox-resizer ${isResizing ? "resizing" : ""}`}
            onMouseDown={startResizing}
            onDoubleClick={() => setThreadsWidth(300)}
            title="Drag to resize columns, double click to reset"
            role="separator"
            aria-orientation="vertical"
          >
            <div className="email-resizer-line" />
          </div>
        )}

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
              {/* Thread Header: Compact by default, expandable on click */}
              <div className={`email-inbox-detail-header ${threadHeaderExpanded ? "expanded" : "compact"}`}>
                {!threadHeaderExpanded ? (
                  /* Compact Header Bar */
                  <div className="email-header-compact-row">
                    <div className="email-header-compact-left">
                      <button
                        type="button"
                        className="email-header-toggle-btn"
                        onClick={() => setThreadHeaderExpanded(true)}
                        title="Expand full thread details and actions"
                      >
                        Details ▼
                      </button>

                      <strong
                        className="email-header-compact-subject"
                        title={activeThread.subject}
                      >
                        {activeThread.subject}
                      </strong>

                      <span className={`email-status-pill status-${activeThread.status}`} style={{ flexShrink: 0 }}>
                        <span className="email-status-dot" />
                        {getStatusLabel(activeThread.status)}
                      </span>

                      <span className="email-header-compact-sender">
                        From: {activeThread.customerName || activeThread.customerEmail}
                      </span>
                    </div>

                    <div className="email-header-compact-actions">
                      <button
                        type="button"
                        className="automation-action-btn"
                        onClick={() => void updateActiveThread({ folder: activeThread.folder === "spam" ? "inbox" : "spam" })}
                        style={{ fontSize: 11.5, padding: "3px 8px" }}
                        title="Spam"
                      >
                        {activeThread.folder === "spam" ? "Not Spam" : "Spam"}
                      </button>
                      <button
                        type="button"
                        className="automation-action-btn danger"
                        onClick={() => void deleteActiveThread()}
                        style={{ fontSize: 11.5, padding: "3px 8px" }}
                        title="Delete"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className={`email-expand-pane-btn ${readingFocus ? "active" : ""}`}
                        onClick={() => setReadingFocus(!readingFocus)}
                        style={{ fontSize: 11.5, padding: "3px 8px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                        title={readingFocus ? "Restore split view (show list)" : "Expand reading view (hide list)"}
                        aria-label={readingFocus ? "Restore split view" : "Expand reading view"}
                      >
                        {readingFocus ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M4 14h6m0 0v6m0-6L3 21m17-7h-6m0 0v6m0-6l7 7M4 10h6m0 0V4m0 6L3 3m17 7h-6m0 0V4m0 6l7-7"/></svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 3h6m0 0v6m0-6L14 10M9 21H3m0 0v-6m0 6l7-7M3 9V3m0 0h6m-6 0l7 7m11 11v-6m0 6h-6m6 0l-7-7"/></svg>
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Expanded Header */
                  <>
                    <div className="email-detail-header-top">
                      <div className="email-detail-title-area">
                        <div className="email-detail-subject-row">
                          <button
                            type="button"
                            className="email-header-toggle-btn"
                            onClick={() => setThreadHeaderExpanded(false)}
                            title="Collapse to compact header"
                          >
                            Compact ▲
                          </button>
                          <h2 className="email-detail-subject">
                            {activeThread.subject}
                          </h2>
                          {activeThread.isVip && (
                            <span className="email-vip-badge">
                              VIP
                            </span>
                          )}
                          <span className={`email-status-pill status-${activeThread.status}`}>
                            <span className="email-status-dot" />
                            {getStatusLabel(activeThread.status)}
                          </span>
                        </div>
                        <div className="email-detail-sender-row">
                          <span>
                            From: <strong>{activeThread.customerName || activeThread.customerEmail}</strong> &lt;{activeThread.customerEmail}&gt;
                          </span>
                          <span>
                            {new Date(activeThread.lastMessageAt).toLocaleString()}
                          </span>
                        </div>
                      </div>

                      <div className="email-detail-top-controls">
                        <button
                          type="button"
                          className={`email-expand-pane-btn ${readingFocus ? "active" : ""}`}
                          onClick={() => setReadingFocus(!readingFocus)}
                          title={readingFocus ? "Restore split view (show list)" : "Expand reading view (hide list)"}
                        >
                          {readingFocus ? (
                            <>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M4 14h6m0 0v6m0-6L3 21m17-7h-6m0 0v6m0-6l7 7M4 10h6m0 0V4m0 6L3 3m17 7h-6m0 0V4m0 6l7-7"/></svg>
                              <span>Split View</span>
                            </>
                          ) : (
                            <>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 3h6m0 0v6m0-6L14 10M9 21H3m0 0v-6m0 6l7-7M3 9V3m0 0h6m-6 0l7 7m11 11v-6m0 6h-6m6 0l-7-7"/></svg>
                              <span>Expand View</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Actions Toolbar */}
                    <div className="email-detail-actions-bar">
                      <div className="email-detail-actions-left">
                        <div className="email-priority-selector">
                          <span>Priority:</span>
                          <select
                            className="email-inbox-select priority-select"
                            aria-label="Thread priority"
                            value={activeThread.priority}
                            onChange={(e) => void updateActiveThread({ priority: e.target.value as EmailThread["priority"] })}
                          >
                            <option value="low">Low</option>
                            <option value="normal">Normal</option>
                            <option value="high">High</option>
                            <option value="urgent">Urgent</option>
                          </select>
                        </div>

                        <button
                          type="button"
                          className={`automation-action-btn ${activeThread.isHumanTakeover ? "active" : ""}`}
                          onClick={handleToggleTakeover}
                          title="Toggle manual operator takeover vs autonomous AI handling"
                        >
                          {activeThread.isHumanTakeover ? "Return to AI" : "Take Over"}
                        </button>

                        <button
                          type="button"
                          className={`automation-action-btn ${activeThread.isVip ? "active" : ""}`}
                          onClick={handleToggleVip}
                          title="Toggle client VIP status"
                        >
                          {activeThread.isVip ? "VIP Customer" : "Make VIP"}
                        </button>
                      </div>

                      <div className="email-detail-actions-right">
                        <button
                          type="button"
                          className="automation-action-btn"
                          onClick={() => void updateActiveThread({ folder: activeThread.folder === "archived" ? "inbox" : "archived" })}
                          title={activeThread.folder === "archived" ? "Move back to Inbox" : "Move to Archive"}
                        >
                          {activeThread.folder === "archived" ? "Unarchive" : "Archive"}
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn"
                          onClick={() => void updateActiveThread({ folder: activeThread.folder === "spam" ? "inbox" : "spam" })}
                          title={activeThread.folder === "spam" ? "Mark as Not Spam" : "Mark as Spam"}
                        >
                          {activeThread.folder === "spam" ? "Not Spam" : "Spam"}
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn danger"
                          onClick={() => void deleteActiveThread()}
                          title="Delete this conversation"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Scrollable middle body container */}
              <div className="email-inbox-detail-body">
                {/* Customer Context Card */}
                <section className="email-customer-card">
                  <div
                    className="email-customer-card-header"
                    onClick={() => setCustomerCardExpanded(!customerCardExpanded)}
                  >
                    <div className="email-customer-title-group">
                      <span>Customer Profile: {contact?.name || activeThread.customerName || "Customer"} · {activeThread.customerEmail}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div className="email-customer-stats-pills">
                        <span><strong>{contact?.previousThreadsCount ?? customerContext.previousThreads.length}</strong> previous</span>
                        <span><strong>{customerContext.tasks.length}</strong> tasks</span>
                        <span><strong>{contact?.lastActivityAt ? new Date(contact.lastActivityAt).toLocaleDateString() : "Active"}</strong></span>
                      </div>
                      <span style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>
                        {customerCardExpanded ? "▲ Hide" : "▼ Details"}
                      </span>
                    </div>
                  </div>

                  {customerCardExpanded && (
                    <div className="email-customer-card-body">
                      {contact?.companyName && <span style={{ fontSize: 12, color: "#475569" }}>Company: {contact.companyName}</span>}
                      {contact?.phone && <span style={{ fontSize: 12, color: "#475569" }}>Phone: {contact.phone}</span>}
                      {contact?.notes && <p style={{ margin: "4px 0 0", fontSize: 12, color: "#334155" }}>Notes: {contact.notes}</p>}

                      {(customerContext.previousThreads.length > 0 || customerContext.tasks.length > 0) && (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Previous interactions and Tasks</summary>
                          <div style={{ display: "grid", gap: 5, marginTop: 7, fontSize: 11.5, color: "#475569" }}>
                            {customerContext.previousThreads.map((item) => <span key={item.id}>Email · {item.subject} · {item.status} · {item.priority}</span>)}
                            {customerContext.tasks.map((item) => <span key={item.id}>Task · {item.task.slice(0, 120)} · {item.status}</span>)}
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                </section>

                {/* Collision Protection Warning */}
                {activeThread.lockedByUserId && (
                  <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#dc2626", fontSize: 12 }}>
                    ⚠️ Another operator is currently replying to this thread. Take care to avoid collisions.
                  </div>
                )}

                {/* Draft review box */}
                {draftMessageId && (
                  <div className={`email-inbox-draft-box ${!draftExpanded ? "collapsed" : ""}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                      <div
                        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}
                        onClick={() => setDraftExpanded(!draftExpanded)}
                        title={draftExpanded ? "Collapse draft preview" : "Expand draft preview"}
                      >
                        <button
                          type="button"
                          className="email-draft-toggle-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDraftExpanded(!draftExpanded);
                          }}
                          aria-label={draftExpanded ? "Collapse draft" : "Expand draft"}
                        >
                          {draftExpanded ? "▲" : "▼"}
                        </button>
                        <span style={{ fontWeight: 700, fontSize: 13, color: "#92400e" }}>
                          {draftIsAiGenerated ? "AI Response Draft" : "Saved Email Draft"}
                        </span>
                        {draftIsAiGenerated && activeThread.aiConfidenceScore != null && (
                          <span style={{ fontSize: 10.5, fontWeight: 600, background: "#fde68a", color: "#78350f", padding: "1px 6px", borderRadius: 4 }}>
                            {Math.round(activeThread.aiConfidenceScore * 100)}% Confidence
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="button-primary automations-action-primary"
                          style={{ fontSize: 11.5, padding: "4px 10px", lineHeight: 1.2 }}
                          disabled={sending}
                          onClick={handleApproveDraft}
                        >
                          {sending ? "Sending..." : draftIsAiGenerated ? "Send AI Draft" : "Send Draft"}
                        </button>
                        <button
                          type="button"
                          className="button-secondary"
                          style={{ fontSize: 11.5, padding: "4px 8px", lineHeight: 1.2 }}
                          onClick={() => {
                            setDraftExpanded(true);
                            setDraftEditing(!draftEditing);
                          }}
                        >
                          {draftEditing ? "Done" : "Edit"}
                        </button>
                        <button
                          type="button"
                          className="button-secondary"
                          style={{ fontSize: 11.5, padding: "4px 8px", lineHeight: 1.2 }}
                          onClick={() => {
                            setDraftMessageId(null);
                            setDraftEditing(false);
                          }}
                        >
                          Discard
                        </button>
                      </div>
                    </div>

                    {draftExpanded && (
                      draftEditing ? (
                        <textarea
                          rows={4}
                          value={draftText}
                          onChange={(e) => setDraftText(e.target.value)}
                          style={{ width: "100%", borderRadius: 6, border: "1px solid #cbd5e1", padding: 8, fontFamily: "inherit", fontSize: 13 }}
                        />
                      ) : (
                        <div className="email-draft-text-scroll" style={{ fontSize: 13, color: "#451a03", whiteSpace: "pre-wrap", lineHeight: 1.5, maxHeight: "200px", overflowY: "auto" }}>
                          {draftText}
                        </div>
                      )
                    )}
                  </div>
                )}

                {/* Messages Scroll Timeline */}
                <div className="email-inbox-messages-scroll">
                  {messages.length === 0 ? (
                    <div style={{ padding: "40px 20px", textAlign: "center", color: "#64748b" }}>
                      <div style={{ fontSize: 28, marginBottom: 8 }}>📬</div>
                      <strong style={{ display: "block", marginBottom: 4 }}>No messages in this thread yet</strong>
                      <small>Write a reply below to start the conversation.</small>
                    </div>
                  ) : (
                    messages.map((m) => {
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
                              {isInbound ? m.fromName || m.fromAddress : m.isAiGenerated ? "AI Assistant" : "Support Agent"}
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
                    })
                  )}
                </div>

                {/* Thread History Section with presets and resizing */}
                {auditHistory.length > 0 && (
                  <div className="email-thread-history-section">
                    <div
                      className="email-history-header"
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "8px 14px",
                        background: "#f8fafc",
                        borderTop: "1px solid #e2e8f0",
                        borderBottom: historyOpen ? "1px solid #e2e8f0" : "none",
                        userSelect: "none",
                      }}
                    >
                      <div
                        onClick={() => setHistoryOpen(!historyOpen)}
                        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flex: 1 }}
                      >
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>
                          Thread history ({auditHistory.length})
                        </span>
                        <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>
                          {historyOpen ? "▲ Hide" : "▼ Show"}
                        </span>
                      </div>

                      {historyOpen && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 11, color: "#94a3b8" }}>Size:</span>
                          <button
                            type="button"
                            className={`history-size-btn ${historyHeight === 90 ? "active" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setHistoryHeight(90);
                            }}
                            title="Compact (90px)"
                          >
                            S
                          </button>
                          <button
                            type="button"
                            className={`history-size-btn ${historyHeight === 160 ? "active" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setHistoryHeight(160);
                            }}
                            title="Medium (160px)"
                          >
                            M
                          </button>
                          <button
                            type="button"
                            className={`history-size-btn ${historyHeight === 260 ? "active" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setHistoryHeight(260);
                            }}
                            title="Large (260px)"
                          >
                            L
                          </button>
                        </div>
                      )}
                    </div>

                    {historyOpen && (
                      <div
                        className="email-history-scroll"
                        style={{
                          height: `${historyHeight}px`,
                          minHeight: "70px",
                          maxHeight: "360px",
                          resize: "vertical",
                          overflowY: "auto",
                          padding: "8px 14px",
                          background: "#ffffff",
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        {auditHistory.map((entry) => (
                          <div key={entry.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11.5, color: "#475569" }}>
                            <span><strong>{entry.action.replace(/^email\./, "").replaceAll("_", " ")}</strong> · {entry.userId}</span>
                            <time>{new Date(entry.createdAt).toLocaleString()}</time>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Composer: Always pinned at bottom */}
              <form onSubmit={handleSendReply} className="email-inbox-composer">
                <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
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
                    style={{ width: "100%", marginBottom: 6, border: "1px solid #cbd5e1", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}
                  />
                )}
                <textarea
                  placeholder={`Write a reply to ${activeThread.customerName || activeThread.customerEmail}...`}
                  value={replyText}
                  onFocus={onReplyFocus}
                  onChange={(e) => setReplyText(e.target.value)}
                  style={{ minHeight: "65px", maxHeight: "150px", resize: "vertical" }}
                />
                <div className="email-composer-footer-row" style={{ marginTop: 4 }}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#475569", cursor: "pointer", margin: 0 }}>
                    <span style={{ fontWeight: 600 }}>Attach files</span>
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
                  <button
                    type="submit"
                    className="button-primary automations-action-primary email-composer-send-btn"
                    disabled={sending || !replyText.trim()}
                    style={{ fontSize: 13, padding: "7px 20px", fontWeight: 700, marginLeft: "auto" }}
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
