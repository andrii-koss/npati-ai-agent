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
  return messages.map((message) => cards[message.id]
    ? { ...message, projectCard: cards[message.id] }
    : message);
}
