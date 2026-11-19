import { readSettingsSnapshot, requestSettingsRead, writeSettingsSnapshot } from "./settings-page-cache";
import { inboxThreadsKey, inboxCountsKey, inboxDetailKey, readInboxOpen, type InboxFilters, type InboxFolderCounts, type InboxDetail } from "./inbox-cache";
import { ALL_COMPANIES } from "./company-scope";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { readCachedCompanies, writeActiveCompanyId, writeCachedCompanies } from "./active-company";
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

const FOLDER_PREFETCH_DELAY_MS = 120;
const FOLDER_PREFETCH_MAX_AGE_MS = 4_000;

export function EmailInboxPage() {
  const { t, language } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialCompanies = useMemo(() => readCachedCompanies<Company>(), []);
  const [companies, setCompanies] = useState<Company[]>(initialCompanies);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>(() => {
    const requested = searchParams.get("company");
    return requested || ALL_COMPANIES;
  });
  const initialFilters = useMemo<InboxFilters>(() => ({ companyId: selectedCompanyId, folder: "inbox", accountId: "all", status: "all", priority: "all", search: "" }), []);
  const initialThreads = useMemo(() => readSettingsSnapshot<EmailThread[]>(inboxThreadsKey(initialFilters)), []);
  const [accounts, setAccounts] = useState<EmailAccount[]>(() => readSettingsSnapshot<EmailAccount[]>(`email-accounts:${selectedCompanyId}`) ?? []);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("all");

  const [folder, setFolder] = useState<EmailFolder>("inbox");
  const [folderCounts, setFolderCounts] = useState(() => readSettingsSnapshot<InboxFolderCounts>(inboxCountsKey(selectedCompanyId, "all")) ?? null);
  const [threads, setThreads] = useState<EmailThread[]>(initialThreads ?? []);
  const [threadsLoading, setThreadsLoading] = useState(!initialThreads);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialThreads?.[0]?.id ?? null);
  const selectedThreadRef = useRef(selectedThreadId); selectedThreadRef.current = selectedThreadId;
  const threadCompanyId = threads.find(thread => thread.id === selectedThreadId)?.companyId || (selectedCompanyId === ALL_COMPANIES ? "" : selectedCompanyId);
  const [activeThread, setActiveThread] = useState<EmailThread | null>(null);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [contact, setContact] = useState<ContactDetails | null>(null);
  const [customerContext, setCustomerContext] = useState<CustomerContext>({ previousThreads: [], tasks: [] });
  const [notifications, setNotifications] = useState<EmailNotification[]>(() => readSettingsSnapshot<EmailNotification[]>(`inbox-notifications:${selectedCompanyId}`) ?? []);
  const [auditHistory, setAuditHistory] = useState<EmailAuditEntry[]>([]);
  const [threadOpenVersion, setThreadOpenVersion] = useState(0);
  const [imagePreview, setImagePreview] = useState<{ source: string; filename: string } | null>(null);
  const threadRequestIdRef = useRef(0);
  const deletedThreadIdsRef = useRef(new Set<string>());
  const messageScrollRef = useRef<HTMLDivElement | null>(null);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const filters: InboxFilters = { companyId: selectedCompanyId, folder, accountId: selectedAccountId, status: statusFilter, priority: priorityFilter, search: searchQuery };
  const threadSnapshotKey = inboxThreadsKey(filters);
  const [readyFilter, setReadyFilter] = useState<string | null>(null);
  const readyFilterRef = useRef(readyFilter);
  const providedDetail = useRef<string | null>(null);
  const pendingMailbox = useRef<string | null>(null);
  const folderHoverTimer = useRef<number | undefined>(undefined);
  const prefetchedFolder = useRef<{
    key: string;
    owner: ReturnType<typeof getStoredAuthToken>;
    startedAt: number;
    response: ReturnType<typeof readInboxOpen>;
  } | null>(null);
  const locationQuery = useRef(searchParams); locationQuery.current = searchParams;

  // Composer State
  const [replyText, setReplyText] = useState("");
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const [composerMode, setComposerMode] = useState<"reply" | "reply_all" | "forward">("reply");
  const [forwardTo, setForwardTo] = useState("");
  const [draftEditing, setDraftEditing] = useState(false);
  const draftEditingRef = useRef(draftEditing); draftEditingRef.current = draftEditing;
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

    if (thread.unreadCount <= 0) return;
    const unreadCount = thread.unreadCount;
    setThreads((current) => {
      const next = current.map(item => item.id === thread.id ? { ...item, unreadCount: 0 } : item);
      writeSettingsSnapshot(inboxThreadsKey(filters), next);
      return next;
    });
    setFolderCounts((current) => current && ({ ...current, inbox: Math.max(0, current.inbox - unreadCount) }));
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

  function applyDetail(result: InboxDetail, companyId: string, preserveDraft = false) {
    setActiveThread({ ...result.thread, companyId });
    setMessages(result.messages);
    setContact(result.contact);
    setCustomerContext(result.customerContext);
    setAuditHistory(result.logs);
    if (preserveDraft) return;
    const draft = [...result.messages].reverse().find(message => message.isDraft);
    setDraftMessageId(draft?.id ?? null);
    setDraftText(draft?.bodyText ?? "");
    setDraftIsAiGenerated(draft?.isAiGenerated ?? false);
  }

  function clearDetail() {
    setActiveThread(null);
    setMessages([]);
    setContact(null);
    setCustomerContext({ previousThreads: [], tasks: [] });
    setAuditHistory([]);
    setDraftMessageId(null);
    setDraftText("");
    setDraftIsAiGenerated(false);
  }

  function cancelFolderHover() {
    window.clearTimeout(folderHoverTimer.current);
  }

  function prefetchFolder(nextFolder: EmailFolder) {
    cancelFolderHover();
    if (nextFolder === folder || readyFilter !== threadSnapshotKey) return;
    const nextFilters = { ...filters, folder: nextFolder };
    const key = inboxThreadsKey(nextFilters);
    if (readSettingsSnapshot<EmailThread[]>(key)) return;

    folderHoverTimer.current = window.setTimeout(() => {
      const owner = getStoredAuthToken();
      const startedAt = Date.now();
      const cached = prefetchedFolder.current;
      if (cached?.key === key && cached.owner === owner && startedAt - cached.startedAt < FOLDER_PREFETCH_MAX_AGE_MS) return;
      const response = readInboxOpen(nextFilters);
      prefetchedFolder.current = { key, owner, startedAt, response };
      void response.catch(() => {
        if (prefetchedFolder.current?.response === response) prefetchedFolder.current = null;
      });
    }, FOLDER_PREFETCH_DELAY_MS);
  }

  async function loadThreads() {
    const snapshotKey = inboxThreadsKey(filters);
    const requestId = ++threadRequestIdRef.current;
    const owner = getStoredAuthToken();
    const current = () => requestId === threadRequestIdRef.current && owner === getStoredAuthToken();
    const changedFilter = readyFilterRef.current !== snapshotKey;
    const countsKey = inboxCountsKey(selectedCompanyId, selectedAccountId);
    const cached = readSettingsSnapshot<EmailThread[]>(snapshotKey);
    const selectedAtStart = changedFilter ? cached?.[0]?.id : selectedThreadRef.current;

    pendingMailbox.current = snapshotKey;
    if (changedFilter) {
      setThreads(cached ?? []);
      setSelectedThreadId(selectedAtStart ?? null);
      setFolderCounts(readSettingsSnapshot<InboxFolderCounts>(countsKey) ?? null);
      setThreadsLoading(!cached);
    }

    try {
      const prefetched = prefetchedFolder.current;
      const canReuse = changedFilter && !cached && prefetched?.key === snapshotKey &&
        prefetched.owner === owner && Date.now() - prefetched.startedAt < FOLDER_PREFETCH_MAX_AGE_MS;
      if (canReuse) prefetchedFolder.current = null;
      const result = await (canReuse ? prefetched.response : readInboxOpen(filters, selectedAtStart));
      if (!current()) return;
      const visible = result.threads.filter(thread => !deletedThreadIdsRef.current.has(thread.id));
      const requested = changedFilter ? selectedAtStart : selectedThreadRef.current;
      const nextId = visible.some(thread => thread.id === requested) ? requested : visible[0]?.id;
      const detail = result.detail;
      providedDetail.current = null;
      if (detail && detail.thread.id === nextId) {
        const companyId = detail.thread.companyId || selectedCompanyId;
        const key = inboxDetailKey(companyId, detail.thread.id);
        const previous = readSettingsSnapshot<InboxDetail>(key);
        providedDetail.current = key;
        writeSettingsSnapshot(key, detail, false);
        if (changedFilter || nextId !== selectedThreadRef.current || JSON.stringify(detail) !== JSON.stringify(previous)) {
          applyDetail(detail, companyId, !changedFilter && nextId === selectedThreadRef.current && draftEditingRef.current);
        }
      }
      readyFilterRef.current = snapshotKey;
      setReadyFilter(snapshotKey);
      writeCachedCompanies(result.companies);
      writeSettingsSnapshot(snapshotKey, visible);
      writeSettingsSnapshot(countsKey, result.counts);
      writeSettingsSnapshot(`email-accounts:${selectedCompanyId}`, result.accounts);
      writeSettingsSnapshot(`inbox-notifications:${selectedCompanyId}`, result.notifications);
      setCompanies(result.companies);
      setAccounts(result.accounts);
      setFolderCounts(result.counts);
      setNotifications(result.notifications);
      setThreads(visible);
      setSelectedThreadId(nextId ?? null);
      setThreadsLoading(false);

      const params = locationQuery.current;
      const account = params.get("account");
      const initial = result.accounts.find(item => item.id === account)?.id ?? result.accounts[0]?.id;
      if (initial) setComposeAccountId(previous => previous || initial);
      if (initial && params.get("compose") === "1") {
        setComposeAccountId(initial);
        setComposeOpen(true);
        setSearchParams({}, { replace: true });
      } else if (params.has("company")) {
        const next = new URLSearchParams(params);
        next.delete("company");
        setSearchParams(next, { replace: true });
      }
    } catch (error) {
      if (current()) {
        setThreadsLoading(false);
        if ((error as Error).name !== "AbortError") setNotice((error as Error).message);
      }
    } finally {
      if (current()) pendingMailbox.current = null;
    }
  }

  useEffect(() => {
    void loadThreads();
    const refresh = () => {
      if (!document.hidden && !pendingMailbox.current) void loadThreads();
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    return () => {
      ++threadRequestIdRef.current;
      pendingMailbox.current = null;
      cancelFolderHover();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [threadSnapshotKey]);

  // The mailbox response includes the initial conversation. Fetch detail only for another selection.
  useEffect(() => {
    if (!threadCompanyId || !selectedThreadId) {
      clearDetail();
      return;
    }

    const key = inboxDetailKey(threadCompanyId, selectedThreadId);
    if (providedDetail.current === key) return;
    const cached = readSettingsSnapshot<InboxDetail>(key);
    if (cached) applyDetail(cached, threadCompanyId);
    else clearDetail();
    if (readyFilter !== threadSnapshotKey) return;

    let active = true;
    const owner = getStoredAuthToken();
    const current = () => active && getStoredAuthToken() === owner;
    void requestSettingsRead(key, () => api<InboxDetail>(`/companies/${threadCompanyId}/email-inbox/threads/${selectedThreadId}?includeAudit=true`), false)
      .then(result => { if (current()) applyDetail(result, threadCompanyId); })
      .catch(error => { if (current() && error.name !== "AbortError") setNotice(error.message); });
    return () => { active = false; };
  }, [threadCompanyId, selectedThreadId, readyFilter, threadSnapshotKey]);

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
          onFolderHover={prefetchFolder}
          onFolderLeave={cancelFolderHover}
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
          loading={threadsLoading}
          listKey={threadSnapshotKey}
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
