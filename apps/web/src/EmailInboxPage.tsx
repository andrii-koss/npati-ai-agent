import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { chooseAvailableCompanyId, getInitialCompanyScope, readCachedCompanies, writeActiveCompanyId, writeCachedCompanies } from "./active-company";
import { useWorkspace } from "./BusinessWorkspace";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";

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
  messagesCount?: number;
  aiConfidenceScore?: number | null;
  aiClassificationSummary?: string | null;
  detectedLanguage?: string | null;
}

interface EmailAttachmentView {
  filename: string;
  contentType: string;
  sizeBytes: number;
  url?: string;
  contentBase64?: string;
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
  attachments?: EmailAttachmentView[];
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

function getStatusLabel(status: EmailThread["status"], t: (key: string) => string): string {
  switch (status) {
    case "draft_ready":
      return t("emailInbox.statuses.draft_ready");
    case "waiting_approval":
      return t("emailInbox.statuses.waiting_approval");
    case "waiting_customer":
      return t("emailInbox.statuses.waiting_customer");
    case "waiting_human":
      return t("emailInbox.statuses.waiting_human");
    case "ai_processing":
      return t("emailInbox.statuses.ai_processing");
    case "answered":
      return t("emailInbox.statuses.answered");
    case "closed":
      return t("emailInbox.statuses.closed");
    case "failed":
      return t("emailInbox.statuses.failed");
    case "new":
      return t("emailInbox.statuses.new");
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
  const method = (init?.method || "GET").toUpperCase();
  const response = await fetch(`/api${path}`, {
    ...init,
    headers,
    cache: init?.cache || (method === "GET" ? "no-store" : undefined),
  });
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

function EmailImageAttachment({
  attachment,
  onPreview,
  onFallbackOpen,
}: {
  attachment: EmailAttachmentView;
  onPreview: (source: string, filename: string) => void;
  onFallbackOpen: () => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string | null>(
    attachment.contentBase64 ? `data:${attachment.contentType};base64,${attachment.contentBase64}` : null
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (attachment.contentBase64 || !attachment.url) return;
    let active = true;
    let objectUrl: string | null = null;
    const headers = new Headers();
    const token = getStoredAuthToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    fetch(attachment.url, { headers, cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`Image load failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.contentBase64, attachment.url]);

  if (failed || (!source && !attachment.url)) {
    return (
      <button type="button" className="automation-cron-pill" onClick={onFallbackOpen}>
        📎 {attachment.filename}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="email-image-attachment"
      onClick={() => source && onPreview(source, attachment.filename)}
      disabled={!source}
      title={source ? `${t("emailInbox.messagesTimeline.openImagePrefix")}${attachment.filename}` : t("emailInbox.messagesTimeline.loadingImage")}
    >
      {source ? <img src={source} alt={attachment.filename} /> : <span>{t("emailInbox.messagesTimeline.loadingImage")}</span>}
      <small>{attachment.filename}</small>
    </button>
  );
}

export function EmailInboxPage() {
  const { t, language } = useTranslation();
  const { overview } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [companies, setCompanies] = useState<Company[]>(readCachedCompanies);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>(() => {
    const requested = searchParams.get("company");
    return getInitialCompanyScope(requested);
  });
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("all");

  const [folder, setFolder] = useState<"inbox" | "sent" | "drafts" | "archived" | "spam">("inbox");
  const [folderCounts, setFolderCounts] = useState<Record<"inbox" | "sent" | "drafts" | "archived" | "spam", number>>({
    inbox: 0, sent: 0, drafts: 0, archived: 0, spam: 0,
  });
  const [threads, setThreads] = useState<EmailThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<EmailThread | null>(null);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [contact, setContact] = useState<ContactDetails | null>(null);
  const [customerContext, setCustomerContext] = useState<CustomerContext>({ previousThreads: [], tasks: [] });
  const [notifications, setNotifications] = useState<EmailNotification[]>([]);
  const [auditHistory, setAuditHistory] = useState<EmailAuditEntry[]>([]);
  const [mailboxRefreshVersion, setMailboxRefreshVersion] = useState(0);
  const [threadOpenVersion, setThreadOpenVersion] = useState(0);
  const [imagePreview, setImagePreview] = useState<{ source: string; filename: string } | null>(null);
  const threadRequestIdRef = useRef(0);
  const deletedThreadIdsRef = useRef(new Set<string>());
  const messageScrollRef = useRef<HTMLDivElement | null>(null);

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
  type NoticeInfo = { text: string; type: "success" | "error" | "info" };
  const [notice, setNoticeState] = useState<NoticeInfo | null>(null);
  const setNotice = (val: string | NoticeInfo | null, type: "success" | "error" | "info" = "info") => {
    if (!val) {
      setNoticeState(null);
    } else if (typeof val === "string") {
      setNoticeState({ text: val, type });
    } else {
      setNoticeState(val);
    }
  };

  // Auto-dismiss notification after 4 seconds
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      setNoticeState(null);
    }, 4000);
    return () => clearTimeout(timer);
  }, [notice]);

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
  const historyMessages = useMemo(() => messages.filter((message) => !message.isDraft), [messages]);
  const latestHistoryMessageId = historyMessages.at(-1)?.id;

  useEffect(() => {
    if (!latestHistoryMessageId) return;
    const frame = window.requestAnimationFrame(() => {
      const container = messageScrollRef.current;
      if (container) container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedThreadId, latestHistoryMessageId, threadOpenVersion]);

  function openCompose() {
    setComposeAccountId(selectedAccountId !== "all" ? selectedAccountId : accounts[0]?.id || "");
    setComposeTo(""); setComposeCc(""); setComposeBcc(""); setComposeSubject(""); setComposeBody(""); setComposeFiles([]);
    setComposeOpen(true);
  }

  async function submitCompose(isDraft: boolean) {
    if (!selectedCompanyId || !composeAccountId) {
      setNotice(t("emailInbox.notices.connectAccountFirst"));
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
      setNotice(isDraft ? t("emailInbox.notices.draftSaved") : result.status === "simulated_send" ? t("emailInbox.notices.testModeSent") : t("emailInbox.notices.queuedDelivery"), "success");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), "error");
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
        title: t("emailInbox.dialogs.openLinkTitle"),
        message: inspected.check.warnings.join(" ") || t("emailInbox.dialogs.openLinkMsgFallback"),
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
      setNotice(t("emailInbox.notices.attachmentNotAvailable"));
    }
  }

  // Load companies
  useEffect(() => {
    api<{ companies: Company[] }>("/companies")
      .then((res) => {
        setCompanies(res.companies);
        writeCachedCompanies(res.companies);
        const requested = searchParams.get("company");
        const sel = requested === "personal"
          ? "personal"
          : chooseAvailableCompanyId(res.companies, { requested, fallback: "personal" });
        if (sel !== selectedCompanyId) {
          setSelectedCompanyId(sel);
          writeActiveCompanyId(sel === "personal" ? "" : sel);
        }
        if (requested) {
          const next = new URLSearchParams(searchParams);
          next.delete("company");
          setSearchParams(next, { replace: true });
        }
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
          setSearchParams({}, { replace: true });
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

  function openThread(thread: EmailThread) {
    setSelectedThreadId(thread.id);
    setThreadOpenVersion((current) => current + 1);
    setMailboxRefreshVersion((current) => current + 1);
    if (thread.unreadCount <= 0) return;
    const unreadCount = thread.unreadCount;
    setThreads((current) => current.map((item) => item.id === thread.id ? { ...item, unreadCount: 0 } : item));
    setFolderCounts((current) => ({ ...current, inbox: Math.max(0, current.inbox - unreadCount) }));
    void api<{ thread: EmailThread }>(
      `/companies/${selectedCompanyId}/email-inbox/threads/${thread.id}`,
      { method: "PATCH", body: JSON.stringify({ unreadCount: 0 }) }
    ).then(({ thread: updated }) => {
      setActiveThread((current) => current?.id === updated.id ? { ...current, unreadCount: 0 } : current);
    }).catch((error) => {
      setNotice(error instanceof Error ? error.message : String(error));
      void loadThreads();
    });
  }

  // Reset thread selection when mailbox scope / company changes
  useEffect(() => {
    threadRequestIdRef.current += 1;
    deletedThreadIdsRef.current.clear();
    setSelectedThreadId(null);
    setActiveThread(null);
    setMessages([]);
    setContact(null);
    setCustomerContext({ previousThreads: [], tasks: [] });
    setAuditHistory([]);
    setDraftMessageId(null);
    setDraftText("");
  }, [selectedCompanyId]);

  // Load threads
  async function loadThreads() {
    if (!selectedCompanyId) return;
    const requestId = ++threadRequestIdRef.current;
    try {
      const q = new URLSearchParams();
      q.set("folder", folder);
      if (selectedAccountId !== "all") q.set("accountId", selectedAccountId);
      if (statusFilter !== "all") q.set("status", statusFilter);
      if (priorityFilter !== "all") q.set("priority", priorityFilter);
      if (searchQuery.trim()) q.set("search", searchQuery.trim());

      const countQuery = selectedAccountId !== "all" ? `?accountId=${encodeURIComponent(selectedAccountId)}` : "";
      const [res, countResult] = await Promise.all([
        api<{ threads: EmailThread[] }>(
          `/companies/${selectedCompanyId}/email-inbox/threads?${q.toString()}`
        ),
        api<{ counts: Record<"inbox" | "sent" | "drafts" | "archived" | "spam", number> }>(
          `/companies/${selectedCompanyId}/email-inbox/folder-counts${countQuery}`
        ),
      ]);
      if (requestId !== threadRequestIdRef.current) return;
      const visibleThreads = res.threads.filter((thread) => !deletedThreadIdsRef.current.has(thread.id));
      setFolderCounts(countResult.counts);
      setThreads(visibleThreads);
      setMailboxRefreshVersion((current) => current + 1);
      if (visibleThreads.length === 0) {
        setSelectedThreadId(null);
        setActiveThread(null);
        setMessages([]);
        setContact(null);
        setCustomerContext({ previousThreads: [], tasks: [] });
        setAuditHistory([]);
        setDraftMessageId(null);
        setDraftText("");
      } else {
        setSelectedThreadId((current) =>
          current && visibleThreads.some((thread) => thread.id === current) ? current : visibleThreads[0]!.id
        );
      }
    } catch (err: any) {
      setNotice(err.message);
    }
  }

  useEffect(() => {
    void loadThreads();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadThreads();
    }, 15_000);
    return () => window.clearInterval(timer);
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

        const draft = [...res.messages].reverse().find((m) => m.isDraft);
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
      .catch((e) => {
        setActiveThread(null);
        setMessages([]);
        setContact(null);
        setCustomerContext({ previousThreads: [], tasks: [] });
        setAuditHistory([]);
        setDraftMessageId(null);
        setDraftText("");
        setNotice(e.message);
      });
  }, [selectedCompanyId, selectedThreadId, mailboxRefreshVersion]);

  // Handle Acquire Lock when typing reply
  async function onReplyFocus() {
    if (!selectedCompanyId || !selectedThreadId) return;
    await api(`/companies/${selectedCompanyId}/email-inbox/threads/${selectedThreadId}/lock`, {
      method: "POST",
      body: JSON.stringify({ action: "acquire" }),
    }).catch(() => undefined);
  }

  async function updateActiveThread(patch: Partial<Pick<EmailThread, "priority" | "status" | "folder" | "unreadCount">>) {
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
      void loadThreads();
    } catch (error: any) {
      setNotice(error.message);
    }
  }

  async function deleteActiveThread() {
    if (!selectedCompanyId || !selectedThreadId) return;
    const approved = await confirmModal({
      title: t("emailInbox.dialogs.deleteThreadTitle"),
      message: t("emailInbox.dialogs.deleteThreadMsg"),
      confirmText: t("emailInbox.dialogs.deleteConfirm"),
      isDanger: true,
    });
    if (!approved) return;
    const deletedId = selectedThreadId;
    deletedThreadIdsRef.current.add(deletedId);
    threadRequestIdRef.current += 1;
    setThreads((current) => current.filter((thread) => thread.id !== deletedId));
    setSelectedThreadId(null); setActiveThread(null); setMessages([]);
    try {
      await api(`/companies/${selectedCompanyId}/email-inbox/threads/${deletedId}`, { method: "DELETE" });
      await loadThreads();
    } catch (error) {
      deletedThreadIdsRef.current.delete(deletedId);
      await loadThreads();
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
      if (composerMode === "forward" && !toAddresses?.length) throw new Error(t("emailInbox.notices.enterForwardRecipient"));
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
      setNotice(t("emailInbox.notices.simulatedSuccess"));
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
            <p className="eyebrow">{t("emailInbox.header.eyebrow")}</p>
            <h1>
              <Link
                to={selectedCompanyId && selectedCompanyId !== "personal" ? `/settings/email?company=${encodeURIComponent(selectedCompanyId)}` : "/settings/email"}
                className="marketplace-back-button"
                aria-label={t("emailInbox.header.backAria")}
                title={t("emailInbox.header.backTitle")}
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
              <span>{t("emailInbox.header.title")}</span>
            </h1>
            <p className="hero-copy">
              {t("emailInbox.header.heroCopy")}
            </p>
          </div>
          <div className="automations-header-actions">
            <Link
              to={selectedCompanyId && selectedCompanyId !== "personal" ? `/settings/email?company=${encodeURIComponent(selectedCompanyId)}` : "/settings/email"}
              className="button-secondary"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              {t("emailInbox.header.emailSettingsBtn")}
            </Link>
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
              <span>{t("emailInbox.scope.scopeLabel")}</span>
            </span>

            <div className="email-scope-select-wrap">
              <select
                aria-label={t("emailInbox.scope.selectOwnerAria")}
                value={selectedCompanyId}
                onChange={(e) => {
                  const companyId = e.target.value;
                  setSelectedCompanyId(companyId);
                  writeActiveCompanyId(companyId === "personal" ? "" : companyId);
                }}
                className="email-scope-select"
                title={selectedCompanyId === "personal" ? t("emailInbox.scope.personalOption") : (companies.find((c) => c.id === selectedCompanyId)?.name || selectedCompanyId)}
              >
                <option value="personal">{t("emailInbox.scope.personalOption")}</option>
                {selectedCompanyId && selectedCompanyId !== "personal" && !companies.some((c) => c.id === selectedCompanyId) && (
                  <option key={selectedCompanyId} value={selectedCompanyId} title={selectedCompanyId}>
                    {selectedCompanyId}
                  </option>
                )}
                {companies.map((c) => (
                  <option key={c.id} value={c.id} title={c.name}>
                    {c.name}
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
              ? t("emailInbox.scope.personalHint")
              : `${t("emailInbox.scope.companyHintPrefix")}${companies.find((c) => c.id === selectedCompanyId)?.name || t("emailInbox.scope.selectedOrgFallback")}`}
          </span>
        </div>

        <div className="email-scope-right">
          <button
            type="button"
            className="email-compose-btn"
            onClick={openCompose}
            disabled={accounts.length === 0}
            title={accounts.length ? t("emailInbox.scope.composeTitleCan") : t("emailInbox.scope.composeTitleCant")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span>{t("emailInbox.scope.composeBtn")}</span>
          </button>
        </div>
      </div>

      {notice && (
        <div className={`workspace-notice ${notice.type}`} style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>{notice.type === "success" ? "✓" : notice.type === "error" ? "⚠️" : "ℹ️"}</span>
            <span>{notice.text}</span>
          </div>
          <button
            type="button"
            className="workspace-notice-close"
            onClick={() => setNotice(null)}
            aria-label={t("emailInbox.notices.dismissNotice")}
          >
            ✕
          </button>
        </div>
      )}

      {notifications.some((item) => !item.isRead) && (
        <section className="workspace-notice" style={{ marginBottom: 16 }} aria-label={t("emailInbox.notices.notificationsHeading")}>
          <strong>{t("emailInbox.notices.notificationsHeading")}</strong>
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
            {!sidebarCollapsed && <span className="email-inbox-label">{t("emailInbox.sidebar.accountLabel")}</span>}
            <button
              type="button"
              className="email-sidebar-toggle-btn"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? t("emailInbox.sidebar.expandSidebar") : t("emailInbox.sidebar.collapseSidebar")}
              aria-label={sidebarCollapsed ? t("emailInbox.sidebar.expandSidebar") : t("emailInbox.sidebar.collapseSidebar")}
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
                aria-label={t("emailInbox.sidebar.filterAccountAria")}
              >
                <option value="all">{t("emailInbox.sidebar.allAccounts").replace("{count}", String(accounts.length))}</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName || a.emailAddress}
                  </option>
                ))}
              </select>
            </div>
          )}

          <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {!sidebarCollapsed && <span className="email-inbox-label">{t("emailInbox.sidebar.foldersLabel")}</span>}
            {[
              {
                id: "inbox",
                label: t("emailInbox.sidebar.folders.inbox"),
                icon: (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M3 14h5.5l1.5 2.5h4l1.5-2.5H21" />
                  </svg>
                ),
              },
              {
                id: "sent",
                label: t("emailInbox.sidebar.folders.sent"),
                icon: (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 3l19 9-19 9 4-9-4-9z" />
                    <path d="M6.5 12h8" />
                  </svg>
                ),
              },
              {
                id: "drafts",
                label: t("emailInbox.sidebar.folders.drafts"),
                icon: (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                ),
              },
              {
                id: "archived",
                label: t("emailInbox.sidebar.folders.archived"),
                icon: (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="21 8 21 20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
                    <rect x="3" y="3" width="18" height="5" rx="1" />
                    <polyline points="9 13.5 12 16.5 15 13.5" />
                    <line x1="12" y1="10.5" x2="12" y2="16.5" />
                  </svg>
                ),
              },
              {
                id: "spam",
                label: t("emailInbox.sidebar.folders.spam"),
                icon: (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                ),
              },
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
                {!sidebarCollapsed && (
                  <span className="email-folder-count">({folderCounts[f.id as keyof typeof folderCounts]})</span>
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
                placeholder={t("emailInbox.threadsList.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="inspector-search-input"
                aria-label={t("emailInbox.threadsList.searchAria")}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setSearchQuery("")}
                  aria-label={t("emailInbox.threadsList.clearSearch")}
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
                aria-label={t("emailInbox.threadsList.filterStatusAria")}
              >
                <option value="all">{t("emailInbox.statusFilters.all")}</option>
                <option value="new">{t("emailInbox.statusFilters.new")}</option>
                <option value="draft_ready">{t("emailInbox.statusFilters.draftReady")}</option>
                <option value="waiting_approval">{t("emailInbox.statusFilters.waitingApproval")}</option>
                <option value="answered">{t("emailInbox.statusFilters.answered")}</option>
              </select>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                className="email-inbox-select filter-select"
                aria-label={t("emailInbox.threadsList.filterPriorityAria")}
              >
                <option value="all">{t("emailInbox.priorities.all")}</option>
                <option value="urgent">{t("emailInbox.priorities.urgent")}</option>
                <option value="high">{t("emailInbox.priorities.high")}</option>
                <option value="normal">{t("emailInbox.priorities.normal")}</option>
              </select>
            </div>
          </div>

          {/* Threads Scroll List */}
          <div className="email-inbox-threads-scroll">
            {threads.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center" }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
                <strong style={{ display: "block", marginBottom: 4, color: "#1e293b" }}>
                  {t("emailInbox.threadsList.emptyFolderTitlePrefix")} {t(`emailInbox.sidebar.folders.${folder}` as any)}
                </strong>
                <small style={{ color: "#475569" }}>{t(`emailInbox.threadsList.emptyFolderHints.${folder}` as any)}</small>
              </div>
            ) : (
              threads.map((tItem) => {
                const isSelected = tItem.id === selectedThreadId;
                return (
                  <div
                    key={tItem.id}
                    onClick={() => openThread(tItem)}
                    className={`email-inbox-thread-card ${isSelected ? "active" : ""} ${tItem.unreadCount > 0 ? "unread" : ""}`}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, fontSize: 13, fontWeight: tItem.unreadCount > 0 ? 700 : 600, color: "#0f172a" }}>
                        {tItem.unreadCount > 0 && <span className="email-thread-unread-dot" aria-label={t("emailInbox.threadsList.unreadAria")} />}
                        {tItem.isVip && <span style={{ color: "#eab308", marginRight: 4 }}>★</span>}
                        {tItem.customerName || tItem.customerEmail}
                      </span>
                      <small style={{ fontSize: 11, color: "#475569", flexShrink: 0 }}>
                        {new Date(tItem.lastMessageAt).toLocaleDateString(language)}
                      </small>
                    </div>

                    <div style={{ fontSize: 13, color: "#334155", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {tItem.subject}
                    </div>

                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                      <span className={`email-status-pill status-${tItem.status}`}>
                        <span className="email-status-dot" />
                        {getStatusLabel(tItem.status, t)}
                      </span>

                      {tItem.priority === "urgent" && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#dc2626", background: "#fef2f2", padding: "2px 6px", borderRadius: 4 }}>
                          {t("emailInbox.priorities.urgent")}
                        </span>
                      )}
                      {tItem.priority === "high" && (
                        <span style={{ fontSize: 10, fontWeight: 600, color: "#d97706", background: "#fffbeb", padding: "2px 6px", borderRadius: 4 }}>
                          {t("emailInbox.priorities.high")}
                        </span>
                      )}
                      <small className="email-thread-message-count" title={t("emailInbox.threadsList.messagesCountTooltip")}>✉ {tItem.messagesCount ?? 0}</small>
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
            title={t("emailInbox.threadsList.resizerTitle")}
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
                {t("emailInbox.threadDetail.emptySelectTitle")}
              </h3>
              <p style={{ margin: 0, fontSize: 13, maxWidth: 360, lineHeight: 1.5, color: "#475569" }}>
                {t("emailInbox.threadDetail.emptySelectDesc")}
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
                        title={t("emailInbox.threadDetail.detailsToggleTitle")}
                      >
                        {t("emailInbox.threadDetail.detailsToggle")}
                      </button>

                      <strong
                        className="email-header-compact-subject"
                        title={activeThread.subject}
                      >
                        {activeThread.subject}
                      </strong>

                      <span className="email-header-compact-sender">
                        {t("emailInbox.threadDetail.fromPrefix")}{activeThread.customerName || activeThread.customerEmail}
                      </span>
                    </div>

                    <div className="email-header-compact-actions">
                      <button
                        type="button"
                        className="automation-action-btn"
                        onClick={() => void updateActiveThread({ folder: activeThread.folder === "spam" ? "inbox" : "spam" })}
                        style={{ fontSize: 11.5, padding: "3px 8px" }}
                        title={activeThread.folder === "spam" ? t("emailInbox.threadDetail.notSpamTitle") : t("emailInbox.threadDetail.spamTitle")}
                      >
                        {activeThread.folder === "spam" ? t("emailInbox.threadDetail.notSpamBtn") : t("emailInbox.threadDetail.spamBtn")}
                      </button>
                      <button
                        type="button"
                        className="automation-action-btn danger"
                        onClick={() => void deleteActiveThread()}
                        style={{ fontSize: 11.5, padding: "3px 8px" }}
                        title={t("emailInbox.threadDetail.deleteThreadTitle")}
                      >
                        {t("emailInbox.threadDetail.deleteBtn")}
                      </button>
                      <button
                        type="button"
                        className={`email-expand-pane-btn ${readingFocus ? "active" : ""}`}
                        onClick={() => setReadingFocus(!readingFocus)}
                        style={{ fontSize: 11.5, padding: "3px 8px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                        title={readingFocus ? t("emailInbox.threadDetail.restoreSplitView") : t("emailInbox.threadDetail.expandReadingView")}
                        aria-label={readingFocus ? t("emailInbox.threadDetail.restoreSplitView") : t("emailInbox.threadDetail.expandReadingView")}
                      >
                        {readingFocus ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M4 14h6m0 0v6m0-6L3 21m17-7h-6m0 0v6m0-6l7 7M4 10h6m0 0V4m0 6L3 3m17 7h-6m0 0V4m0 6l7-7" /></svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 3h6m0 0v6m0-6L14 10M9 21H3m0 0v-6m0 6l7-7M3 9V3m0 0h6m-6 0l7 7m11 11v-6m0 6h-6m6 0l-7-7" /></svg>
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
                            title={t("emailInbox.threadDetail.compactToggleTitle")}
                          >
                            {t("emailInbox.threadDetail.compactToggle")}
                          </button>
                          <h2 className="email-detail-subject">
                            {activeThread.subject}
                          </h2>
                          {activeThread.isVip && (
                            <span className="email-vip-badge">
                              VIP
                            </span>
                          )}
                        </div>
                        <div className="email-detail-sender-row">
                          <span>
                            {t("emailInbox.threadDetail.fromPrefix")}<strong>{activeThread.customerName || activeThread.customerEmail}</strong> &lt;{activeThread.customerEmail}&gt;
                          </span>
                          <span>
                            {new Date(activeThread.lastMessageAt).toLocaleString(language)}
                          </span>
                        </div>
                      </div>

                      <div className="email-detail-top-controls">
                        <button
                          type="button"
                          className={`email-expand-pane-btn ${readingFocus ? "active" : ""}`}
                          onClick={() => setReadingFocus(!readingFocus)}
                          title={readingFocus ? t("emailInbox.threadDetail.restoreSplitView") : t("emailInbox.threadDetail.expandReadingView")}
                        >
                          {readingFocus ? (
                            <>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M4 14h6m0 0v6m0-6L3 21m17-7h-6m0 0v6m0-6l7 7M4 10h6m0 0V4m0 6L3 3m17 7h-6m0 0V4m0 6l7-7" /></svg>
                              <span>{t("emailInbox.threadDetail.splitView")}</span>
                            </>
                          ) : (
                            <>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 3h6m0 0v6m0-6L14 10M9 21H3m0 0v-6m0 6l7-7M3 9V3m0 0h6m-6 0l7 7m11 11v-6m0 6h-6m6 0l-7-7" /></svg>
                              <span>{t("emailInbox.threadDetail.expandView")}</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Actions Toolbar */}
                    <div className="email-detail-actions-bar">
                      <div className="email-detail-actions-left">
                        <div className="email-priority-selector">
                          <span>{t("emailInbox.threadDetail.priorityLabel")}</span>
                          <select
                            className="email-inbox-select priority-select"
                            aria-label={t("emailInbox.threadDetail.priorityAria")}
                            value={activeThread.priority}
                            onChange={(e) => void updateActiveThread({ priority: e.target.value as EmailThread["priority"] })}
                          >
                            <option value="low">{t("emailInbox.priorities.low")}</option>
                            <option value="normal">{t("emailInbox.priorities.normal")}</option>
                            <option value="high">{t("emailInbox.priorities.high")}</option>
                            <option value="urgent">{t("emailInbox.priorities.urgent")}</option>
                          </select>
                        </div>

                        <button
                          type="button"
                          className={`automation-action-btn ${activeThread.isHumanTakeover ? "active" : ""}`}
                          onClick={handleToggleTakeover}
                          title={t("emailInbox.threadDetail.takeOverTitle")}
                        >
                          {activeThread.isHumanTakeover ? t("emailInbox.threadDetail.returnToAi") : t("emailInbox.threadDetail.takeOver")}
                        </button>

                        <button
                          type="button"
                          className={`automation-action-btn ${activeThread.isVip ? "active" : ""}`}
                          onClick={handleToggleVip}
                          title={t("emailInbox.threadDetail.vipTitle")}
                        >
                          {activeThread.isVip ? t("emailInbox.threadDetail.vipCustomer") : t("emailInbox.threadDetail.makeVip")}
                        </button>
                      </div>

                      <div className="email-detail-actions-right">
                        <button
                          type="button"
                          className="automation-action-btn"
                          onClick={() => void updateActiveThread({ folder: activeThread.folder === "archived" ? "inbox" : "archived" })}
                          title={activeThread.folder === "archived" ? t("emailInbox.threadDetail.unarchiveTitle") : t("emailInbox.threadDetail.archiveTitle")}
                        >
                          {activeThread.folder === "archived" ? t("emailInbox.threadDetail.unarchive") : t("emailInbox.threadDetail.archive")}
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn"
                          onClick={() => void updateActiveThread({ folder: activeThread.folder === "spam" ? "inbox" : "spam" })}
                          title={activeThread.folder === "spam" ? t("emailInbox.threadDetail.notSpamTitle") : t("emailInbox.threadDetail.spamTitle")}
                        >
                          {activeThread.folder === "spam" ? t("emailInbox.threadDetail.notSpamBtn") : t("emailInbox.threadDetail.spamBtn")}
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn danger"
                          onClick={() => void deleteActiveThread()}
                          title={t("emailInbox.threadDetail.deleteThreadTitle")}
                        >
                          {t("emailInbox.threadDetail.deleteBtn")}
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
                      <span>{t("emailInbox.customerProfile.profileHeading").replace("{name}", contact?.name || activeThread.customerName || t("emailInbox.customerProfile.customerDefault")).replace("{email}", activeThread.customerEmail)}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div className="email-customer-stats-pills">
                        <span><strong>{contact?.previousThreadsCount ?? customerContext.previousThreads.length}</strong> {t("emailInbox.customerProfile.previousThreadsCount")}</span>
                        <span><strong>{customerContext.tasks.length}</strong> {t("emailInbox.customerProfile.tasksCount")}</span>
                        <span><strong>{contact?.lastActivityAt ? new Date(contact.lastActivityAt).toLocaleDateString(language) : t("emailInbox.customerProfile.active")}</strong></span>
                      </div>
                      <span style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>
                        {customerCardExpanded ? t("emailInbox.customerProfile.hide") : t("emailInbox.customerProfile.details")}
                      </span>
                    </div>
                  </div>

                  {customerCardExpanded && (
                    <div className="email-customer-card-body">
                      {contact?.companyName && <span style={{ fontSize: 12, color: "#475569" }}>{t("emailInbox.customerProfile.companyPrefix")}{contact.companyName}</span>}
                      {contact?.phone && <span style={{ fontSize: 12, color: "#475569" }}>{t("emailInbox.customerProfile.phonePrefix")}{contact.phone}</span>}
                      {contact?.notes && <p style={{ margin: "4px 0 0", fontSize: 12, color: "#334155" }}>{t("emailInbox.customerProfile.notesPrefix")}{contact.notes}</p>}

                      {(customerContext.previousThreads.length > 0 || customerContext.tasks.length > 0) && (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700 }}>{t("emailInbox.customerProfile.interactionsSummary")}</summary>
                          <div style={{ display: "grid", gap: 5, marginTop: 7, fontSize: 11.5, color: "#475569" }}>
                            {customerContext.previousThreads.map((item) => <span key={item.id}>{t("emailInbox.customerProfile.emailPrefix")} · {item.subject} · {item.status} · {item.priority}</span>)}
                            {customerContext.tasks.map((item) => <span key={item.id}>{t("emailInbox.customerProfile.taskPrefix")} · {item.task.slice(0, 120)} · {item.status}</span>)}
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                </section>

                {/* Collision Protection Warning */}
                {activeThread.lockedByUserId && (
                  <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#dc2626", fontSize: 12 }}>
                    {t("emailInbox.threadDetail.collisionWarning")}
                  </div>
                )}

                {/* Draft review box */}
                {draftMessageId && (
                  <div className={`email-inbox-draft-box ${!draftExpanded ? "collapsed" : ""}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                      <div
                        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}
                        onClick={() => setDraftExpanded(!draftExpanded)}
                        title={draftExpanded ? t("emailInbox.draftReview.collapseDraft") : t("emailInbox.draftReview.expandDraft")}
                      >
                        <button
                          type="button"
                          className="email-draft-toggle-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDraftExpanded(!draftExpanded);
                          }}
                          aria-label={draftExpanded ? t("emailInbox.draftReview.collapseDraft") : t("emailInbox.draftReview.expandDraft")}
                        >
                          {draftExpanded ? "▲" : "▼"}
                        </button>
                        <span style={{ fontWeight: 700, fontSize: 13, color: "#92400e" }}>
                          {draftIsAiGenerated ? t("emailInbox.draftReview.aiDraftHeading") : t("emailInbox.draftReview.savedDraftHeading")}
                        </span>
                        {draftIsAiGenerated && activeThread.aiConfidenceScore != null && (
                          <span style={{ fontSize: 10.5, fontWeight: 600, background: "#fde68a", color: "#78350f", padding: "1px 6px", borderRadius: 4 }}>
                            {Math.round(activeThread.aiConfidenceScore * 100)}% {t("emailInbox.draftReview.confidenceBadge")}
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
                          {sending ? t("emailInbox.draftReview.sending") : draftIsAiGenerated ? t("emailInbox.draftReview.sendAiDraft") : t("emailInbox.draftReview.sendDraft")}
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
                          {draftEditing ? t("emailInbox.draftReview.done") : t("emailInbox.draftReview.edit")}
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
                          {t("emailInbox.draftReview.discard")}
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
                <div className="email-inbox-messages-scroll" ref={messageScrollRef}>
                  {historyMessages.length === 0 ? (
                    <div style={{ padding: "40px 20px", textAlign: "center" }}>
                      <div style={{ fontSize: 28, marginBottom: 8 }}>📬</div>
                      <strong style={{ display: "block", marginBottom: 4, color: "#1e293b" }}>{t("emailInbox.messagesTimeline.noMessagesTitle")}</strong>
                      <small style={{ color: "#475569" }}>{t("emailInbox.messagesTimeline.noMessagesDesc")}</small>
                    </div>
                  ) : (
                    historyMessages.map((m) => {
                      const isInbound = m.direction === "inbound";
                      return (
                        <div
                          key={m.id}
                          className={`email-inbox-message-bubble ${isInbound ? "inbound" : m.isAiGenerated ? "ai-generated" : "outbound"}`}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(0,0,0,0.06)", paddingBottom: 6 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>
                              {isInbound ? m.fromName || m.fromAddress : m.isAiGenerated ? t("emailInbox.messagesTimeline.aiAssistant") : t("emailInbox.messagesTimeline.supportAgent")}
                            </div>
                            <small style={{ fontSize: 11, color: "#475569" }}>
                              {new Date(m.createdAt).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })}
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
                              {m.attachments.map((att, i) => /^image\//i.test(att.contentType) ? (
                                <EmailImageAttachment
                                  key={`${m.id}-image-${i}`}
                                  attachment={att}
                                  onPreview={(source, filename) => setImagePreview({ source, filename })}
                                  onFallbackOpen={() => void openAttachment(att)}
                                />
                              ) : (
                                <button key={`${m.id}-file-${i}`} type="button" className="automation-cron-pill" style={{ fontSize: 11, cursor: "pointer" }} onClick={() => openAttachment(att)}>
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
                          {t("emailInbox.auditHistory.heading")} ({auditHistory.length})
                        </span>
                        <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>
                          {historyOpen ? t("emailInbox.auditHistory.hide") : t("emailInbox.auditHistory.show")}
                        </span>
                      </div>

                      {historyOpen && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 11, color: "#94a3b8" }}>{t("emailInbox.auditHistory.sizeLabel")}</span>
                          <button
                            type="button"
                            className={`history-size-btn ${historyHeight === 90 ? "active" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setHistoryHeight(90);
                            }}
                            title={t("emailInbox.auditHistory.sizeCompact")}
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
                            title={t("emailInbox.auditHistory.sizeMedium")}
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
                            title={t("emailInbox.auditHistory.sizeLarge")}
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
                            <time>{new Date(entry.createdAt).toLocaleString(language)}</time>
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
                    <button
                      key={modeOption}
                      type="button"
                      className={`email-composer-mode-btn ${composerMode === modeOption ? "active" : ""}`}
                      onClick={() => setComposerMode(modeOption)}
                    >
                      {modeOption === "reply" ? t("emailInbox.composer.reply") : modeOption === "reply_all" ? t("emailInbox.composer.replyAll") : t("emailInbox.composer.forward")}
                    </button>
                  ))}
                </div>
                {composerMode === "forward" && (
                  <input
                    type="text"
                    placeholder={t("emailInbox.composer.forwardPlaceholder")}
                    value={forwardTo}
                    onChange={(e) => setForwardTo(e.target.value)}
                    style={{ width: "100%", marginBottom: 6, border: "1px solid #cbd5e1", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}
                  />
                )}
                <textarea
                  placeholder={t("emailInbox.composer.replyPlaceholder").replace("{name}", activeThread.customerName || activeThread.customerEmail)}
                  value={replyText}
                  onFocus={onReplyFocus}
                  onChange={(e) => setReplyText(e.target.value)}
                  style={{ minHeight: "65px", maxHeight: "150px", resize: "vertical" }}
                />
                {replyFiles.length > 0 && (
                  <div className="email-attached-files-list">
                    {replyFiles.map((file, idx) => (
                      <div key={`${file.name}-${idx}-${file.size}`} className="email-attached-file-chip">
                        <span className="attachment-chip-icon">{file.type.startsWith("image/") ? "🖼️" : "📎"}</span>
                        <span className="attachment-chip-name" title={file.name}>{file.name}</span>
                        <span className="attachment-chip-size">({(file.size / 1024).toFixed(0)} KB)</span>
                        <button
                          type="button"
                          className="attachment-chip-remove"
                          title={t("emailInbox.composer.removeFileTitle")}
                          aria-label={t("emailInbox.composer.removeFileAria").replace("{filename}", file.name)}
                          onClick={() => {
                            setReplyFiles((prev) => prev.filter((_, i) => i !== idx));
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="email-composer-footer-row" style={{ marginTop: 4 }}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#475569", cursor: "pointer", margin: 0 }}>
                    <span style={{ fontWeight: 600 }}>{t("emailInbox.composer.attachFiles")}</span>
                    <input
                      type="file"
                      multiple
                      onChange={(event) => {
                        const files = Array.from(event.target.files || []);
                        if (files.some((file) => file.size > 10 * 1024 * 1024)) {
                          setNotice(t("emailInbox.notices.fileTooLarge"));
                          event.target.value = "";
                          return;
                        }
                        const combined = [...replyFiles, ...files];
                        if (combined.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) {
                          setNotice(t("emailInbox.notices.totalTooLarge"));
                          event.target.value = "";
                          return;
                        }
                        setReplyFiles(combined);
                        event.target.value = "";
                      }}
                    />
                    {replyFiles.length > 0 && <span>{replyFiles.length} {t("emailInbox.composer.attachedCount")}</span>}
                  </label>
                  <button
                    type="submit"
                    className="button-primary automations-action-primary email-composer-send-btn"
                    disabled={sending || !replyText.trim()}
                    style={{ fontSize: 13, padding: "7px 20px", fontWeight: 700, marginLeft: "auto" }}
                  >
                    {sending ? t("emailInbox.composer.sending") : t("emailInbox.composer.sendReply")}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>

      {composeOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => !composeSending && setComposeOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(event) => event.stopPropagation()} aria-label={t("emailInbox.composeModal.title")}>
            <header>
              <div><span>{t("emailInbox.composeModal.kicker")}</span><h2>{t("emailInbox.composeModal.title")}</h2></div>
              <button type="button" className="company-drawer-close" aria-label={t("emailInbox.composeModal.closeAria")} onClick={() => setComposeOpen(false)} disabled={composeSending}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>
            <form onSubmit={(event) => { event.preventDefault(); void submitCompose(false); }}>
              <section>
                <h3>{t("emailInbox.composeModal.senderRecipients")}</h3>
                <div className="company-form-grid">
                  <label>
                    <span>{t("emailInbox.composeModal.fromLabel")}</span>
                    <select value={composeAccountId} onChange={(event) => setComposeAccountId(event.target.value)} required>
                      <option value="">{t("emailInbox.composeModal.selectAccountPlaceholder")}</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.displayName ? `${account.displayName} — ` : ""}{account.emailAddress}{account.testMode ? t("emailInbox.composeModal.testModeSuffix") : account.status && account.status !== "connected" ? ` (${account.status.replaceAll("_", " ")})` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t("emailInbox.composeModal.toLabel")}</span>
                    <input type="text" value={composeTo} onChange={(event) => setComposeTo(event.target.value)} placeholder={t("emailInbox.composeModal.toPlaceholder")} required />
                  </label>
                </div>
                <div className="company-form-grid">
                  <label>
                    <span>{t("emailInbox.composeModal.ccLabel")}</span>
                    <input type="text" value={composeCc} onChange={(event) => setComposeCc(event.target.value)} placeholder={t("emailInbox.composeModal.optionalCommaSeparated")} />
                  </label>
                  <label>
                    <span>{t("emailInbox.composeModal.bccLabel")}</span>
                    <input type="text" value={composeBcc} onChange={(event) => setComposeBcc(event.target.value)} placeholder={t("emailInbox.composeModal.optionalCommaSeparated")} />
                  </label>
                </div>
              </section>
              <section>
                <h3>{t("emailInbox.composeModal.messageHeading")}</h3>
                <label><span>{t("emailInbox.composeModal.subjectLabel")}</span><input value={composeSubject} onChange={(event) => setComposeSubject(event.target.value)} maxLength={998} required /></label>
                <label><span>{t("emailInbox.composeModal.bodyLabel")}</span><textarea value={composeBody} onChange={(event) => setComposeBody(event.target.value)} rows={12} placeholder={t("emailInbox.composeModal.bodyPlaceholder")} required /></label>
                <label>
                  <span>{t("emailInbox.composeModal.attachmentsLabel")}</span>
                  <input
                    type="file"
                    multiple
                    onChange={(event) => {
                      const files = Array.from(event.target.files || []);
                      if (files.some((file) => file.size > 10 * 1024 * 1024)) {
                        setNotice(t("emailInbox.notices.fileTooLarge"));
                        event.target.value = "";
                        return;
                      }
                      const combined = [...composeFiles, ...files];
                      if (combined.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) {
                        setNotice(t("emailInbox.notices.totalTooLarge"));
                        event.target.value = "";
                        return;
                      }
                      setComposeFiles(combined);
                      event.target.value = "";
                    }}
                  />
                </label>
                {composeFiles.length > 0 && (
                  <div className="email-attached-files-list">
                    {composeFiles.map((file, idx) => (
                      <div key={`${file.name}-${idx}-${file.size}`} className="email-attached-file-chip">
                        <span className="attachment-chip-icon">{file.type.startsWith("image/") ? "🖼️" : "📎"}</span>
                        <span className="attachment-chip-name" title={file.name}>{file.name}</span>
                        <span className="attachment-chip-size">({(file.size / 1024).toFixed(0)} KB)</span>
                        <button
                          type="button"
                          className="attachment-chip-remove"
                          title={t("emailInbox.composer.removeFileTitle")}
                          aria-label={t("emailInbox.composer.removeFileAria").replace("{filename}", file.name)}
                          onClick={() => {
                            setComposeFiles((prev) => prev.filter((_, i) => i !== idx));
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {accounts.find((account) => account.id === composeAccountId)?.testMode && (
                  <div className="workspace-notice">{t("emailInbox.composeModal.testModeNotice")}</div>
                )}
              </section>
              <footer style={{ justifyContent: "flex-end" }}>
                <button type="button" className="button-secondary" disabled={composeSending || !composeAccountId || !composeTo.trim() || !composeSubject.trim() || !composeBody.trim()} onClick={() => void submitCompose(true)}>
                  {t("emailInbox.composeModal.saveDraft")}
                </button>
                <button type="submit" className="button-primary" disabled={composeSending || !composeAccountId || !composeTo.trim() || !composeSubject.trim() || !composeBody.trim()}>
                  {composeSending ? t("emailInbox.composeModal.sending") : t("emailInbox.composeModal.sendEmail")}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {imagePreview && (
        <div className="email-image-preview-backdrop" role="dialog" aria-modal="true" aria-label={imagePreview.filename} onClick={() => setImagePreview(null)}>
          <button type="button" className="email-image-preview-close" aria-label={t("emailInbox.notices.closeImagePreview")} onClick={() => setImagePreview(null)}>×</button>
          <figure onClick={(event) => event.stopPropagation()}>
            <img src={imagePreview.source} alt={imagePreview.filename} />
            <figcaption>{imagePreview.filename}</figcaption>
          </figure>
        </div>
      )}
    </main>
  );
}
