import { authFetch } from "./auth-helpers";
import { fetchSidebarPage, type SidebarConversation } from "./sidebar-cache";

export type TransferChat = {
  title: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string; createdAt?: string }>;
};

export class ChatDeletionError extends Error {
  constructor(public deletedCount: number, public totalCount: number, cause: unknown) {
    super(`Deleted ${deletedCount} of ${totalCount} chats. Deletion stopped.`, { cause });
  }
}

/** Reuse the individual delete routes so active tasks receive the same cancellation and access checks. */
export async function deleteChats(
  chats: SidebarConversation[],
  onDeleted: (ids: string[]) => void,
  onProgress: (count: number) => void = () => {},
) {
  const deleted: string[] = [];
  try {
    for (const chat of chats) {
      const endpoint = chat.businessId
        ? `/api/businesses/${encodeURIComponent(chat.businessId)}/conversations/${encodeURIComponent(chat.id)}`
        : `/api/conversations/${encodeURIComponent(chat.id)}`;
      const response = await authFetch(endpoint, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      deleted.push(chat.id);
      onProgress(deleted.length);
    }
    return deleted.length;
  } catch (error) {
    throw new ChatDeletionError(deleted.length, chats.length, error);
  } finally {
    if (deleted.length) onDeleted(deleted);
  }
}

export async function listTransferChats(): Promise<SidebarConversation[]> {
  const rows: SidebarConversation[] = [];
  for (let offset = 0; ; ) {
    const page = await fetchSidebarPage(offset, 50);
    rows.push(...page.items);
    if (!page.more) return [...new Map(rows.map(row => [row.id, row])).values()];
    if (!page.items.length) throw new Error("Could not load all chats");
    offset += page.items.length;
  }
}

export function parseChatImport(value: unknown): TransferChat[] {
  const document = value as { format?: unknown; version?: unknown; conversations?: unknown } | null;
  if (document?.format !== "npati-chats" || document.version !== 1 || !Array.isArray(document.conversations)) {
    throw new Error("Unsupported chat file. Choose an NPATI JSON export (version 1).");
  }
  return document.conversations.map((row: unknown) => {
    const chat = row as TransferChat | null;
    if (!chat || typeof chat.title !== "string" || !chat.title.trim() || chat.title.length > 1000 || !Array.isArray(chat.messages)) {
      throw new Error("Invalid chat in import file");
    }
    if (chat.messages.length > 100000) throw new Error("Too many messages in chat");
    return { title: chat.title, messages: chat.messages.map(message => {
      if (!message || !["user", "assistant", "system"].includes(message.role) || typeof message.content !== "string") {
        throw new Error("Invalid message in import file");
      }
      return { role: message.role, content: message.content };
    }) };
  });
}

export async function exportChats(chats: SidebarConversation[]) {
  const conversations = [];
  for (const chat of chats) {
    const endpoint = chat.businessId
      ? `/api/businesses/${encodeURIComponent(chat.businessId)}/conversations/${encodeURIComponent(chat.id)}`
      : `/api/conversations/${encodeURIComponent(chat.id)}`;
    const response = await authFetch(endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not export chat: ${chat.title}`);
    const data = await response.json();
    conversations.push({ ...chat, createdAt: data.conversation.createdAt, messages: data.messages });
  }
  const blob = new Blob([JSON.stringify({ format: "npati-chats", version: 1, exportedAt: new Date().toISOString(), conversations }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `npati-chats-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importChats(chats: TransferChat[], onImported: () => void): Promise<number> {
  let imported = 0;
  try {
    for (const chat of chats) {
      const response = await authFetch("/api/conversations/import", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chat),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      imported++;
    }
    return imported;
  } catch (error) {
    throw new Error(`Imported ${imported} of ${chats.length} chats. Import stopped. ${error instanceof Error ? error.message : ""}`);
  } finally {
    if (imported) onImported();
  }
}
