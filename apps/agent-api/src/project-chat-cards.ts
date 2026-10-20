import type { ProjectCardData } from "@npati/shared";
import type { AuthContext, ConversationMessage, WorkspaceStore } from "@npati/workspace";

const settingKey = (conversationId: string) => `chat-project-cards:${conversationId}`;

type StoredCards = Record<string, ProjectCardData>;

/** The authenticated conversation, rather than another tab's global selection, owns its project. */
export async function getLatestChatProjectCard(store: WorkspaceStore, context: AuthContext, conversationId: string, businessId?: string): Promise<ProjectCardData | null> {
  const { messages } = await store.getNeutralConversation(context, conversationId).catch(error => {
    if (!businessId) throw error;
    return store.getConversation(context, businessId, conversationId);
  });
  const decorated = await getChatMessagesWithProjectCards(store, context, conversationId, messages);
  return [...decorated].reverse().find(message => message.projectCard)?.projectCard ?? null;
}

function readCards(value: unknown): StoredCards {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as StoredCards;
}

export async function saveChatProjectCard(
  store: WorkspaceStore,
  context: AuthContext,
  conversationId: string,
  messageId: string,
  card: ProjectCardData,
): Promise<void> {
  const key = settingKey(conversationId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await store.getUserSetting(context, key);
    const cards = { ...readCards(existing?.value), [messageId]: card };
    if (await store.setUserSetting(context, key, cards, existing?.revision ?? 0)) return;
  }
  throw new Error("Could not save the website card with the chat message");
}

export async function getChatMessagesWithProjectCards(
  store: WorkspaceStore,
  context: AuthContext,
  conversationId: string,
  messages: ConversationMessage[],
): Promise<Array<ConversationMessage & { projectCard?: ProjectCardData }>> {
  const cards = readCards((await store.getUserSetting(context, settingKey(conversationId)))?.value);
  return Promise.all(messages.map(async message => {
    const card = cards[message.id];
    return card ? { ...message, projectCard: card, content: await publicCodeChatReply(store, context, card, message.content) } : message;
  }));
}

/** Technical pause receipts belong in Activity; chat shows the actual question. */
export async function publicCodeChatReply(store: WorkspaceStore, context: AuthContext, card: ProjectCardData, content: string, language = "uk"): Promise<string> {
  if (card.kind !== "code_project" || !/^Waiting for (?:the user to answer question|an approval decision on tool call) /u.test(content)) return content;
  if (card.companyId && card.runId) {
    const run = await store.getCodeRunState(card.companyId, card.runId);
    const waiting = run?.details?.waitingForUser as { questionId?: string } | undefined;
    if (run?.workspaceId === context.workspaceId && run.projectId === (card.projectId ?? card.id) && waiting?.questionId) {
      const question = await store.getCodeUserQuestion(card.companyId, waiting.questionId);
      if (question?.projectId === run.projectId && question.sessionId === run.sessionId) return question.prompt;
    }
  }
  return language === "uk" ? "Потрібне уточнення для продовження роботи." : "A clarification is needed to continue.";
}
