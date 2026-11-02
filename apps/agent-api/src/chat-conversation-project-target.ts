import type { AuthContext, ConversationMessage, Project, WorkspaceStore } from "@npati/workspace";
import type { ActiveContextResolver, ResolvedActiveContext } from "./active-context-resolver";
import { getChatMessagesWithProjectCards } from "./project-chat-cards";

/**
 * Which of the projects one chat has worked in a follow-up request refers to. A chat that started in a TODO app and
 * then created a separate game keeps the TODO selection in the client; "У грі додай паузу" still names the game.
 * Only projects with a card in this conversation are candidates, so a request never moves to an unrelated project.
 */
export interface ConversationProject {
  id: string;
  companyId: string;
  name: string;
  kind?: string;
  /** The user requests whose result card belongs to this project, oldest first; the first one describes the project. */
  requests: string[];
}

/** Every inflection of "game" a request uses to name the game project ("у грі", "гру", "in the game"). */
const GAME_WORD = /(?<![\p{L}])(?:гр(?:а|и|і|у|ою)|ігр(?:и|а|ах|ам|ами|у|ою)?|ігор|игр(?:а|ы|е|у|ой|ах)|games?|jeux?|juegos?|jogos?|spiele?)(?![\p{L}])/iu;
/** A clause that keeps a project unchanged names it as context, not as the target ("не змінюючи TODO"). */
const PRESERVING = /(?:не\s+(?:змінюй|змінюючи|чіпай|чіпаючи|редагуй|меняй|меняя|трогай)|без\s+змін|збережи|залиш|сохрани|оставь|don'?t\s+(?:change|touch|edit|modify)|do\s+not\s+(?:change|touch|edit|modify)|without\s+(?:changing|touching)|\bkeep\b|\bpreserve\b|\bleave\b)/iu;
/** The word after a location preposition is the place the request works in: "у TODO", "повернись до TODO", "in the game". */
const LOCATION = /(?<![\p{L}])(?:у|в|до|для|in|into|back\s+to|for)\s+(?:(?:the|this|that)\s+)?([\p{L}\p{N}][\p{L}\p{N}_-]*)/giu;
/** A Latin acronym names a project wherever it stands ("кнопці TODO", "the CRM header"). */
const ACRONYM = /(?<![\p{L}\p{N}])([A-Z][A-Z0-9]{2,})(?![\p{L}\p{N}])/gu;
const QUOTED = /[«"“][^»"”\n]*[»"”]/gu;

const clauses = (text: string) => text.replace(QUOTED, " ").split(/[.,;:!?\n]+/u).filter((clause) => !PRESERVING.test(clause));
const words = (text: string) => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** An inflected word names a stored word by its stem ("змійці" → "Змійка"); short or Latin words must match whole. */
const sameWord = (term: string, word: string) => {
  if (term === word) return true;
  if (term.length < 5 || !/\p{Script=Cyrillic}/u.test(term)) return false;
  return word.startsWith(term.slice(0, Math.max(4, term.length - 2)));
};

export function conversationProjectTarget(message: string, currentProjectId: string | null | undefined, projects: ConversationProject[]): ConversationProject | undefined {
  if (projects.length < 2) return undefined;
  const current = clauses(message).join(" ");
  const targets = new Set<ConversationProject>();
  if (GAME_WORD.test(current)) {
    const games = projects.filter((project) => project.kind === "game");
    if (games.length === 1) targets.add(games[0]!);
  }
  // A project is described by its name and the request that created it, not by every later edit ("make it green").
  const profiles = new Map(projects.map((project) => [project, [project.name, ...clauses(project.requests[0] ?? "")].flatMap(words)]));
  for (const match of [...current.matchAll(LOCATION), ...current.matchAll(ACRONYM)]) {
    const term = match[1]!.toLocaleLowerCase();
    if (term.length < 3 || GAME_WORD.test(term)) continue;
    // A word several projects share ("кнопку", "додай") does not tell them apart.
    const named = projects.filter((project) => profiles.get(project)!.some((word) => sameWord(term, word)));
    if (named.length === 1) targets.add(named[0]!);
  }
  if (targets.size !== 1) return undefined;
  const target = [...targets][0]!;
  return target.id === currentProjectId ? undefined : target;
}

/**
 * The chat context for a follow-up that names another project this chat already works in ("У грі …" after creating a
 * game from the TODO chat): the client still sends the earlier selection, so the request's own reference decides.
 */
export async function resolveConversationProjectTarget(store: WorkspaceStore, resolver: ActiveContextResolver, auth: AuthContext, input: {
  conversationId?: string; message: string; current: ResolvedActiveContext; intent?: string; history: ConversationMessage[];
  log: { info(payload: unknown, message?: string): void };
}): Promise<ResolvedActiveContext | undefined> {
  const from = input.current.project;
  if (!input.conversationId || !from || input.intent === "CREATE_WEBSITE" || input.intent === "CREATE_PROJECT") return undefined;
  const target = conversationProjectTarget(input.message, from.id, await readConversationProjects(store, auth, input.conversationId, input.history));
  if (!target) return undefined;
  input.log.info({ fromProjectId: from.id, projectId: target.id }, "chat_conversation_project_target");
  return resolver.resolve(auth, { contextType: "project", companyId: target.companyId, projectId: target.id });
}

const UNAVAILABLE = new Set(["archived", "soft_deleted", "purging", "deleted"]);

/** The available projects this conversation's cards point to, each with the user requests that produced its cards. */
export async function readConversationProjects(store: WorkspaceStore, auth: AuthContext, conversationId: string, history: ConversationMessage[]): Promise<ConversationProject[]> {
  const decorated = await getChatMessagesWithProjectCards(store, auth, conversationId, history.slice(-200));
  const byId = new Map<string, { companyId: string; requests: string[] }>();
  let lastRequest = "";
  for (const message of decorated) {
    if (message.role === "user") lastRequest = message.content;
    const card = message.projectCard;
    if (!card?.companyId) continue;
    const id = card.projectId ?? card.id;
    const entry = byId.get(id) ?? { companyId: card.companyId, requests: [] };
    const request = message.role === "user" ? message.content : lastRequest;
    if (request && !entry.requests.includes(request)) entry.requests.push(request);
    byId.set(id, entry);
  }
  const projects = await Promise.all([...byId].map(async ([id, entry]): Promise<ConversationProject | undefined> => {
    // The store checks ownership again: a card never grants access to a project the user cannot open.
    const project: Project | undefined = await store.getProject(auth, entry.companyId, id).catch(() => undefined);
    if (!project || project.companyId !== entry.companyId || UNAVAILABLE.has(project.status)) return undefined;
    return { id: project.id, companyId: project.companyId, name: project.name, kind: project.kind, requests: entry.requests };
  }));
  return projects.filter((project): project is ConversationProject => Boolean(project));
}

/** The ids of the projects this conversation worked in, read only when a request is ambiguous; none without memory. */
export const conversationProjectIds = (store: WorkspaceStore, auth: AuthContext, conversationId: string | undefined, history: ConversationMessage[]) =>
  async () => conversationId ? (await readConversationProjects(store, auth, conversationId, history)).map(project => project.id) : [];
