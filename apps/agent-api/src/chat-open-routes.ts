import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { DevelopmentProcess, ProjectCardData } from "@npati/shared";
import { getChatMessagesWithProjectCards, readSavedChatCompanyId } from "./project-chat-cards";
import { errorReply } from "./workspace-routes";

const MESSAGE_PAGE = 10;
type ThumbnailProject = { companyId: string; projectId: string };
export type ReadChatThumbnail = (context: AuthContext, companyId: string, projectId: string) => Promise<{ dataUrl: string } | null>;
const thumbnailKey = ({ companyId, projectId }: ThumbnailProject) => JSON.stringify([companyId, projectId]);

function messageProjects(messages: { projectCard?: ProjectCardData }[]): ThumbnailProject[] {
  return messages.flatMap(({ projectCard }) => projectCard?.companyId ? [{ companyId: projectCard.companyId, projectId: projectCard.projectId ?? projectCard.id }] : []);
}

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
export function registerChatOpenRoutes(app: FastifyInstance, deps: { auth: AuthProvider; store: WorkspaceStore; listProcesses(context: AuthContext, conversationId?: string): Promise<DevelopmentProcess[]>; readThumbnail?: ReadChatThumbnail }) {
  async function readThumbnails(context: AuthContext, projects: ThumbnailProject[]): Promise<Record<string, string | null>> {
    const read = deps.readThumbnail;
    if (!read || !context.permissions.includes("workspace:read")) return {};
    const unique = new Map(projects.map(project => [thumbnailKey(project), project]));
    return Object.fromEntries(await Promise.all([...unique].map(async ([key, project]) => {
      const thumbnail = await read(context, project.companyId, project.projectId).catch(() => null);
      return [key, thumbnail?.dataUrl ?? null] as const;
    })));
  }

  app.get<{ Querystring: { conversationId?: string; companyId?: string; messages?: string; chats?: string; deferProcesses?: string; stream?: string; scope?: string } }>("/chat/open", async (request, reply) => {
    try {
      reply.header("cache-control", "private, no-store");
      const context = await deps.auth.authenticate(request);
      const { conversationId, companyId } = request.query;
      const deferProcesses = request.query.deferProcesses === "1";
      const conversationOnly = request.query.scope === "conversation";
      const readProcesses = async () => ({ processes: (await deps.listProcesses(context, conversationId)).filter(process => chatProcess(process, conversationId)) });
      const deferred = { processes: [] as DevelopmentProcess[], processesDeferred: true as const };
      const processes = deferProcesses ? Promise.resolve(deferred) : readProcesses().catch(error => {
        request.log.warn({ err: error, conversationId }, "Could not load chat development history");
        return deferred;
      });
      let readyProcesses: Awaited<typeof processes> | undefined;
      void processes.then(result => { readyProcesses = result; });
      async function loadConversation() {
        if (!conversationId) return undefined;
        // A Business conversation (or one the user cannot read) is simply not a neutral chat: the rest still loads.
        const page = await messagePage(deps.store, context, conversationId, undefined, pageSize(request.query.messages, MESSAGE_PAGE)).catch(() => undefined);
        if (!page) return undefined;
        const [company, thumbnails] = await Promise.all([
          savedConversationCompany(deps.store, context, conversationId),
          readThumbnails(context, messageProjects(page.messages)),
        ]);
        return { ...page, company, thumbnails };
      }
      const [overview, opened, company, chats] = await Promise.all([
        !conversationOnly && context.permissions.includes("workspace:read") ? deps.store.overview(context) : null,
        loadConversation(),
        companyId ? deps.store.getCompany(context, companyId).then((item) => ({ id: item.id, name: item.name })).catch(() => null) : null,
        conversationOnly ? { items: [], more: false } : sidebarPage(deps.store, context, 0, pageSize(request.query.chats, CHAT_PAGE)),
      ]);
      const { messages: _all, ...conversation } = opened?.conversation ?? { messages: [] };
      const projectThumbnails = opened?.thumbnails ?? {};
      const openedChat = {
        overview,
        conversation: opened ? { ...conversation, messages: opened.messages, earlier: opened.start, cursor: opened.cursor, hasMore: opened.hasMore, company: opened.company } : null,
        company,
        chats,
        projectThumbnails,
      };
      const remainingProjects = (items: DevelopmentProcess[]) => !opened || !deps.readThumbnail ? [] : items.flatMap(process => {
        if (process.conversationId !== conversationId || !process.projectId || process.projectDeleted) return [];
        const project = { companyId: process.companyId, projectId: process.projectId };
        return Object.hasOwn(projectThumbnails, thumbnailKey(project)) ? [] : [project];
      });
      async function withRemainingThumbnails(snapshot: Awaited<typeof processes>) {
        return { ...snapshot, projectThumbnails: await readThumbnails(context, remainingProjects(snapshot.processes)) };
      }
      if (request.query.stream !== "1") {
        const snapshot = await withRemainingThumbnails(await processes);
        return { ...openedChat, ...snapshot, projectThumbnails: { ...projectThumbnails, ...snapshot.projectThumbnails } };
      }
      // Send the conversation as soon as it is ready. If replay hydration is still running, send its result on
      // this same response. Small histories often fit in the first record, with no separate paint for the steps.
      const initialProcesses = readyProcesses && !remainingProjects(readyProcesses.processes).length ? readyProcesses : undefined;
      async function* records() {
        yield JSON.stringify({ ...openedChat, ...(initialProcesses ?? { processes: [], processesPending: true }) }) + "\n";
        if (!initialProcesses) yield JSON.stringify(await withRemainingThumbnails(await processes)) + "\n";
      }
      return reply.type("application/x-ndjson").header("X-Accel-Buffering", "no").send(Readable.from(records()));
    } catch (error) { return errorReply(reply, error); }
  });

  app.get<{ Params: { conversationId: string }; Querystring: { before?: string; limit?: string } }>("/conversations/:conversationId/messages", async (request, reply) => {
    try {
      reply.header("cache-control", "private, no-store");
      const context = await deps.auth.authenticate(request);
      const page = await messagePage(deps.store, context, request.params.conversationId, request.query.before, pageSize(request.query.limit, MESSAGE_PAGE));
      // The first page also names the conversation's company, so switching chats selects it.
      const [company, projectThumbnails] = await Promise.all([
        request.query.before ? undefined : savedConversationCompany(deps.store, context, request.params.conversationId),
        readThumbnails(context, messageProjects(page.messages)),
      ]);
      return { messages: page.messages, earlier: page.start, cursor: page.cursor, hasMore: page.hasMore, projectThumbnails, ...(company !== undefined ? { company } : {}) };
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
