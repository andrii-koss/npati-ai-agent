import { readActiveCompanyId } from "./active-company";
import { getStoredAuthToken } from "./AuthContext";
import type { WorkspaceOverview } from "./business-workspace-shared";
import type { DevelopmentProcess } from "@npati/shared";

export type ChatOpenMessage = { id: string; role: "user" | "assistant"; content: string; createdAt?: string; [key: string]: unknown };
export type ChatOpenChat = { id: string; title: string; updatedAt: string; businessId: string | null; businessName: string };
export type ChatProjectThumbnails = Record<string, string | null>;
interface ChatOpenProcesses {
  processes: DevelopmentProcess[];
  processesDeferred?: boolean;
  projectThumbnails?: ChatProjectThumbnails;
}
export interface ChatOpenData extends ChatOpenProcesses {
  overview: WorkspaceOverview | null;
  conversation: { id: string; title: string; messages: ChatOpenMessage[]; earlier: number; cursor?: string | null; hasMore?: boolean; company?: { id: string; name: string } | null } | null;
  company: { id: string; name: string } | null;
  chats: { items: ChatOpenChat[]; more: boolean };
  pendingProcesses?: Promise<ChatOpenProcesses>;
}

const SHARE_MS = 5_000;
let shared: { key: string; token: string | null; companyId: string; pending: boolean; at: number; promise: Promise<ChatOpenData> } | null = null;
// After the first open, navigation only needs the new conversation and its timeline.
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

/** A conversation's opening snapshot. Consumers share both records of the response. */
export function chatOpenData(conversationId: string | null = currentChatConversationId()): Promise<ChatOpenData> | null {
  return sharedChatOpen(conversationId) ?? (conversationId || !chatPageAlreadyOpened() ? chatOpen(conversationId) : null);
}

/** The conversation of the current chat page, from /c/:conversationId. */
export function currentChatConversationId(pathname = window.location.pathname): string | null {
  return /^\/c\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

export function isChatPage(pathname = window.location.pathname): boolean {
  return pathname === "/chat" || pathname.startsWith("/c/");
}

async function readChatOpen(response: Response): Promise<ChatOpenData> {
  if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function record<T>(): Promise<T> {
    let boundary = buffer.indexOf("\n");
    while (boundary < 0) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Incomplete chat response");
      buffer += decoder.decode(chunk.value, { stream: true });
      boundary = buffer.indexOf("\n");
    }
    const value = JSON.parse(buffer.slice(0, boundary)) as T;
    buffer = buffer.slice(boundary + 1);
    return value;
  }
  const close = () => reader.cancel().catch(() => {}).finally(() => reader.releaseLock());
  try {
    const { processesPending, ...data } = await record<ChatOpenData & { processesPending?: boolean }>();
    if (processesPending) {
      data.pendingProcesses = record<ChatOpenProcesses>()
        .catch(() => ({ processes: [], processesDeferred: true }))
        .finally(close);
    } else void close();
    return data;
  } catch (error) {
    void close();
    throw error;
  }
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
  if (conversationId) {
    query.set("conversationId", conversationId);
    query.set("stream", "1");
    if (chatPageAlreadyOpened()) query.set("scope", "conversation");
  } else query.set("deferProcesses", "1");
  if (companyId) query.set("companyId", companyId);
  // Fetched directly: the workspace provider itself reads this request, so it cannot depend on that module's helper.
  const promise = fetch(`/api/chat/open${query.size ? `?${query}` : ""}`, { cache: "no-store", headers: token ? { authorization: `Bearer ${token}` } : {} })
    .then((response) => {
      if (response.status === 401) window.dispatchEvent(new Event("npati:unauthorized"));
      if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}`);
      return readChatOpen(response);
    });
  shared = { key, token, companyId, pending: true, at: Date.now(), promise };
  promise.then(async data => {
    if (getStoredAuthToken() === token) { pageOpened = true; pageOpenedFor = token; }
    if (data.pendingProcesses) await data.pendingProcesses;
    if (shared?.promise === promise) { shared.pending = false; shared.at = Date.now(); }
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
