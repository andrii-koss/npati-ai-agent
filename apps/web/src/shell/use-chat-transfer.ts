import { useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "../i18n";
import { alertModal, confirmModal } from "../ConfirmDialog";
import { ChatDeletionError, deleteChats, exportChats, importChats, listTransferChats, parseChatImport } from "./chat-transfer";
import type { SidebarConversation } from "./sidebar-cache";

export function useChatTransfer(loadAll: () => Promise<SidebarConversation[]>, onDeleted: (ids: string[]) => void) {
  const location = useLocation();
  const { language } = useTranslation();
  const uk = language === "uk";
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [selection, setSelection] = useState<SidebarConversation[] | null>(null);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus(uk ? "Обробка чатів…" : "Processing chats…");
    try { await action(); }
    catch (error) {
      setStatus(uk ? "Операцію не завершено" : "Operation did not complete");
      const message = error instanceof ChatDeletionError && uk
        ? `Видалено ${error.deletedCount} із ${error.totalCount} чатів. Видалення зупинено через помилку. Решта чатів залишилися виділеними — можна повторити спробу.`
        : error instanceof Error ? error.message : String(error);
      await alertModal({ title: uk ? "Керування чатами" : "Manage chats", message, isDanger: true });
    } finally { busyRef.current = false; setBusy(false); }
  }

  function selectAll() {
    void run(async () => {
      const chats = await loadAll();
      setSelection(chats);
      setStatus(uk ? `Виділено чатів: ${chats.length}` : `Selected chats: ${chats.length}`);
    });
  }

  function toggleSelection(chat: SidebarConversation) {
    if (busyRef.current) return;
    setSelection(current => current?.some(row => row.id === chat.id)
      ? current.filter(row => row.id !== chat.id) : [...(current ?? []), chat]);
  }

  function deleteSelected() {
    const chats = [...(selection ?? [])];
    if (!chats.length) return;
    // Keep the current page mounted on partial failure, so remaining selections survive for retry.
    const activeId = location.pathname.startsWith("/c/") ? location.pathname.slice(3) : null;
    chats.sort((left, right) => Number(left.id === activeId) - Number(right.id === activeId));
    void run(async () => {
      const confirmed = await confirmModal({
        title: uk ? `Видалити вибрані чати (${chats.length})?` : `Delete selected chats (${chats.length})?`,
        message: uk
          ? `Буде видалено чатів: ${chats.length}, разом з усіма їхніми повідомленнями. Цю дію неможливо скасувати.`
          : `${chats.length} chats and all their messages will be permanently deleted. This cannot be undone.`,
        confirmText: uk ? "Видалити" : "Delete", cancelText: uk ? "Скасувати" : "Cancel", isDanger: true,
      });
      if (!confirmed) { setStatus(""); return; }
      const count = await deleteChats(chats, ids => {
        const removed = new Set(ids);
        setSelection(current => current?.filter(chat => !removed.has(chat.id)) ?? null);
        onDeleted(ids);
      }, count => setStatus(uk ? `Видалено чатів: ${count} / ${chats.length}` : `Deleted chats: ${count} / ${chats.length}`));
      setSelection(null);
      setStatus(uk ? `Видалено чатів: ${count}` : `Deleted chats: ${count}`);
    });
  }

  function exportAll() {
    void run(async () => {
      const chats = await listTransferChats();
      await exportChats(chats);
      setStatus(uk ? `Експортовано чатів: ${chats.length}` : `Exported chats: ${chats.length}`);
    });
  }

  function exportSelected() {
    const chats = selection ?? [];
    if (!chats.length) return;
    void run(async () => {
      await exportChats(chats);
      setStatus(uk ? `Експортовано чатів: ${chats.length}` : `Exported chats: ${chats.length}`);
    });
  }

  function importFile(file: File) {
    void run(async () => {
      if (file.size > 100 * 1024 * 1024) throw new Error(uk ? "Файл перевищує 100 МБ" : "File exceeds 100 MB");
      const chats = parseChatImport(JSON.parse(await file.text()));
      const count = await importChats(chats, () => window.dispatchEvent(new Event("npati:conversations-changed")));
      setStatus(uk ? `Імпортовано чатів: ${count}` : `Imported chats: ${count}`);
    });
  }

  return { uk, busy, status, inputRef, selection, selectAll, toggleSelection, exportAll, exportSelected, deleteSelected, importFile,
    cancelSelection: () => { setSelection(null); setStatus(""); } };
}
