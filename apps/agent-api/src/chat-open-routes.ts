import type { FastifyInstance } from "fastify";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { DevelopmentProcess } from "@npati/shared";
import { getChatMessagesWithProjectCards, readSavedChatCompanyId } from "./project-chat-cards";
import { errorReply } from "./workspace-routes";

const MESSAGE_PAGE = 10;

/**
 * The company a conversation last worked in, so opening it selects that company. V6 step 14: a chat held in a company's
 * context showed "No company" in the selector while its messages still went to that company.
 */
async function savedConversationCompany(store: WorkspaceStore, context: AuthContext, conversationId: string) {
  // Only the stored context is read: the conversation itself was already read as a page, so it is owned.
  const companyId = await readSavedChatCompanyId(store, context, conversationId).catch(() => null);
  return companyId ? store.getCompany(context, companyId).then((item) => ({ id: item.id, name: item.name })).catch(() => null) : null;
}
const CHAT_PAGE = 20;
const ACTIVE_STATUSES = new Set(["queued", "preparing", "running", "stopping"]);

/** A conversation needs its own development processes and any still running; finished history of others is not sent. */
export const chatProcess = (process: DevelopmentProcess, conversationId?: string) => ACTIVE_STATUSES.has(process.status)
  || Boolean(conversationId) && (process.conversationId === conversationId || process.parentConversationId === conversationId);

const pageSize = (value: unknown, fallback: number) => Math.min(Math.max(Number.parseInt(String(value ?? fallback), 10) || fallback, 1), 50);

/** Neutral and Business conversations of the user, newest first, as one sidebar page. */
async function sidebarPage(store: WorkspaceStore, context: AuthContext, offset: number, limit: number) {
  if (store.listChatSidebarPage) return store.listChatSidebarPage(context, offset, limit);
  const [neutral, businesses] = await Promise.all([store.listNeutralConversations(context), store.listUserBusinesses(context)]);
  const business = (await Promise.all(businesses.map(async (item) => (await store.listConversations(context, item.id))
    .map((conversation) => ({ ...conversation, businessId: item.id, businessName: item.name }))))).flat();
  const all = [...neutral.map((conversation) => ({ ...conversation, businessId: null, businessName: "" })), ...business]
    // PostgreSQL rows carry Date values, the in-memory store ISO strings: compare instants, not strings.
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  return { items: all.slice(offset, offset + limit), more: all.length > offset + limit };
}

/**
 * The last messages of a conversation before a cursor (exclusive), with their project cards. The cursor is a message
 * id; a numeric position from older clients is still accepted. An unknown cursor is rejected instead of guessed.
 */
async function messagePage(store: WorkspaceStore, context: AuthContext, conversationId: string, before: string | undefined, limit: number) {
  if (store.getNeutralConversationPage) {
    const page = await store.getNeutralConversationPage(context, conversationId, before, limit);
    const messages = await getChatMessagesWithProjectCards(store, context, conversationId, page.messages);
    return { conversation: { conversation: page.conversation, messages: [] }, messages, start: page.earlier, cursor: page.cursor, hasMore: page.hasMore };
  }
  const conversation = await store.getNeutralConversation(context, conversationId);
  let end = conversation.messages.length;
  if (before !== undefined && before !== "") {
    const position = conversation.messages.findIndex((message) => message.id === before);
    if (position >= 0) end = position;
    else if (/^\d+$/.test(before)) end = Number(before);
    else throw new Error("Message cursor is invalid");
  }
  const stop = Math.min(end, conversation.messages.length);
  const start = Math.max(0, stop - limit);
  const messages = await getChatMessagesWithProjectCards(store, context, conversationId, conversation.messages.slice(start, stop));
  return { conversation, messages, start, cursor: messages[0]?.id ?? null, hasMore: start > 0 };
}

/**
 * Opening a chat needs one request: its latest messages, the selected Company, the first sidebar page and the
 * development processes of this conversation (or still running). Earlier messages and chats load on scroll.
 */
export function registerChatOpenRoutes(app: FastifyInstance, deps: { auth: AuthProvider; store: WorkspaceStore; listProcesses(context: AuthContext, conversationId?: string): Promise<DevelopmentProcess[]> }) {
  app.get<{ Querystring: { conversationId?: string; companyId?: string; messages?: string; chats?: string; deferProcesses?: string } }>("/chat/open", async (request, reply) => {
    try {
      reply.header("cache-control", "private, no-store");
      const context = await deps.auth.authenticate(request);
      const { conversationId, companyId } = request.query;
      const deferProcesses = request.query.deferProcesses === "1";
      const [overview, opened, company, chats, processes] = await Promise.all([
        context.permissions.includes("workspace:read") ? deps.store.overview(context) : null,
        // A Business conversation (or one the user cannot read) is simply not a neutral chat: the rest still loads.
        conversationId ? messagePage(deps.store, context, conversationId, undefined, pageSize(request.query.messages, MESSAGE_PAGE)).catch(() => undefined) : undefined,
        companyId ? deps.store.getCompany(context, companyId).then((item) => ({ id: item.id, name: item.name })).catch(() => null) : null,
        sidebarPage(deps.store, context, 0, pageSize(request.query.chats, CHAT_PAGE)),
        deferProcesses ? [] as DevelopmentProcess[] : deps.listProcesses(context, conversationId),
      ]);
      const { messages: _all, ...conversation } = opened?.conversation ?? { messages: [] };
      const conversationCompany = opened && conversationId ? await savedConversationCompany(deps.store, context, conversationId) : null;
      return {
        overview,
        conversation: opened ? { ...conversation, messages: opened.messages, earlier: opened.start, cursor: opened.cursor, hasMore: opened.hasMore, company: conversationCompany } : null,
        company,
        chats,
        processes: processes.filter((process) => chatProcess(process, conversationId)),
        ...(deferProcesses ? { processesDeferred: true } : {}),
      };
    } catch (error) { return errorReply(reply, error); }
  });

  app.get<{ Params: { conversationId: string }; Querystring: { before?: string; limit?: string } }>("/conversations/:conversationId/messages", async (request, reply) => {
    try {
      reply.header("cache-control", "private, no-store");
      const context = await deps.auth.authenticate(request);
      const page = await messagePage(deps.store, context, request.params.conversationId, request.query.before, pageSize(request.query.limit, MESSAGE_PAGE));
      // The first page also names the conversation's company, so switching chats selects it.
      const company = request.query.before ? undefined : await savedConversationCompany(deps.store, context, request.params.conversationId);
      return { messages: page.messages, earlier: page.start, cursor: page.cursor, hasMore: page.hasMore, ...(company !== undefined ? { company } : {}) };
    } catch (error) { return errorReply(reply, error); }
  });

  app.get<{ Querystring: { offset?: string; limit?: string } }>("/chat/sidebar", async (request, reply) => {
    try {
      reply.header("cache-control", "private, no-store");
      const offset = Math.max(Number.parseInt(String(request.query.offset ?? "0"), 10) || 0, 0);
      return await sidebarPage(deps.store, await deps.auth.authenticate(request), offset, pageSize(request.query.limit, CHAT_PAGE));
    } catch (error) { return errorReply(reply, error); }
  });
}
