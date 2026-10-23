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

/** The run's stop notices in the conversation language; the technical detail in parentheses is kept as is. */
const RUN_STOP_COPY: Record<string, Array<[RegExp, (...groups: string[]) => string]>> = {
  uk: [
    [/^Stopped after (\d+) minutes: the time limit was reached\.$/u, (n) => `Зупинено через ${n} хв: досягнуто ліміту часу.`],
    [/^Stopped after (\d+) turns: the step limit was reached\.$/u, (n) => `Зупинено після ${n} кроків: досягнуто ліміту кроків.`],
    [/^Stopped: the same error \((.+)\) kept repeating\.$/u, (e) => `Зупинено: та сама помилка (${e}) повторювалася.`],
    [/^Stopped: the self-review could not be completed \((.+)\), so the change was not reviewed\.$/u, (e) => `Зупинено: самоперевірку не вдалося завершити (${e}), тому зміну не перевірено.`],
    [/^Stopped: repeating cycle of tool calls \[(.+)\] was detected without progress\.$/u, (e) => `Зупинено: виявлено цикл викликів інструментів [${e}] без прогресу.`],
    [/^Stopped: the same tool call \((.+)\) was repeated without progress\.$/u, (e) => `Зупинено: той самий виклик інструмента (${e}) повторювався без прогресу.`],
    [/^Stopped: ten model turns without source progress\..*$/u, () => "Зупинено: десять кроків моделі без змін у коді. Завершення реалізації не стверджується."],
  ],
  pt: [
    [/^Stopped after (\d+) minutes: the time limit was reached\.$/u, (n) => `Interrompido após ${n} min: o limite de tempo foi atingido.`],
    [/^Stopped: the same error \((.+)\) kept repeating\.$/u, (e) => `Interrompido: o mesmo erro (${e}) continuou a repetir-se.`],
    [/^Stopped: the self-review could not be completed \((.+)\), so the change was not reviewed\.$/u, (e) => `Interrompido: a autorrevisão não foi concluída (${e}), por isso a alteração não foi revista.`],
  ],
  es: [
    [/^Stopped after (\d+) minutes: the time limit was reached\.$/u, (n) => `Detenido tras ${n} min: se alcanzó el límite de tiempo.`],
    [/^Stopped: the same error \((.+)\) kept repeating\.$/u, (e) => `Detenido: el mismo error (${e}) se repitió.`],
    [/^Stopped: the self-review could not be completed \((.+)\), so the change was not reviewed\.$/u, (e) => `Detenido: la autorrevisión no se completó (${e}), así que el cambio no se revisó.`],
  ],
  de: [
    [/^Stopped after (\d+) minutes: the time limit was reached\.$/u, (n) => `Nach ${n} Min. gestoppt: Das Zeitlimit wurde erreicht.`],
    [/^Stopped: the same error \((.+)\) kept repeating\.$/u, (e) => `Gestoppt: Derselbe Fehler (${e}) trat wiederholt auf.`],
    [/^Stopped: the self-review could not be completed \((.+)\), so the change was not reviewed\.$/u, (e) => `Gestoppt: Die Selbstprüfung konnte nicht abgeschlossen werden (${e}), die Änderung wurde nicht geprüft.`],
  ],
};

export function localizeRunStopNotice(content: string, language: string): string {
  for (const [pattern, render] of RUN_STOP_COPY[language] ?? []) {
    const match = content.trim().match(pattern);
    if (match) return render(...match.slice(1));
  }
  return content;
}

/** Technical pause receipts belong in Activity; chat shows the actual question. */
export async function publicCodeChatReply(store: WorkspaceStore, context: AuthContext, card: ProjectCardData, content: string, language = "uk"): Promise<string> {
  if (/^Stopped\b/u.test(content)) return localizeRunStopNotice(content, language);
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
