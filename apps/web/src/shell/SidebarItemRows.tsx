import React from "react";
import type { CachedBusinessDraft, CachedBusinessItem, SidebarConversation } from "./sidebar-cache";
import { IconDots, IconPin, IconUnpin } from "./sidebar-icons";

export type BusinessListItem =
  | { kind: "draft"; id: string; name: string; subtitle: string; draft: CachedBusinessDraft }
  | { kind: "business"; id: string; name: string; subtitle: string; business: CachedBusinessItem };

interface ConversationRowProps {
  conversation: SidebarConversation;
  isPinned: boolean;
  isMenuOpen: boolean;
  isActive: boolean;
  onOpen: (conversation: SidebarConversation) => void;
  onTogglePin: (id: string) => void;
  onOptionsClick: (e: React.MouseEvent<HTMLButtonElement>, conversation: SidebarConversation, isPinned: boolean) => void;
}

export function ConversationRow({
  conversation,
  isPinned,
  isMenuOpen,
  isActive,
  onOpen,
  onTogglePin,
  onOptionsClick,
}: ConversationRowProps) {
  return (
    <div
      className={`sidebar-history-row ${isActive ? "active" : ""} ${isPinned ? "is-pinned" : ""} ${isMenuOpen ? "menu-open" : ""}`}
      key={conversation.id}
    >
      <button className="sidebar-history-link" onClick={() => onOpen(conversation)}>
        <span>{conversation.title}</span>
        <small>
          {conversation.businessName ? `${conversation.businessName} · ` : ""}
          {new Date(conversation.updatedAt).toLocaleDateString()}
        </small>
      </button>
      <button
        className={`sidebar-icon-action ${isPinned ? "pinned" : ""}`}
        aria-label={isPinned ? `Unpin ${conversation.title}` : `Pin ${conversation.title}`}
        title={isPinned ? "Unpin chat" : "Pin chat"}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(conversation.id);
        }}
      >
        {isPinned ? <IconUnpin /> : <IconPin />}
      </button>
      <button
        className={`sidebar-icon-action ${isMenuOpen ? "active" : ""}`}
        aria-label={`Options for ${conversation.title}`}
        title="More options"
        onClick={(e) => onOptionsClick(e, conversation, isPinned)}
      >
        <IconDots />
      </button>
    </div>
  );
}

interface BusinessItemRowProps {
  item: BusinessListItem;
  isPinned: boolean;
  isMenuOpen: boolean;
  isActive: boolean;
  onOpen: () => void;
  onTogglePin: (id: string) => void;
  onOptionsClick: (e: React.MouseEvent<HTMLButtonElement>, item: BusinessListItem, isPinned: boolean) => void;
}

export function BusinessItemRow({
  item,
  isPinned,
  isMenuOpen,
  isActive,
  onOpen,
  onTogglePin,
  onOptionsClick,
}: BusinessItemRowProps) {
  return (
    <div
      className={`sidebar-history-row ${isActive ? "active" : ""} ${isPinned ? "is-pinned" : ""} ${isMenuOpen ? "menu-open" : ""}`}
      key={item.id}
    >
      <button className="sidebar-history-link" onClick={onOpen}>
        <span>{item.name}</span>
        <small>{item.subtitle}</small>
      </button>
      <button
        className={`sidebar-icon-action ${isPinned ? "pinned" : ""}`}
        aria-label={isPinned ? `Unpin ${item.name}` : `Pin ${item.name}`}
        title={isPinned ? "Unpin business" : "Pin business"}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(item.id);
        }}
      >
        {isPinned ? <IconUnpin /> : <IconPin />}
      </button>
      <button
        className={`sidebar-icon-action ${isMenuOpen ? "active" : ""}`}
        aria-label={`Options for ${item.name}`}
        title="More options"
        onClick={(e) => onOptionsClick(e, item, isPinned)}
      >
        <IconDots />
      </button>
    </div>
  );
}
