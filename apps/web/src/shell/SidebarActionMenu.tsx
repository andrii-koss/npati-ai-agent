import { createPortal } from "react-dom";
import type { CachedBusinessDraft, CachedBusinessItem, SidebarConversation } from "./sidebar-cache";
import { IconArchive, IconPin, IconRename, IconShare, IconTrash, IconUnpin } from "./sidebar-icons";

export type SidebarMenuTarget = {
  type: "chat" | "draft" | "business";
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
}: SidebarActionMenuProps) {
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
