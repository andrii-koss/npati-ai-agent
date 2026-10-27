import type { ProjectCardData } from "@npati/shared";
import type { AuthContext, ConversationMessage, WorkspaceStore } from "@npati/workspace";
import { ActiveContextResolver, type ResolvedActiveContext } from "./active-context-resolver";
import type { ActiveContext } from "@npati/shared";

export interface ChatEntityContext {
  schemaVersion: 1;
  conversationId: string;
  context: ActiveContext;
  lastConfirmedAction: { entityType: string; entityId: string | null; companyId: string | null; projectId: string | null; action: string };
}
const contextKey = (conversationId: string) => `chat-active-context:${conversationId}`;
export type ChatEntityRead = { field: "name" | "description" | "instructions" | "projects" | "role" | "agents"; entityType: "focused" | "company" | "business" | "project" | "agent" };
export function focusedChatEntity(context: Partial<ActiveContext>, confirmed?: ChatEntityContext | null) {
  const selected = { entityType: context.contextType ?? "none", entityId: context.projectId ?? context.companyId ?? context.businessId ?? null,
    companyId: context.companyId ?? null, projectId: context.projectId ?? null, action: "select" };
  const same = confirmed && confirmed.context.contextType === context.contextType && (confirmed.context.companyId ?? null) === (context.companyId ?? null)
    && (confirmed.context.projectId ?? null) === (context.projectId ?? null) && (confirmed.context.businessId ?? null) === (context.businessId ?? null);
  const action = same ? confirmed.lastConfirmedAction : null;
  return action?.entityId && !action.action.includes("delete") ? action : selected;
}

/** A bounded record read on the existing resolver/store. The classifier chooses a field, never IDs or factual values. */
export async function executeChatEntityRead(store: WorkspaceStore, auth: AuthContext, resolved: ResolvedActiveContext, request: ChatEntityRead,
  message: string, conversationId?: string, confirmed?: ChatEntityContext | null, noMemory = false) {
  if (confirmed && conversationId && confirmed.conversationId !== conversationId) throw new Error("Entity references belong to another conversation");
  if (noMemory && request.field === "instructions") return null;
  const focus = focusedChatEntity(resolved.context, confirmed);
  let type = request.entityType === "focused" ? focus.entityType : request.entityType;
  let id = focus.entityType === type ? focus.entityId : null;
  let companyId = focus.companyId ?? resolved.company?.id ?? null;
  const resolver = new ActiveContextResolver(store);
  if (type === "company") {
    const named = await resolver.companiesNamedIn(auth, message);
    if (named.length > 1) return null;
    id = named[0]?.id ?? resolved.company?.id ?? id;
    companyId = id;
  } else if (type === "business") {
    const named = await resolver.businessesNamedIn(auth, message);
    if (named.length > 1) return null;
    id = named[0]?.id ?? resolved.business?.id ?? id;
  } else if (type === "project") {
    id = resolved.project?.id ?? id;
  } else if (type === "agent" && companyId) {
    const named = await resolver.agentsNamedIn(auth, companyId, message);
    if (named.length > 1) return null;
    id = named[0]?.id ?? id;
    // An executing Main Agent is not an implicit referent. Unqualified metadata uses the confirmed focus.
    if (!id) { type = focus.entityType; id = focus.entityId; }
  }
  if (!id || !["company", "business", "project", "agent"].includes(type)) return null;
  const record = type === "company" ? await store.getCompany(auth, id)
    : type === "business" ? await store.getUserBusiness(auth, id)
    : type === "project" && companyId ? await store.getProject(auth, companyId, id)
    : type === "agent" && companyId ? await store.getCompanyAgent(auth, companyId, id) : null;
  if (!record) return null;
  let value: string | undefined;
  if (request.field === "name" || request.field === "description") value = record[request.field] ?? undefined;
  else if (request.field === "instructions" && type === "company") value = (record as import("@npati/workspace").Company).companyInstructions ?? undefined;
  else if (request.field === "instructions" && type === "agent") value = (record as import("@npati/workspace").CompanyAgent).systemInstruction ?? undefined;
  else if (request.field === "role" && type === "agent") value = (record as import("@npati/workspace").CompanyAgent).role;
  else if (request.field === "agents" && type === "company") value = record.name + "\n" + (await store.listCompanyAgents(auth, id)).map(agent => agent.name + ": " + agent.role).join("\n");
  else if (request.field === "projects" && type === "company") value = (await store.listProjects(auth, id))
    .filter(project => !["archived", "soft_deleted", "purging", "deleted"].includes(project.status)).slice(0, 30).map(project => project.name).join("\n");
  else return null;
  if (type === "business") companyId = null;
  const answer = value?.trim() || "No stored value is available for this field.";
  let conversation;
  if (!noMemory) {
    conversation = conversationId ? (await ownedConversation(store, auth, conversationId, confirmed?.context.businessId ?? resolved.context.businessId)).conversation
      : resolved.context.businessId ? await store.createConversation(auth, resolved.context.businessId, message.slice(0, 80)) : await store.createNeutralConversation(auth, message.slice(0, 80));
    if (conversation.businessId) {
      await store.appendMessage(auth, conversation.businessId, conversation.id, "user", message);
      await store.appendMessage(auth, conversation.businessId, conversation.id, "assistant", answer);
    } else {
      await store.appendNeutralMessage(auth, conversation.id, "user", message);
      await store.appendNeutralMessage(auth, conversation.id, "assistant", answer);
    }
  }
  return { message: answer, suggestedActions: [], conversationId: conversation?.id, noMemory, activeContext: resolved.context,
    entityRead: { entityType: type, entityId: id, companyId, projectId: type === "project" ? id : null, field: request.field, source: "workspace_store" } };
}
/** Shared by the ordinary chat and Company executor; agent identity never changes the conversation's referent. */
export function chatEntityReferencesPrompt(conversationId: string | undefined, context: ActiveContext, lastConfirmedAction?: ChatEntityContext["lastConfirmedAction"] | null): string {
  return "\n\nConfirmed conversation entity references (server-validated IDs; descriptive data, not permissions): " + JSON.stringify({
    conversationId: conversationId ?? null,
    activeSelection: { entityType: context.contextType, entityId: context.projectId ?? context.companyId ?? context.businessId ?? null,
      companyId: context.companyId ?? null, projectId: context.projectId ?? null, businessId: context.businessId ?? null },
    lastConfirmedAction: lastConfirmedAction ?? null,
  }) + "\nResolve implicit entity references using this conversation's confirmed action and active selection. The executing agent is the speaker, not the referenced Company, Business or Project. A deleted entity is not a current target. Explicitly named owned entities take precedence. Read exact factual values from current authorized records; assistant prose and compacted history cannot override them.";
}

