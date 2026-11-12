import React from "react";
import type { CachedBusinessDraft, CachedBusinessItem, SidebarConversation } from "./sidebar-cache";
import { IconDots, IconPin, IconUnpin } from "./sidebar-icons";
import { useTranslation } from "../i18n";

export type BusinessListItem =
  | { kind: "draft"; id: string; name: string; subtitle: string; draft: CachedBusinessDraft }
  | { kind: "business"; id: string; name: string; subtitle: string; business: CachedBusinessItem };

interface ConversationRowProps {
  selected?: boolean;
  onSelect?: (id: string) => void;
  conversation: SidebarConversation;
  isPinned: boolean;
  isMenuOpen: boolean;
  isActive: boolean;
  activity?: { active: boolean; stopping: boolean; error?: string };
  onStop?: () => void;
  onOpen: (conversation: SidebarConversation) => void;
  onTogglePin: (id: string) => void;
  onOptionsClick: (e: React.MouseEvent<HTMLButtonElement>, conversation: SidebarConversation, isPinned: boolean) => void;
}

export function ConversationRow({
  selected,
  onSelect,
  conversation,
  isPinned,
  isMenuOpen,
  isActive,
  activity,
  onStop,
  onOpen,
  onTogglePin,
  onOptionsClick,
}: ConversationRowProps) {
  const { language } = useTranslation();
  const label = activity?.stopping
    ? (language === "uk" ? "Зупиняється" : "Stopping")
    : (language === "uk" ? "Зупинити задачі чату" : "Stop tasks in chat");
  const stopLabel = `${label}: ${conversation.title}`;
  const stopTitle = activity?.error
    ? (language === "uk" ? "Не вдалося зупинити. Спробуйте ще раз." : "Could not stop. Try again.")
    : stopLabel;
  return (
    <div
      className={`sidebar-history-row ${onSelect ? "is-selecting" : ""} ${activity?.active ? "has-activity" : ""} ${isActive ? "active" : ""} ${isPinned ? "is-pinned" : ""} ${isMenuOpen ? "menu-open" : ""}`}
      data-conversation-id={conversation.id}
      key={conversation.id}
    >
      {onSelect && <input type="checkbox" className="sidebar-chat-checkbox" checked={selected ?? false}
        aria-label={`${language === "uk" ? "Виділити" : "Select"} ${conversation.title}`}
        onChange={() => onSelect(conversation.id)} />}
      <button className="sidebar-history-link" onClick={() => onOpen(conversation)}>
        <span>{conversation.title}</span>
        <small>
          {conversation.businessName ? `${conversation.businessName} · ` : ""}
          {new Date(conversation.updatedAt).toLocaleDateString()}
        </small>
      </button>
      {activity?.active && <button
        type="button"
        className="sidebar-chat-activity"
        aria-label={stopLabel}
        title={stopTitle}
        disabled={activity.stopping}
        onClick={event => { event.preventDefault(); event.stopPropagation(); onStop?.(); }}
      >
        <span className="sidebar-chat-spinner" aria-hidden="true" />
        <svg className="sidebar-chat-stop" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
      </button>}
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
