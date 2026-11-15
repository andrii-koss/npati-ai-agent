import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { ChatDevelopmentService } from "./chat-development-service";
import type { ChatProjectIntentResolver } from "./chat-project-intent";
import type { DevelopmentProcess } from "@npati/shared";
import { getChatMessagesWithProjectCards } from "./project-chat-cards";

/** A creation that reaches the server was not started by the client, so it always runs as a development process: its
 * steps, files and Preview card stay in the chat (V6 step 14: an API-sent creation went straight to the Coding Agent). */
export function isChatProjectCreationBatch(intent: Awaited<ReturnType<ChatProjectIntentResolver>> | undefined): boolean {
  return intent?.source === "semantic" && intent.targets.length > 0
    && (intent.targets.length > 1 || intent.requiresDevelopmentProgress === true)
    && !intent.decision.needsClarification && !intent.decision.unsupportedIntentMessage;
}

/** Adapt the existing multi-project service to one streamed chat turn, retaining its admission and policy checks. */
export async function runChatProjectCreation(input: {
  service: Pick<ChatDevelopmentService, "start" | "list" | "stop"> & Partial<Pick<ChatDevelopmentService, "listForChat" | "waitForCompletion">>;
  ctx: AuthContext; companyId: string; message: string; conversationId?: string; requestId: string;
  signal: AbortSignal; progress(processes: unknown[]): Promise<void>;
}) {
  const { service, ctx, signal } = input;
  signal.throwIfAborted();
  const started = await service.start(ctx, input);
  const ids = new Set(started.processes.map(process => process.id));
  const stop = async () => { await Promise.all(started.processes.map(process => service.stop(ctx, process.id))); };
  const abort = () => { void stop().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const snapshot = service.listForChat ? await service.listForChat(ctx, started.conversationId) : await service.list(ctx);
      let processes = snapshot.filter(process => ids.has(process.id));
      await input.progress(processes);
      if (processes.length !== ids.size) throw new Error("Development process disappeared before completion");
      if (processes.every(process => !["running", "preparing", "queued", "stopping"].includes(process.status))) {
        if (service.waitForCompletion) {
          await service.waitForCompletion(ctx, [...ids]);
          signal.throwIfAborted();
          processes = (service.listForChat ? await service.listForChat(ctx, started.conversationId) : await service.list(ctx))
            .filter(process => ids.has(process.id));
          if (processes.length !== ids.size) throw new Error("Development process disappeared before completion");
          await input.progress(processes);
        }
        return { ...started, processes, status: processes.every(process => process.status === "completed") ? "completed" : "failed" };
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { signal.removeEventListener("abort", abort); }
}

/** A single created site returns its saved agent reply, just like an ordinary Code chat. */
export async function chatProjectCreationReply(
  store: WorkspaceStore,
  ctx: AuthContext, run: Awaited<ReturnType<typeof runChatProjectCreation>>, companyId: string,
) {
  const process = run.processes[0] as (DevelopmentProcess & {
    businessId?: string; resultMessageId?: string; cardMessageId?: string;
  }) | undefined;
  if (!process || run.processes.length !== 1) return {
    routed: "chat_development", run, conversationId: run.conversationId,
    message: run.processes.map(p => `${p.name}: ${p.status} [${p.projectId ?? "pending"}]`).join("\n"),
    activeContext: { contextType: "company", companyId, projectId: null, businessId: null },
  };
  const conversation = await store.getNeutralConversation(ctx, run.conversationId!).catch(error => {
    if (!process.businessId) throw error;
    return store.getConversation(ctx, process.businessId, run.conversationId!);
  });
  const messages = await getChatMessagesWithProjectCards(store, ctx, run.conversationId!, conversation.messages);
  const assistantMessage = messages.find(message => message.id === process.resultMessageId && message.role === "assistant");
  const userMessage = messages.find(message => message.id === process.cardMessageId && message.role === "user");
  return {
    routed: "chat_development", run, conversationId: run.conversationId,
    message: assistantMessage?.content ?? "",
    ...(assistantMessage ? { assistantMessage } : {}), ...(userMessage ? { userMessage } : {}),
    ...(userMessage?.projectCard ? { projectCard: userMessage.projectCard } : {}),
    activeContext: { contextType: process.projectId ? "project" : "company", companyId, projectId: process.projectId ?? null, businessId: null },
  };
}
