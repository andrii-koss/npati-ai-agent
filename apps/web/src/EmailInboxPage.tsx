import { ALL_COMPANIES, loadCompanyScopes } from "./company-scope";
import { readEmailCollection } from "./email-company-scope";
import { listProjectCompanies } from "./website-builder-cache";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { chooseAvailableCompanyId, getInitialCompanyScope, readCachedCompanies, writeActiveCompanyId, writeCachedCompanies } from "./active-company";
import { useWorkspace } from "./BusinessWorkspace";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { Company, EmailAccount, EmailThread, EmailMessage, ContactDetails, getStatusLabel, sanitizeEmailHtml, CustomerContext, EmailNotification, EmailAuditEntry, api, fileToEmailAttachment, EmailImageAttachment } from "./email-inbox-shared";
export * from "./email-inbox-shared";
import {
  ComposeModal,
  CustomerContextCard,
  DraftReviewBox,
  EmailFolder,
  FolderSidebar,
  ImagePreviewModal,
  InboxHeaderToolbar,
  MessagesTimeline,
  ReplyComposer,
  ThreadHeader,
  ThreadHistorySection,
  ThreadListColumn,
  useInboxResizing,
} from "./email-inbox";


export function EmailInboxPage() {
  const { t, language } = useTranslation();
  const { overview } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [companies, setCompanies] = useState<Company[]>(readCachedCompanies);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>(() => {
    const requested = searchParams.get("company");
    return requested || ALL_COMPANIES;
  });
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("all");

  const [folder, setFolder] = useState<EmailFolder>("inbox");
  const [folderCounts, setFolderCounts] = useState<Record<"inbox" | "sent" | "drafts" | "archived" | "spam", number>>({
    inbox: 0, sent: 0, drafts: 0, archived: 0, spam: 0,
  });
  const [threads, setThreads] = useState<EmailThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const threadCompanyId = threads.find(thread => thread.id === selectedThreadId)?.companyId || (selectedCompanyId === ALL_COMPANIES ? "" : selectedCompanyId);
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
  const [customerCardExpanded, setCustomerCardExpanded] = useState(false);
  const [threadHeaderExpanded, setThreadHeaderExpanded] = useState(false);
  const [draftExpanded, setDraftExpanded] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { threadsWidth, isResizing, startResizing, historyHeight, setHistoryHeight } =
    useInboxResizing(sidebarCollapsed);

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
        `/companies/${accounts.find(account => account.id === composeAccountId)?.companyId || selectedCompanyId}/email-inbox/compose`,
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
      `/companies/${threadCompanyId || selectedCompanyId}/email-inbox/inspect-link`,
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
    listProjectCompanies()
      .then((list) => {
        setCompanies(list);
        writeCachedCompanies(list);
        const requested = searchParams.get("company");
        const sel = requested === "personal"
          ? "personal"
          : requested && requested !== ALL_COMPANIES ? chooseAvailableCompanyId(list, { requested, fallback: "personal" }) : ALL_COMPANIES;
        if (sel !== selectedCompanyId) {
          setSelectedCompanyId(sel);
          if (sel !== ALL_COMPANIES) writeActiveCompanyId(sel === "personal" ? "" : sel);
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
    let active = true;
    if (selectedCompanyId === ALL_COMPANIES) {
      const ids = companies.map(company => company.id);
      setAccounts([]); setNotifications([]);
      void Promise.all([readEmailCollection<EmailAccount>(ids, "email-accounts", "accounts"), readEmailCollection<EmailNotification>(ids, "email-inbox/notifications", "notifications")])
        .then(([accounts, notifications]) => { if (active) { setAccounts(accounts); setNotifications(notifications); } })
        .catch(error => { if (active) setNotice(error.message); });
      return () => { active = false; };
    }
    Promise.all([
      api<{ accounts: EmailAccount[] }>(`/companies/${selectedCompanyId}/email-accounts`),
      api<{ notifications: EmailNotification[] }>(`/companies/${selectedCompanyId}/email-inbox/notifications`),
    ])
      .then(([accountResult, notificationResult]) => {
        if (!active) return;
        setAccounts(accountResult.accounts.map(account => ({ ...account, companyId: selectedCompanyId })));
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
    return () => { active = false; };
  }, [selectedCompanyId, companies]);

  async function openNotification(notification: EmailNotification) {
    if (notification.threadId) {
      if (!threads.some(thread => thread.id === notification.threadId) && notification.companyId) setSelectedCompanyId(notification.companyId);
      setSelectedThreadId(notification.threadId);
    }
    if (!notification.isRead) {
      await api(`/companies/${notification.companyId || selectedCompanyId}/email-inbox/notifications/${notification.id}/read`, { method: "PATCH" });
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
      `/companies/${thread.companyId || selectedCompanyId}/email-inbox/threads/${thread.id}`,
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
      const ids = selectedCompanyId === ALL_COMPANIES ? companies.map(company => company.id) : [selectedCompanyId];
      const scopeIds = selectedAccountId === "all" ? ids : ids.filter(id => accounts.some(account => account.id === selectedAccountId && (account.companyId || selectedCompanyId) === id));
      const pages = await loadCompanyScopes(scopeIds, async id => {
        const [res, counts] = await Promise.all([
          api<{ threads: EmailThread[] }>(`/companies/${id}/email-inbox/threads?${q.toString()}`),
          api<{ counts: Record<"inbox" | "sent" | "drafts" | "archived" | "spam", number> }>(`/companies/${id}/email-inbox/folder-counts${countQuery}`),
        ]);
        return { threads: res.threads.map(thread => ({ ...thread, companyId: id })), counts: counts.counts };
      });
      const res = { threads: pages.flatMap(page => page.threads).sort((a,b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt)) };
      const counts = { inbox: 0, sent: 0, drafts: 0, archived: 0, spam: 0 };
      for (const page of pages) for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += page.counts[key] || 0;
      const countResult = { counts };
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
  }, [selectedCompanyId, companies, folder, selectedAccountId, statusFilter, priorityFilter, searchQuery]);

  // Load thread detail
  useEffect(() => {
    if (!threadCompanyId || !selectedThreadId) {
      setActiveThread(null);
      setMessages([]);
      setContact(null);
      setCustomerContext({ previousThreads: [], tasks: [] });
      setAuditHistory([]);
      return;
    }

    let active = true;
    Promise.all([
      api<{ thread: EmailThread; messages: EmailMessage[]; contact: ContactDetails | null; customerContext: CustomerContext }>(
        `/companies/${threadCompanyId}/email-inbox/threads/${selectedThreadId}`
      ),
      api<{ logs: EmailAuditEntry[] }>(
        `/companies/${threadCompanyId}/email-inbox/threads/${selectedThreadId}/audit`
      ).catch(() => ({ logs: [] })),
    ])
      .then(([res, audit]) => {
        if (!active) return;
        setActiveThread({ ...res.thread, companyId: threadCompanyId });
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
        if (!active) return;
        setActiveThread(null);
        setMessages([]);
        setContact(null);
        setCustomerContext({ previousThreads: [], tasks: [] });
        setAuditHistory([]);
        setDraftMessageId(null);
        setDraftText("");
        setNotice(e.message);
      });
    return () => { active = false; };
  }, [threadCompanyId, selectedThreadId, mailboxRefreshVersion]);

  // Handle Acquire Lock when typing reply
  async function onReplyFocus() {
    if (!selectedCompanyId || !selectedThreadId) return;
    await api(`/companies/${threadCompanyId}/email-inbox/threads/${selectedThreadId}/lock`, {
      method: "POST",
      body: JSON.stringify({ action: "acquire" }),
    }).catch(() => undefined);
  }

  async function updateActiveThread(patch: Partial<Pick<EmailThread, "priority" | "status" | "folder" | "unreadCount">>) {
    if (!selectedCompanyId || !selectedThreadId) return;
    try {
      const response = await api<{ thread: EmailThread }>(
        `/companies/${threadCompanyId}/email-inbox/threads/${selectedThreadId}`,
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
      await api(`/companies/${threadCompanyId}/email-inbox/threads/${deletedId}`, { method: "DELETE" });
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
      await api(`/companies/${threadCompanyId}/email-inbox/threads/${selectedThreadId}/messages`, {
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
      await api(`/companies/${threadCompanyId}/email-inbox/threads/${selectedThreadId}/lock`, {
        method: "POST",
        body: JSON.stringify({ action: "release" }),
      });
      const res = await api<{ thread: EmailThread; messages: EmailMessage[] }>(
        `/companies/${threadCompanyId}/email-inbox/threads/${selectedThreadId}`
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
          `/companies/${threadCompanyId}/email-inbox/threads/${selectedThreadId}/messages/${draftMessageId}`,
          { method: "PATCH", body: JSON.stringify({ bodyText: draftText }) }
        );
      }

      await api(`/companies/${threadCompanyId}/email-inbox/threads/${selectedThreadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ approvedDraftMessageId: draftMessageId, bodyText: draftText }),
      });

      setDraftMessageId(null);
      setDraftEditing(false);
      const res = await api<{ thread: EmailThread; messages: EmailMessage[] }>(
        `/companies/${threadCompanyId}/email-inbox/threads/${selectedThreadId}`
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
        `/companies/${threadCompanyId}/email-inbox/threads/${activeThread.id}/takeover`,
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
      await api(`/companies/${threadCompanyId}/email-inbox/contacts/${encodeURIComponent(activeThread.customerEmail)}`, {
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
    if (!selectedCompanyId || selectedCompanyId === ALL_COMPANIES) return;
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
      <InboxHeaderToolbar
        selectedCompanyId={selectedCompanyId}
        onSelectCompanyId={(companyId) => {
          setSelectedCompanyId(companyId);
          if (companyId !== ALL_COMPANIES) writeActiveCompanyId(companyId === "personal" ? "" : companyId);
          setSelectedAccountId("all");
        }}
        companies={companies}
        accounts={accounts}
        onOpenCompose={openCompose}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        notifications={notifications}
        onOpenNotification={(item) => void openNotification(item)}
      />

      {/* 3-Column Unified Inbox Card with Resizing & Collapse */}
      <div className={`email-inbox-card ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${readingFocus ? "reading-focus" : ""}`}
        style={{ "--inbox-threads-w": `${threadsWidth}px` } as React.CSSProperties}
      >
        <FolderSidebar
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
          selectedAccountId={selectedAccountId}
          onSelectAccount={(id) => setSelectedAccountId(id)}
          accounts={accounts}
          folder={folder}
          onSelectFolder={(f) => setFolder(f)}
          folderCounts={folderCounts}
        />

        <ThreadListColumn
          readingFocus={readingFocus}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          priorityFilter={priorityFilter}
          onPriorityFilterChange={setPriorityFilter}
          folder={folder}
          threads={threads}
          selectedThreadId={selectedThreadId}
          onOpenThread={openThread}
          language={language}
        />

        {/* Draggable Divider (User can resize columns!) */}
        {!readingFocus && (
          <div
            className={`email-inbox-resizer ${isResizing ? "resizing" : ""}`}
            onMouseDown={startResizing}
            title={t("emailInbox.threadsList.resizerTitle")}
          >
            <div className="resizer-handle" />
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
              <ThreadHeader
                activeThread={activeThread}
                threadHeaderExpanded={threadHeaderExpanded}
                onToggleThreadHeaderExpanded={setThreadHeaderExpanded}
                readingFocus={readingFocus}
                onToggleReadingFocus={() => setReadingFocus(!readingFocus)}
                language={language}
                onUpdateActiveThread={updateActiveThread}
                onDeleteActiveThread={() => void deleteActiveThread()}
                onToggleTakeover={handleToggleTakeover}
                onToggleVip={handleToggleVip}
              />

              {/* Scrollable middle body container */}
              <div className="email-inbox-detail-body">
                <CustomerContextCard
                  activeThread={activeThread}
                  contact={contact}
                  customerContext={customerContext}
                  customerCardExpanded={customerCardExpanded}
                  onToggleCustomerCardExpanded={() => setCustomerCardExpanded(!customerCardExpanded)}
                  language={language}
                />

                <DraftReviewBox
                  draftMessageId={draftMessageId}
                  draftExpanded={draftExpanded}
                  onToggleDraftExpanded={() => setDraftExpanded(!draftExpanded)}
                  draftIsAiGenerated={draftIsAiGenerated}
                  aiConfidenceScore={activeThread.aiConfidenceScore}
                  sending={sending}
                  onApproveDraft={handleApproveDraft}
                  draftEditing={draftEditing}
                  onToggleDraftEditing={() => {
                    setDraftExpanded(true);
                    setDraftEditing(!draftEditing);
                  }}
                  onDiscardDraft={() => {
                    setDraftMessageId(null);
                    setDraftEditing(false);
                  }}
                  draftText={draftText}
                  onDraftTextChange={setDraftText}
                />

                <MessagesTimeline
                  historyMessages={historyMessages}
                  messageScrollRef={messageScrollRef}
                  language={language}
                  onOpenInspectedLink={openInspectedLink}
                  onOpenAttachment={openAttachment}
                  onPreviewImage={(source, filename) => setImagePreview({ source, filename })}
                />

                <ThreadHistorySection
                  auditHistory={auditHistory}
                  historyOpen={historyOpen}
                  onToggleHistoryOpen={() => setHistoryOpen(!historyOpen)}
                  historyHeight={historyHeight}
                  onSetHistoryHeight={setHistoryHeight}
                  language={language}
                />
              </div>

              <ReplyComposer
                activeThread={activeThread}
                composerMode={composerMode}
                onSetComposerMode={setComposerMode}
                forwardTo={forwardTo}
                onForwardToChange={setForwardTo}
                replyText={replyText}
                onReplyTextChange={setReplyText}
                onReplyFocus={onReplyFocus}
                replyFiles={replyFiles}
                onSetReplyFiles={setReplyFiles}
                sending={sending}
                onSendReply={handleSendReply}
                onShowNotice={setNotice}
              />
            </>
          )}
        </div>
      </div>

      <ComposeModal
        isOpen={composeOpen}
        onClose={() => setComposeOpen(false)}
        sending={composeSending}
        accounts={accounts}
        composeAccountId={composeAccountId}
        onSetComposeAccountId={setComposeAccountId}
        composeTo={composeTo}
        onSetComposeTo={setComposeTo}
        composeCc={composeCc}
        onSetComposeCc={setComposeCc}
        composeBcc={composeBcc}
        onSetComposeBcc={setComposeBcc}
        composeSubject={composeSubject}
        onSetComposeSubject={setComposeSubject}
        composeBody={composeBody}
        onSetComposeBody={setComposeBody}
        composeFiles={composeFiles}
        onSetComposeFiles={setComposeFiles}
        onSubmitCompose={submitCompose}
        onShowNotice={setNotice}
      />

      <ImagePreviewModal
        imagePreview={imagePreview}
        onClose={() => setImagePreview(null)}
      />
    </main>
  );
}
