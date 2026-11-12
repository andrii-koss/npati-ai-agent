import { readActiveCompanyId } from "./active-company";
import { getStoredAuthToken } from "./AuthContext";
import type { WorkspaceOverview } from "./business-workspace-shared";
import type { DevelopmentProcess } from "@npati/shared";

export type ChatOpenMessage = { id: string; role: "user" | "assistant"; content: string; createdAt?: string; [key: string]: unknown };
export type ChatOpenChat = { id: string; title: string; updatedAt: string; businessId: string | null; businessName: string };
export interface ChatOpenData {
  overview: WorkspaceOverview | null;
  conversation: { id: string; title: string; messages: ChatOpenMessage[]; earlier: number; cursor?: string | null; hasMore?: boolean } | null;
  company: { id: string; name: string } | null;
  chats: { items: ChatOpenChat[]; more: boolean };
  processes: DevelopmentProcess[];
  processesDeferred?: boolean;
}

const SHARE_MS = 5_000;
let shared: { key: string; token: string | null; companyId: string; pending: boolean; at: number; promise: Promise<ChatOpenData> } | null = null;
// After the page's first open request, switching chats reads only that chat; the page already has the rest.
let pageOpened = false;
let pageOpenedFor: string | null | undefined;
const reusable = () => Boolean(shared && shared.token === getStoredAuthToken() && (shared.pending || Date.now() - shared.at < SHARE_MS));

export function chatPageAlreadyOpened(): boolean {
  return pageOpened && pageOpenedFor === getStoredAuthToken();
}

/** The page's recent open request when it was made for this conversation: its data is reused, not fetched again. */
export function sharedChatOpen(conversationId: string | null = currentChatConversationId()): Promise<ChatOpenData> | null {
  return shared && reusable() && shared.companyId === readActiveCompanyId() && shared.key.startsWith(`${conversationId ?? ""}|`) ? shared.promise : null;
}

/** The open request's data for this conversation: shared when recent, fetched on the page's first open, else none. */
export function chatOpenData(conversationId: string | null = currentChatConversationId()): Promise<ChatOpenData> | null {
  return sharedChatOpen(conversationId) ?? (chatPageAlreadyOpened() ? null : chatOpen(conversationId));
}

/** The conversation of the current chat page, from /c/:conversationId. */
export function currentChatConversationId(pathname = window.location.pathname): string | null {
  return /^\/c\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

export function isChatPage(pathname = window.location.pathname): boolean {
  return pathname === "/chat" || pathname.startsWith("/c/");
}

/**
 * Opening a chat makes one data request: the workspace overview, the latest messages, the selected Company, the
 * first sidebar page and this chat's development processes. Every part of the page shares the same request.
 */
export function chatOpen(conversationId = currentChatConversationId()): Promise<ChatOpenData> {
  const companyId = readActiveCompanyId();
  const token = getStoredAuthToken();
  const key = `${conversationId ?? ""}|${companyId}`;
  if (shared && shared.key === key && reusable()) return shared.promise;
  const query = new URLSearchParams();
  query.set("deferProcesses", "1");
  if (conversationId) query.set("conversationId", conversationId);
  if (companyId) query.set("companyId", companyId);
  // Fetched directly: the workspace provider itself reads this request, so it cannot depend on that module's helper.
  const promise = fetch(`/api/chat/open${query.size ? `?${query}` : ""}`, { cache: "no-store", headers: token ? { authorization: `Bearer ${token}` } : {} })
    .then((response) => {
      if (response.status === 401) window.dispatchEvent(new Event("npati:unauthorized"));
      if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}`);
      return response.json() as Promise<ChatOpenData>;
    });
  shared = { key, token, companyId, pending: true, at: Date.now(), promise };
  promise.then(() => {
    if (shared?.promise === promise) { shared.pending = false; shared.at = Date.now(); }
    if (getStoredAuthToken() === token) { pageOpened = true; pageOpenedFor = token; }
  }, () => {});
  promise.catch(() => { if (shared?.promise === promise) shared = null; });
  return promise;
}

/** A shared open request still in flight or just answered, if this page made one. */
export function recentChatOpen(): Promise<ChatOpenData> | null {
  return shared && reusable() ? shared.promise : null;
}

export function forgetChatOpen(): void {
  shared = null;
}
