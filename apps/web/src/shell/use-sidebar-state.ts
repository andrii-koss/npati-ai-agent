import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useWorkspace } from "../BusinessWorkspace";
import { alertModal, confirmModal, promptModal } from "../ConfirmDialog";
import { useTranslation } from "../i18n";
import { authFetch } from "./auth-helpers";
import { chatOpen as loadChatOpen, isChatPage } from "../chat-open";
import {
  areSidebarConversationsEqual,
  clearLegacyLocalChatsOnce,
  fetchSidebarPage,
  getCachedBusinessOpen,
  getCachedChatOpen,
  getCachedSidebarBusinesses,
  getCachedSidebarConversations,
  getCachedSidebarDrafts,
  getInitialSidebarBusinesses,
  getInitialSidebarConversations,
  getIsSidebarConversationsLoaded,
  getCachedSidebarMore,
  setCachedSidebarMore,
  SIDEBAR_PAGE_SIZE,
  setCachedBusinessOpen,
  setCachedChatOpen,
  type SidebarConversation,
  updateCachedSidebarBusinesses,
  updateCachedSidebarConversations,
} from "./sidebar-cache";
import { listTransferChats } from "./chat-transfer";
import type { SidebarMenuTarget } from "./SidebarActionMenu";

function getInitialStringArray(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

export function useSidebarState(onClose?: () => void) {
  const location = useLocation();
  const navigate = useNavigate();
  const { overview, refresh, switchBusiness } = useWorkspace();
  const { t } = useTranslation();

  const [chatOpen, setChatOpen] = useState(getCachedChatOpen);
  const [, setBusinessOpen] = useState(getCachedBusinessOpen);
  const [conversations, setConversations] = useState<SidebarConversation[]>(getInitialSidebarConversations);
  const [hasLoaded, setHasLoaded] = useState(() => getIsSidebarConversationsLoaded() || getCachedSidebarConversations() !== null);
  const conversationLoadVersionRef = useRef(0);
  // Each route renders its own shell: a remounted sidebar continues from the pages loaded in this page session.
  const loadedCountRef = useRef(getIsSidebarConversationsLoaded() ? getInitialSidebarConversations().length : 0);
  const loadingMoreRef = useRef(false);
  const [moreConversations, setMoreConversationsState] = useState(getCachedSidebarMore);
  const setMoreConversations = (more: boolean) => { setCachedSidebarMore(more); setMoreConversationsState(more); };
  const initialBusinesses = useRef(getInitialSidebarBusinesses());
  const drafts = overview?.onboardings ?? getCachedSidebarDrafts() ?? initialBusinesses.current.drafts;
  const businesses = overview?.businesses ?? getCachedSidebarBusinesses() ?? initialBusinesses.current.businesses;
  const currentBusiness = overview?.currentBusiness;

  const [pinnedChatIds, setPinnedChatIds] = useState<string[]>(() => getInitialStringArray("npati_pinned_chats"));
  const [pinnedBusinessIds, setPinnedBusinessIds] = useState<string[]>(() => getInitialStringArray("npati_pinned_businesses"));
  const [archivedChatIds, setArchivedChatIds] = useState<string[]>(() => getInitialStringArray("npati_archived_chats"));
  const [archivedBusinessIds, setArchivedBusinessIds] = useState<string[]>(() => getInitialStringArray("npati_archived_businesses"));
  const [menuTarget, setMenuTarget] = useState<SidebarMenuTarget | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!menuTarget) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".sidebar-action-menu") || target?.closest(".sidebar-icon-action")) {
        return;
      }
      setMenuTarget(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuTarget(null);
    };
    const onScroll = () => {
      setMenuTarget(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menuTarget]);

  function togglePinChat(id: string) {
    setPinnedChatIds((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [id, ...prev];
      try {
        localStorage.setItem("npati_pinned_chats", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function togglePinBusiness(id: string) {
    setPinnedBusinessIds((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [id, ...prev];
      try {
        localStorage.setItem("npati_pinned_businesses", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function archiveChat(id: string) {
    setArchivedChatIds((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      try {
        localStorage.setItem("npati_archived_chats", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    setToast("Chat archived");
  }

  function archiveBusiness(id: string) {
    setArchivedBusinessIds((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      try {
        localStorage.setItem("npati_archived_businesses", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    setToast("Business archived");
  }

  async function shareLink(url: string, label: string) {
    try {
      await navigator.clipboard.writeText(url);
      setToast(`${label} link copied!`);
    } catch {
      await promptModal({
        title: `Copy ${label} link`,
        message: `Copy this ${label} link:`,
        defaultValue: url,
      });
    }
  }

  async function renameBusinessItem(id: string, currentName: string, isDraft?: boolean) {
    const res = await promptModal({
      title: "Rename business",
      message: `Enter a new name for "${currentName}":`,
      defaultValue: currentName,
      confirmText: "Rename",
    });
    const name = res?.trim();
    if (!name || name === currentName) return;
    if (isDraft) {
      const draft = drafts.find((d) => d.businessId === id);
      if (draft) {
        draft.business.name = name;
        updateCachedSidebarBusinesses(drafts, businesses);
        await refresh();
      }
      return;
    }
    const response = await authFetch(`/api/businesses/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (response.ok) {
      await refresh();
    }
  }

  useEffect(() => {
    if (overview) {
      updateCachedSidebarBusinesses(overview.onboardings, overview.businesses);
    }
  }, [overview]);

  async function loadConversations(force = false, optimisticConversation?: SidebarConversation) {
    // Moving between chats keeps the pages already loaded (and the user's place in the list); only a change
    // (a new message, rename or deletion) re-reads them, at their full loaded length.
    if (!force && loadedCountRef.current > 0) return;
    const loadVersion = ++conversationLoadVersionRef.current;
    try {
      // The first page comes with the chat page's single open request; a refresh re-reads the pages already shown.
      const page = !force && isChatPage() ? (await loadChatOpen()).chats as { items: SidebarConversation[]; more: boolean }
        : await fetchSidebarPage(0, Math.max(SIDEBAR_PAGE_SIZE, loadedCountRef.current));
      let nextRows = page.items;
      if (loadVersion !== conversationLoadVersionRef.current) return;
      setMoreConversations(page.more);
      loadedCountRef.current = nextRows.length;
      if (optimisticConversation && !nextRows.some((item) => item.id === optimisticConversation.id)) {
        nextRows = [optimisticConversation, ...nextRows];
      }
      updateCachedSidebarConversations(nextRows);
      setHasLoaded(true);
      setConversations((prev) => {
        if (areSidebarConversationsEqual(prev, nextRows)) return prev;
        return nextRows;
      });
    } catch {
      setHasLoaded(true);
      if (getCachedSidebarConversations() === null) setConversations([]);
    }
  }

  /** Appends the next sidebar page when the user scrolls to the end of the chat list. */
  async function loadMoreConversations() {
    if (!moreConversations || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    try {
      const page = await fetchSidebarPage(loadedCountRef.current);
      setMoreConversations(page.more);
      setConversations((current) => {
        const nextRows = [...current, ...page.items.filter((item) => !current.some((row) => row.id === item.id))];
        loadedCountRef.current = nextRows.length;
        updateCachedSidebarConversations(nextRows);
        return nextRows;
      });
    } catch {
      // The list keeps what is loaded; scrolling to the end again retries.
    } finally {
      loadingMoreRef.current = false;
    }
  }

  async function loadAllConversations() {
    const rows = await listTransferChats();
    ++conversationLoadVersionRef.current;
    loadedCountRef.current = rows.length;
    setMoreConversations(false);
    updateCachedSidebarConversations(rows);
    setConversations(rows);
    setHasLoaded(true);
    setChatOpen(true);
    setCachedChatOpen(true);
    return rows.filter(c => c.title !== "Business setup" && !onboardingConversationIds.has(c.id) && !archivedChatIds.includes(c.id));
  }

  useEffect(() => {
    clearLegacyLocalChatsOnce();
    void loadConversations();
    const reload = (event: Event) => {
      const optimisticConversation = (event as CustomEvent<{ conversation?: SidebarConversation }>).detail
        ?.conversation;
      if (optimisticConversation) {
        setConversations((current) => {
          const nextRows = [optimisticConversation, ...current.filter((item) => item.id !== optimisticConversation.id)]
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
          updateCachedSidebarConversations(nextRows);
          return nextRows;
        });
      }
      void loadConversations(true, optimisticConversation);
    };
    window.addEventListener("npati:conversations-changed", reload);
    window.addEventListener("npati:saved-chats-changed", reload);
    return () => {
      window.removeEventListener("npati:conversations-changed", reload);
      window.removeEventListener("npati:saved-chats-changed", reload);
    };
  }, [overview?.businesses.map((business) => business.id).join(",")]);

  useEffect(() => {
    if (location.pathname === "/business" || location.pathname.startsWith("/b/")) {
      setBusinessOpen(true);
      setCachedBusinessOpen(true);
    }
    if (location.pathname === "/chat" || location.pathname.startsWith("/c/")) {
      setChatOpen(true);
      setCachedChatOpen(true);
    }
  }, [location.pathname]);

  function openNewChat() {
    try {
      sessionStorage.removeItem("npati_active_project");
    } catch {}
    onClose?.();
    setChatOpen(true);
    setCachedChatOpen(true);
    navigate("/chat", { state: { newChat: Date.now() } });
  }

  async function openConversation(conversation: SidebarConversation) {
    onClose?.();
    if (conversation.businessId && conversation.businessId !== currentBusiness?.id) {
      await switchBusiness(conversation.businessId);
    }
    navigate(`/c/${conversation.id}`, {
      state: conversation.businessId ? { businessId: conversation.businessId } : { neutralChat: true },
    });
  }

  async function renameConversation(conversation: SidebarConversation) {
    const res = await promptModal({
      title: "Rename chat",
      message: "Enter a new title for this chat:",
      defaultValue: conversation.title,
      confirmText: "Rename",
    });
    const title = res?.trim();
    if (!title || title === conversation.title) return;
    const endpoint = conversation.businessId
      ? `/api/businesses/${conversation.businessId}/conversations/${conversation.id}`
      : `/api/conversations/${conversation.id}`;
    const response = await authFetch(endpoint, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (response.ok) await loadConversations(true);
  }

  async function deleteConversation(conversation: SidebarConversation) {
    const confirmed = await confirmModal({
      title: t("dialogs.deleteChatTitle"),
      message: t("dialogs.deleteChatMessage", { title: conversation.title }),
      confirmText: t("common.delete"),
      cancelText: t("common.cancel"),
      isDanger: true,
    });
    if (!confirmed) return;
    const endpoint = conversation.businessId
      ? `/api/businesses/${conversation.businessId}/conversations/${conversation.id}`
      : `/api/conversations/${conversation.id}`;
    const response = await authFetch(endpoint, { method: "DELETE" });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      await alertModal({
        title: "Delete failed",
        message: payload?.error?.message ?? "Could not delete this chat.",
        isDanger: true,
      });
      return;
    }
    const remaining = conversations.filter((item) => item.id !== conversation.id);
    updateCachedSidebarConversations(remaining);
    setConversations(remaining);
    window.dispatchEvent(new Event("npati:conversations-changed"));
    if (location.pathname === `/c/${conversation.id}`) {
      const next = remaining[0];
      if (!next) {
        navigate("/chat", { replace: true });
      } else {
        if (next.businessId && next.businessId !== currentBusiness?.id) await switchBusiness(next.businessId);
        navigate(`/c/${next.id}`, { replace: true });
      }
    }
  }

  function removeDeletedConversations(ids: string[]) {
    const deleted = new Set(ids);
    // Update the cache before navigation can remount the shell.
    const remaining = (getCachedSidebarConversations() ?? conversations).filter(chat => !deleted.has(chat.id));
    ++conversationLoadVersionRef.current;
    loadedCountRef.current = remaining.length;
    updateCachedSidebarConversations(remaining);
    setConversations(remaining);
    const nextPinned = pinnedChatIds.filter(id => !deleted.has(id));
    const nextArchived = archivedChatIds.filter(id => !deleted.has(id));
    setPinnedChatIds(nextPinned);
    setArchivedChatIds(nextArchived);
    try {
      localStorage.setItem("npati_pinned_chats", JSON.stringify(nextPinned));
      localStorage.setItem("npati_archived_chats", JSON.stringify(nextArchived));
    } catch { /* storage can be unavailable */ }
    window.dispatchEvent(new Event("npati:conversations-changed"));
    const activeId = location.pathname.startsWith("/c/") ? location.pathname.slice(3) : null;
    if (activeId && deleted.has(activeId)) navigate("/chat", { replace: true });
  }

  async function deleteBusiness(id: string, name: string) {
    const confirmed = await confirmModal({
      title: t("dialogs.deleteBusinessTitle"),
      message: t("dialogs.deleteBusinessMessage", { name }),
      confirmText: t("common.delete"),
      cancelText: t("common.cancel"),
      isDanger: true,
    });
    if (!confirmed) return;
    const response = await authFetch(`/api/businesses/${id}`, { method: "DELETE" });
    if (response.ok) {
      const remainingDrafts = (getCachedSidebarDrafts() ?? drafts).filter((item) => item.businessId !== id);
      const remainingBusinesses = (getCachedSidebarBusinesses() ?? businesses).filter((item) => item.id !== id);
      updateCachedSidebarBusinesses(remainingDrafts, remainingBusinesses);
      await refresh();
      navigate("/chat");
    }
  }

  const onboardingConversationIds = new Set(
    (overview?.onboardings ?? drafts).map((session) => session.conversationId).filter(Boolean)
  );
  const chatConversations = conversations.filter(
    (c) => c.title !== "Business setup" && !onboardingConversationIds.has(c.id) && !archivedChatIds.includes(c.id)
  );
  const pinnedChats = chatConversations.filter((c) => pinnedChatIds.includes(c.id));
  const unpinnedChats = chatConversations.filter((c) => !pinnedChatIds.includes(c.id));
  const hasSavedChats = chatConversations.length > 0;

  return {
    location,
    t,
    chatOpen,
    setChatOpen,
    openNewChat,
    hasSavedChats,
    hasLoaded,
    loadMoreConversations,
    loadAllConversations,
    pinnedChats,
    unpinnedChats,
    menuTarget,
    setMenuTarget,
    toast,
    togglePinChat,
    togglePinBusiness,
    archiveChat,
    archiveBusiness,
    shareLink,
    renameBusinessItem,
    openConversation,
    renameConversation,
    deleteConversation,
    removeDeletedConversations,
    deleteBusiness,
  };
}