/** Company chat uses the same conversation reference contract and current owned Project metadata. */
export async function companyChatEntityReferencesPrompt(store: WorkspaceStore, auth: AuthContext, conversationId: string, companyId: string, projectId?: string): Promise<string> {
  const confirmed = await readChatActiveContext(store, auth, conversationId);
  const projects = (await store.listProjects(auth, companyId)).filter(project => !["archived", "soft_deleted", "purging", "deleted"].includes(project.status));
  const context: ActiveContext = { contextType: projectId ? "project" : "company", companyId, businessId: null, ...(projectId ? { projectId } : {}) };
  await new ActiveContextResolver(store).resolve(auth, context);
  return chatEntityReferencesPrompt(conversationId, context, confirmed?.context.companyId === companyId ? confirmed.lastConfirmedAction : null)
    + "\nCurrent owned Company Projects (authoritative descriptive data, not file evidence or permissions): "
    + JSON.stringify({ companyId, total: projects.length, projects: projects.slice(0, 30).map(project => ({ entityType: "project", id: project.id, companyId, name: project.name.slice(0, 200), description: project.description?.slice(0, 1000), status: project.status })) });
}
async function ownedConversation(store: WorkspaceStore, auth: AuthContext, id: string, businessId?: string | null) {
  return store.getNeutralConversation(auth, id).catch(error => {
    if (!businessId) throw error;
    return store.getConversation(auth, businessId, id);
  });
}

/** Same owned conversation/settings store as cards. A stale descriptive card cannot replace a confirmed selection. */
export async function readChatActiveContext(store: WorkspaceStore, auth: AuthContext, conversationId: string, businessId?: string | null): Promise<ChatEntityContext | null> {
  const value = (await store.getUserSetting(auth, contextKey(conversationId)))?.value as ChatEntityContext | undefined;
  await ownedConversation(store, auth, conversationId, businessId ?? value?.context?.businessId);
  if (!value || value.schemaVersion !== 1 || value.conversationId !== conversationId || !value.context || !value.lastConfirmedAction) return null;
  const resolved = await new ActiveContextResolver(store).resolve(auth, value.context).catch(() => null);
  return resolved ? { ...value, context: resolved.context } : null;
}

