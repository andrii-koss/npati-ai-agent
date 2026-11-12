import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import { CheckSquare, Download, Upload } from "lucide-react";
import { useTranslation } from "../i18n";
import type { CachedBusinessDraft, CachedBusinessItem, SidebarConversation } from "./sidebar-cache";
import { IconArchive, IconPin, IconRename, IconShare, IconTrash, IconUnpin } from "./sidebar-icons";

export type SidebarMenuTarget = {
  type: "chat" | "draft" | "business" | "settings";
  id: string;
  title: string;
  isPinned: boolean;
  top: number;
  left: number;
  data: SidebarConversation | CachedBusinessDraft | CachedBusinessItem | Record<string, unknown>;
};

interface SidebarActionMenuProps {
  menuTarget: SidebarMenuTarget;
  onClose: () => void;
  onShare: (url: string, label: string) => void;
  onRenameChat: (conversation: SidebarConversation) => void;
  onRenameBusiness: (id: string, name: string, isDraft?: boolean) => void;
  onTogglePinChat: (id: string) => void;
  onTogglePinBusiness: (id: string) => void;
  onArchiveChat: (id: string) => void;
  onArchiveBusiness: (id: string) => void;
  onDeleteChat: (conversation: SidebarConversation) => void;
  onDeleteBusiness: (id: string, title: string) => void;
  onSelectAllChats: () => void;
  onImportChats: () => void;
  onExportChats: () => void;
  busy?: boolean;
}

export function SidebarActionMenu({
  menuTarget,
  onClose,
  onShare,
  onRenameChat,
  onRenameBusiness,
  onTogglePinChat,
  onTogglePinBusiness,
  onArchiveChat,
  onArchiveBusiness,
  onDeleteChat,
  onDeleteBusiness,
  onSelectAllChats,
  onImportChats,
  onExportChats,
  busy,
}: SidebarActionMenuProps) {
  const { language } = useTranslation();
  const uk = language === "uk";
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (menuTarget.type !== "settings") return;
    const trigger = document.activeElement as HTMLElement | null;
    const menu = settingsMenuRef.current;
    menu?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      if (menu?.contains(document.activeElement) || document.activeElement === document.body) trigger?.focus();
    };
  }, [menuTarget.type]);
  if (menuTarget.type === "settings") return createPortal(
    <div ref={settingsMenuRef} className="sidebar-action-menu" role="menu" aria-label={uk ? "Керування чатами" : "Manage chats"}
      onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }}
      style={{ top: menuTarget.top, left: menuTarget.left }}>
      <button role="menuitem" className="sidebar-action-item" disabled={busy} onClick={() => { onClose(); onSelectAllChats(); }}>
        <CheckSquare size={16} /><span>{uk ? "Вибрати всі" : "Select all"}</span>
      </button>
      <div className="sidebar-action-divider" />
      <button role="menuitem" className="sidebar-action-item" disabled={busy} onClick={() => { onClose(); onImportChats(); }}>
        <Upload size={16} /><span>{uk ? "Імпортувати чати" : "Import chats"}</span>
      </button>
      <button role="menuitem" className="sidebar-action-item" disabled={busy} onClick={() => { onClose(); onExportChats(); }}>
        <Download size={16} /><span>{uk ? "Експортувати всі чати" : "Export all chats"}</span>
      </button>
    </div>, document.body
  );
  const handleShare = () => {
    if (menuTarget.type === "chat") {
      onShare(`${window.location.origin}/c/${menuTarget.id}`, "Chat");
    } else {
      onShare(`${window.location.origin}/b/${menuTarget.id}`, "Business");
    }
    onClose();
  };

  const handleRename = () => {
    if (menuTarget.type === "chat") {
      onRenameChat(menuTarget.data as SidebarConversation);
    } else if (menuTarget.type === "draft") {
      onRenameBusiness(menuTarget.id, menuTarget.title, true);
    } else {
      onRenameBusiness(menuTarget.id, menuTarget.title, false);
    }
    onClose();
  };

  const handleTogglePin = () => {
    if (menuTarget.type === "chat") {
      onTogglePinChat(menuTarget.id);
    } else {
      onTogglePinBusiness(menuTarget.id);
    }
    onClose();
  };

  const handleArchive = () => {
    if (menuTarget.type === "chat") {
      onArchiveChat(menuTarget.id);
    } else {
      onArchiveBusiness(menuTarget.id);
    }
    onClose();
  };

  const handleDelete = () => {
    if (menuTarget.type === "chat") {
      onDeleteChat(menuTarget.data as SidebarConversation);
    } else {
      onDeleteBusiness(menuTarget.id, menuTarget.title);
    }
    onClose();
  };

  return createPortal(
    <div
      className="sidebar-action-menu"
      style={{ top: menuTarget.top, left: menuTarget.left }}
    >
      <button className="sidebar-action-item" onClick={handleShare}>
        <IconShare />
        <span>Share</span>
      </button>
      <button className="sidebar-action-item" onClick={handleRename}>
        <IconRename />
        <span>Rename</span>
      </button>
      <div className="sidebar-action-divider" />
      <button className="sidebar-action-item" onClick={handleTogglePin}>
        {menuTarget.isPinned ? <IconUnpin /> : <IconPin />}
        <span>
          {menuTarget.isPinned
            ? menuTarget.type === "chat"
              ? "Unpin chat"
              : "Unpin business"
            : menuTarget.type === "chat"
              ? "Pin chat"
              : "Pin business"}
        </span>
      </button>
      <button className="sidebar-action-item" onClick={handleArchive}>
        <IconArchive />
        <span>Archive</span>
      </button>
      <button className="sidebar-action-item danger" onClick={handleDelete}>
        <IconTrash />
        <span>Delete</span>
      </button>
    </div>,
    document.body
  );
}
