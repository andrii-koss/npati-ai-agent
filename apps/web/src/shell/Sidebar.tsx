import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { NpatiAgentLogo } from "./brand";
import { setCachedChatOpen, type SidebarConversation } from "./sidebar-cache";
import { IconClose, IconDots, IconTrash } from "./sidebar-icons";
import { useChatTransfer } from "./use-chat-transfer";
import { SidebarActionMenu } from "./SidebarActionMenu";
import { ConversationRow } from "./SidebarItemRows";
import { useSidebarState } from "./use-sidebar-state";
import { prefetchProjectCatalog } from "../project-catalog-client";
import { prefetchSettingsPage } from "../settings-prefetch";
import { conversationActivity, stopConversationActivity, useChatActivity } from "../chat-activity";

const navigation = ["Settings"];

/** The width below which the sidebar is a menu that slides in (09-chat-and-company-config.css). */
const NARROW = "(max-width: 760px)";
function useNarrowScreen() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return narrow;
}

export function Sidebar({ isOpen = false, onClose }: { isOpen?: boolean; onClose?: () => void } = {}) {
  const activity = useChatActivity();
  const narrow = useNarrowScreen();
  const {
    location,
    t,
    chatOpen,
    setChatOpen,
    openNewChat,
    hasSavedChats,
    hasLoaded,
    pinnedChats,
    unpinnedChats,
    loadMoreConversations,
    loadAllConversations,
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
  } = useSidebarState(onClose);
  const transfer = useChatTransfer(loadAllConversations, removeDeletedConversations);

  // Each route renders its own shell: keep the open chat visible in the list after navigation.
  const chatListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chatListRef.current?.querySelector<HTMLElement>(".sidebar-history-row.active")?.scrollIntoView({ block: "nearest" });
  }, [location.pathname, chatOpen]);

  function renderConversationRow(conversation: SidebarConversation, isPinned: boolean) {
    const isMenuOpen = menuTarget?.type === "chat" && menuTarget.id === conversation.id;
    const isActive = location.pathname === `/c/${conversation.id}` || window.location.pathname === `/c/${conversation.id}`;
    return (
      <ConversationRow
        key={conversation.id}
        conversation={conversation}
        selected={transfer.selection?.some(row => row.id === conversation.id)}
        onSelect={transfer.selection !== null ? () => transfer.toggleSelection(conversation) : undefined}
        isPinned={isPinned}
        isMenuOpen={isMenuOpen}
        isActive={isActive}
        activity={conversationActivity(activity, conversation.id)}
        onStop={() => { void stopConversationActivity(conversation.id); }}
        onOpen={(c) => void openConversation(c)}
        onTogglePin={togglePinChat}
        onOptionsClick={(e, c, pinned) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const sidebarEl = e.currentTarget.closest(".sidebar");
          const sidebarRight = sidebarEl ? sidebarEl.getBoundingClientRect().right : 230;
          const left = Math.min(Math.max(rect.right + 10, sidebarRight + 8), window.innerWidth - 190);
          const top = Math.max(10, Math.min(rect.top - 6, window.innerHeight - 250));
          setMenuTarget(
            isMenuOpen
              ? null
              : {
                  type: "chat",
                  id: c.id,
                  title: c.title,
                  isPinned: pinned,
                  top,
                  left,
                  data: c,
                }
          );
        }}
      />
    );
  }

  return (
    // On a phone the closed menu is off screen: it must also leave the Tab order. A keyboard user went through the
    // whole chat history, unseen, and 90 Tabs did not reach the message box (V6 step 15).
    <aside className={`sidebar ${isOpen ? "mobile-open" : ""}`} inert={narrow && !isOpen ? true : undefined} aria-hidden={narrow && !isOpen ? true : undefined}>
      <div className="sidebar-mobile-head">
        <Link className="brand" to="/chat" onClick={onClose}>
          <NpatiAgentLogo />
        </Link>
        <button type="button" className="sidebar-close-button" aria-label="Close menu" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <Link className="brand sidebar-brand" to="/chat">
        <NpatiAgentLogo />
      </Link>
      <nav>
        <div
          className={`sidebar-group ${location.pathname === "/chat" || location.pathname.startsWith("/c/") || window.location.pathname === "/chat" || window.location.pathname.startsWith("/c/") ? "active" : ""}`}
        >
          <div className="sidebar-group-head">
            <button className="sidebar-main-action" onClick={() => void openNewChat()}>
              {t("sidebar.newChat")}
            </button>
            <button
              className="sidebar-chevron"
              aria-label="Show chat history"
              aria-expanded={chatOpen}
              onClick={() =>
                setChatOpen((open) => {
                  const next = !open;
                  setCachedChatOpen(next);
                  return next;
                })
              }
            />
          </div>
          {chatOpen && (
            <div className="sidebar-dropdown" ref={chatListRef} onScroll={(event) => {
              const list = event.currentTarget;
              if (list.scrollHeight - list.scrollTop - list.clientHeight < 60) void loadMoreConversations();
            }}>
              {transfer.selection !== null && <div className="sidebar-bulk-actions">
                <span>{transfer.uk ? "Виділено" : "Selected"}: {transfer.selection.length}</span>
                <button type="button" disabled={transfer.busy || !transfer.selection.length} onClick={transfer.exportSelected}>
                  {transfer.uk ? "Експортувати" : "Export"}
                </button>
                <button type="button" className="danger sidebar-bulk-delete" disabled={transfer.busy || !transfer.selection.length} onClick={transfer.deleteSelected}
                  aria-label={transfer.uk ? "Видалити вибрані" : "Delete selected"}
                  title={transfer.uk ? "Видалити вибрані" : "Delete selected"}>
                  <IconTrash />
                </button>
                <button type="button" disabled={transfer.busy} onClick={transfer.cancelSelection}>
                  {transfer.uk ? "Скасувати" : "Cancel"}
                </button>
              </div>}
              {!hasSavedChats && hasLoaded && <small className="sidebar-empty">{t("sidebar.noSavedChats")}</small>}
              {pinnedChats.length > 0 && (
                <>
                  <div className="sidebar-section-header">{t("sidebar.pinned")}</div>
                  {pinnedChats.map((conversation) => renderConversationRow(conversation, true))}
                </>
              )}
              {unpinnedChats.length > 0 && (
                <>
                  {pinnedChats.length > 0 && <div className="sidebar-section-header">{t("sidebar.recent")}</div>}
                  {unpinnedChats.map((conversation) => renderConversationRow(conversation, false))}
                </>
              )}
            </div>
          )}
        </div>
        {navigation.map((item) => {
          const href = item === "Projects" ? "/settings/projects" : `/${item.toLowerCase()}`;
          return (
            <div key={item} className={`sidebar-settings-row ${menuTarget?.type === "settings" ? "menu-open" : ""}`}>
            <Link
              className={`sidebar-settings-link ${location.pathname === href || location.pathname.startsWith(`${href}/`) ? "active" : ""}`}
              to={href}
              onMouseEnter={() => { if (href === "/settings/projects") prefetchProjectCatalog(); else prefetchSettingsPage(href); }}
              onFocus={() => { if (href === "/settings/projects") prefetchProjectCatalog(); else prefetchSettingsPage(href); }}
              onClick={onClose}
            >
              {item === "Settings" ? t("common.settings") : item === "Projects" ? "Projects" : item}
            </Link>
            <button type="button" className={`sidebar-icon-action ${menuTarget?.type === "settings" ? "active" : ""}`}
              aria-label={transfer.uk ? "Опції Settings" : "Options for Settings"}
              aria-haspopup="menu" aria-expanded={menuTarget?.type === "settings"}
              title={transfer.uk ? "Керування чатами" : "Manage chats"}
              onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect();
                const sidebarRight = event.currentTarget.closest(".sidebar")?.getBoundingClientRect().right ?? 230;
                setMenuTarget(menuTarget?.type === "settings" ? null : {
                  type: "settings", id: "settings", title: "Settings", isPinned: false, data: {},
                  left: Math.max(8, Math.min(Math.max(rect.right + 10, sidebarRight + 8), window.innerWidth - 190)),
                  top: Math.max(10, Math.min(rect.top - 6, window.innerHeight - 200)),
                });
              }}><IconDots /></button>
            </div>
          );
        })}
      </nav>

      {menuTarget && (
        <SidebarActionMenu
          menuTarget={menuTarget}
          onClose={() => setMenuTarget(null)}
          onShare={(url, label) => void shareLink(url, label)}
          onRenameChat={(c) => void renameConversation(c)}
          onRenameBusiness={(id, name, isDraft) => void renameBusinessItem(id, name, isDraft)}
          onTogglePinChat={togglePinChat}
          onTogglePinBusiness={togglePinBusiness}
          onArchiveChat={archiveChat}
          onArchiveBusiness={archiveBusiness}
          onDeleteChat={(c) => void deleteConversation(c)}
          onDeleteBusiness={(id, title) => void deleteBusiness(id, title)}
          onSelectAllChats={transfer.selectAll}
          onImportChats={() => transfer.inputRef.current?.click()}
          onExportChats={transfer.exportAll}
          busy={transfer.busy}
        />
      )}
      {toast && <div className="sidebar-toast">{toast}</div>}
      <input ref={transfer.inputRef} type="file" accept=".json,application/json" hidden
        aria-label={transfer.uk ? "Імпортувати чати з JSON" : "Import chats from JSON"}
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) transfer.importFile(file);
        }} />
      {transfer.status && <div className="sidebar-transfer-status" role="status" aria-live="polite">{transfer.status}</div>}
      <div className="sidebar-footer-row">
        <LanguageSwitcher variant="full" />
      </div>
    </aside>
  );
}
