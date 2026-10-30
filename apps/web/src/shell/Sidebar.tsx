import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { NpatiAgentLogo } from "./brand";
import { setCachedChatOpen, type SidebarConversation } from "./sidebar-cache";
import { IconClose } from "./sidebar-icons";
import { SidebarActionMenu } from "./SidebarActionMenu";
import { ConversationRow } from "./SidebarItemRows";
import { useSidebarState } from "./use-sidebar-state";
import { prefetchProjectCatalog } from "../project-catalog-client";

const navigation = ["Settings"];

export function Sidebar({ isOpen = false, onClose }: { isOpen?: boolean; onClose?: () => void } = {}) {
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
    deleteBusiness,
  } = useSidebarState(onClose);

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
        isPinned={isPinned}
        isMenuOpen={isMenuOpen}
        isActive={isActive}
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
    <aside className={`sidebar ${isOpen ? "mobile-open" : ""}`}>
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
            <Link
              key={item}
              className={`sidebar-settings-link ${location.pathname === href || location.pathname.startsWith(`${href}/`) ? "active" : ""}`}
              to={href}
              onMouseEnter={() => { if (href === "/settings/projects") prefetchProjectCatalog(); }}
              onFocus={() => { if (href === "/settings/projects") prefetchProjectCatalog(); }}
              onClick={onClose}
            >
              {item === "Settings" ? t("common.settings") : item === "Projects" ? "Projects" : item}
            </Link>
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
        />
      )}
      {toast && <div className="sidebar-toast">{toast}</div>}
      <div className="sidebar-footer-row">
        <LanguageSwitcher variant="full" />
      </div>
    </aside>
  );
}