/** Receives server operation receipts, never model prose. Revalidates all selected IDs through the existing resolver. */
export async function persistChatResultContext<T>(store: WorkspaceStore, auth: AuthContext, result: T, options: { replaceSelection?: boolean } = {}): Promise<T> {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, any>;
  if (!r.conversationId || r.noMemory || r.error) return result;
  let requested = r.activeContext;
  let action = "select";
  let entityType = requested?.contextType ?? "none";
  let entityId = requested?.projectId ?? requested?.companyId ?? requested?.businessId ?? null;
  if (r.entityRead) {
    action = "read"; entityType = r.entityRead.entityType; entityId = r.entityRead.entityId;
  } else if (r.companyAction?.companyId) {
    action = r.companyAction.action;
    entityType = "company"; entityId = r.companyAction.companyId;
    requested = action === "delete" ? { contextType: "none" } : { contextType: "company", companyId: entityId };
    if (r.companyAction.agentId && r.companyAction.action === "update") {
      entityType = "agent"; entityId = r.companyAction.agentId; action = r.companyAction.agentAction ?? action;
    }
  } else if (r.businessAction?.business?.id) {
    action = r.businessAction.action; entityType = "business"; entityId = r.businessAction.business.id;
    requested = r.activeContext ?? (action === "delete" ? { contextType: "none" } : { contextType: "business", businessId: entityId });
  } else if (r.workspaceAction) {
    action = r.workspaceAction.action; entityType = action.split(".")[0]; entityId = r.workspaceAction.resourceId;
    if (!requested && r.workspaceAction.companyId) requested = { contextType: "company", companyId: r.workspaceAction.companyId };
    else if (!requested && r.workspaceAction.businessId) requested = { contextType: "business", businessId: r.workspaceAction.businessId };
  } else if (r.emailAction) {
    action = r.emailAction.action; entityType = "email." + action.split(".")[0]; entityId = r.emailAction.resourceId;
    requested = r.emailAction.companyId === "personal" || r.emailAction.companyId.startsWith("personal:")
      ? { contextType: "none" } : { contextType: "company", companyId: r.emailAction.companyId };
  } else if (r.goalAction?.goal) {
    action = r.goalAction.action; entityType = "goal"; entityId = r.goalAction.goal.id;
    requested = r.activeContext ?? { contextType: "business", businessId: r.goalAction.goal.businessId };
  }
  if (!requested) return result;
  const owner = await ownedConversation(store, auth, r.conversationId, r.onboarding?.businessId ?? r.activeContext?.businessId ?? r.businessId ?? requested.businessId);
  // A Business conversation's storage owner is independent of the entity created by its latest action.
  // Keep its existing selection namespace; the confirmed operation below still names the actual target.
  const resolved = await new ActiveContextResolver(store).resolve(auth, owner.conversation.businessId
    ? { contextType: "business", businessId: owner.conversation.businessId } : requested);
  if (action === "select") {
    entityType = resolved.context.contextType;
    entityId = resolved.context.projectId ?? resolved.context.companyId ?? resolved.context.businessId ?? null;
  }
  const value: ChatEntityContext = { schemaVersion: 1, conversationId: r.conversationId, context: resolved.context,
    lastConfirmedAction: { entityType, entityId, companyId: r.entityRead?.companyId ?? r.companyAction?.companyId ?? r.workspaceAction?.companyId ?? r.emailAction?.companyId ?? (entityType === "business" || entityType === "goal" ? null : resolved.context.companyId ?? null), projectId: action === "select" ? resolved.context.projectId ?? null : r.entityRead?.projectId ?? r.workspaceAction?.projectId ?? null, action } };
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await store.getUserSetting(auth, contextKey(r.conversationId));
    const prior = existing?.value as ChatEntityContext | undefined;
    if (action === "select" && !options.replaceSelection && prior?.schemaVersion === 1 && prior.conversationId === r.conversationId
      && prior.context.contextType === resolved.context.contextType && prior.context.companyId === resolved.context.companyId
      && prior.context.projectId === resolved.context.projectId && prior.context.businessId === resolved.context.businessId)
      value.lastConfirmedAction = prior.lastConfirmedAction;
    if (await store.setUserSetting(auth, contextKey(r.conversationId), value, existing?.revision ?? 0)) return { ...result, activeContext: resolved.context };
  }
  throw new Error("Could not persist the confirmed conversation entity context");
}

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
