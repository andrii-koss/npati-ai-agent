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
/** A kind of project named in any supported language. Non-Latin scripts write words without spaces, so those have no word boundary. */
const PROJECT_KINDS: Array<{ kind?: string; word: RegExp }> = [
  { word: /(?<![\p{L}])(?:блог\p{L}*|блоз\p{L}*|blog\p{L}*)|ブログ|博客|블로그|مدونة|ब्लॉग/iu },
  { word: /(?<![\p{L}])(?:магазин\p{L}*|shop|store|sklep\p{L}*|tienda|loja|negozio|boutique|mağaza\p{L}*|winkel)(?![\p{L}])|ショップ|商店|쇼핑몰|متجر|दुकान/iu },
  { kind: "mobile_app", word: /(?<![\p{L}])(?:мобільн\p{L}*|мобильн\p{L}*|mobile|móvil|mobilne\p{L}*|mobil)(?![\p{L}])|モバイル|手机|모바일|جوال|मोबाइल/iu },
];
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

/**
 * "у другому", "в першому", "in the second one": a project named by the order this chat created it in. The ordinal counts
 * only when a project word, an action verb or the end of the clause follows, so "у другому рядку" or "другу кнопку" (a line
 * or a button inside the project) never moves the request to another project.
 */
const ORDINAL_INDEX: Array<{ index: number | "last"; word: RegExp }> = [
  { index: 0, word: /перш\p{L}*|перв\p{L}*|first|erst\p{L}*|premi\p{L}*|primer\p{L}*|prim[oa]|pierwsz\p{L}*|eerste/iu },
  { index: 1, word: /друг\p{L}*|втор\p{L}*|second\p{L}*|zweit\p{L}*|deuxième|segund\p{L}*|drug\p{L}*|tweede/iu },
  { index: 2, word: /трет\p{L}*|third|dritt\p{L}*|troisième|tercer\p{L}*|terz\p{L}*|trzeci\p{L}*|derde/iu },
  { index: "last", word: /останн\p{L}*|последн\p{L}*|last|letzt\p{L}*|dernier\p{L}*|últim\p{L}*|ultim\p{L}*|ostatni\p{L}*|laatste/iu },
];
const PROJECT_NOUN = /^(?:проєкт\p{L}*|проект\p{L}*|сайт\p{L}*|гр[аиіу]|грі|ігр\p{L}*|застосун\p{L}*|додат\p{L}*|приложен\p{L}*|project\p{L}*|site|website|game|app|one|projekt\p{L}*|projet|proyecto|progetto)$/iu;
const ACTION_VERB = /^(?:зміни|змініть|додай|додайте|видали|прибери|зроби|перевір|постав|онови|виправ|покажи|відкрий|измени|добавь|удали|сделай|проверь|исправь|поставь|change|add|remove|make|update|fix|check|set|open|show)$/iu;
export function ordinalProjectTarget(message: string, projects: ConversationProject[]): ConversationProject | undefined {
  if (projects.length < 2) return undefined;
  for (const clause of clauses(message)) {
    const tokens = words(clause);
    for (let i = 0; i < tokens.length; i++) {
      const entry = ORDINAL_INDEX.find(({ word }) => new RegExp(`^(?:${word.source})$`, "iu").test(tokens[i]!));
      if (!entry) continue;
      const before = tokens[i - 1], after = tokens[i + 1], afterThe = tokens[i - 1] === "the" ? tokens[i - 2] : undefined;
      const located = ["у", "в", "во", "in", "on", "im", "dans", "en", "nel"].includes(before ?? "") || ["in", "on"].includes(afterThe ?? "");
      const named = after !== undefined && PROJECT_NOUN.test(after);
      if (!named && !(located && (after === undefined || ACTION_VERB.test(after) || CHANGE_REQUEST.test(after) || CHECK_REQUEST.test(after)))) continue;
      const index = entry.index === "last" ? projects.length - 1 : entry.index;
      return projects[index];
    }
  }
  return undefined;
}

/** "Перевір обидва проєкти", "check both", "всі проєкти": every project this chat worked in, for a read-only batch. */
const PLURAL_PROJECTS = /(?<![\p{L}])(?:обидва|обидві|обох|оба|обоих|обе|both|beide\p{L}*|les\s+deux|ambos|ambas|entrambi|oba|obydwa|her\s+ikisi|(?:усі|всі|все|all)\s+(?:\p{L}+\s+)?(?:проєкт\p{L}*|проект\p{L}*|projects?))(?![\p{L}])|两个|両方|둘\s*다/iu;
export function pluralProjectTargets(message: string, projects: ConversationProject[]): ConversationProject[] {
  return projects.length >= 2 && PLURAL_PROJECTS.test(clauses(message).join(" ")) ? projects : [];
}

/**
 * A read-only check request ("перевір", "проверь", "check", typos such as "перевирь"). The intent router reads
 * "перевір обидва проєкти" as conversation, so a plural check is recognised here; a change request never matches.
 */
const CHECK_REQUEST = /(?<![\p{L}])(?:перев[іиі]р\p{L}*|перевирь|провір\p{L}*|протесту\p{L}*|тестуй|проверь\p{L}*|протестир\p{L}*|check|test|review|verify|inspect|prüf\p{L}*|teste|vérifie\p{L}*|revisa\p{L}*|controlla|sprawdź|kontroluj)(?![\p{L}])/iu;
export function isProjectCheckRequest(message: string): boolean {
  return CHECK_REQUEST.test(message);
}
/** A change request ("зміни", "поменяй", "make", typos such as "змини"): it writes, so it is never a read-only check. */
const CHANGE_REQUEST = /(?<![\p{L}])(?:змін\p{L}*|змини|додай\p{L}*|добав\p{L}*|видали\p{L}*|прибери|зроби\p{L}*|постав\p{L}*|онови\p{L}*|виправ\p{L}*|перефарбуй|замін\p{L}*|помін\p{L}*|измени\p{L}*|поменяй\p{L}*|добавь\p{L}*|удали\p{L}*|сделай\p{L}*|исправь\p{L}*|поставь\p{L}*|замени\p{L}*|change|add|remove|make|update|fix|set|replace|rename|ändere|ajoute|change[zr]?|cambia|modifica|zmień|dodaj|wijzig)(?![\p{L}])/iu;
export type ProjectBatchIntent = "REVIEW_PROJECT" | "TEST_PROJECT" | "PREVIEW_PROJECT" | "EDIT_PROJECT";
const READ_BATCH_INTENTS: string[] = ["REVIEW_PROJECT", "TEST_PROJECT", "PREVIEW_PROJECT"];
const EDIT_INTENTS: string[] = ["EDIT_PROJECT", "EDIT_WEBSITE", "IMPROVE_PROJECT", "DEBUG_PROJECT"];
/**
 * The batch intent of a request over several projects, or undefined when it is not one. A change ("зміни фон в обох")
 * is an edit of each project in turn, and only when `allowEdit` says the user named the projects together.
 */
export function projectBatchIntent(message: string, intent: string | undefined, options: { allowEdit?: boolean } = {}): ProjectBatchIntent | undefined {
  const changes = CHANGE_REQUEST.test(message) || (intent !== undefined && EDIT_INTENTS.includes(intent));
  if (changes) return options.allowEdit ? "EDIT_PROJECT" : undefined;
  if (intent && READ_BATCH_INTENTS.includes(intent)) return intent as ProjectBatchIntent;
  return (!intent || intent === "CHAT") && isProjectCheckRequest(message) ? "REVIEW_PROJECT" : undefined;
}

export function conversationProjectTarget(message: string, currentProjectId: string | null | undefined, projects: ConversationProject[]): ConversationProject | undefined {
  if (projects.length < 2) return undefined;
  const current = clauses(message).join(" ");
  const targets = new Set<ConversationProject>();
  const ordinal = ordinalProjectTarget(message, projects);
  if (ordinal) targets.add(ordinal);
  if (GAME_WORD.test(current)) {
    const games = projects.filter((project) => project.kind === "game");
    if (games.length === 1) targets.add(games[0]!);
  }
  for (const { kind, word } of PROJECT_KINDS) {
    if (!word.test(current)) continue;
    const matching = projects.filter((project) => (kind && project.kind === kind) || word.test(project.name) || word.test(project.requests[0] ?? ""));
    if (matching.length === 1) targets.add(matching[0]!);
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
  // A client that selects only the company still works in this conversation's projects of that company: "return to the
  // cafe site" asked which of every company project to change (V6 step 20, V6-D20-02).
  const companyId = from ? undefined : input.current.context.contextType === "company" ? input.current.company?.id : undefined;
  if (!input.conversationId || (!from && !companyId) || input.intent === "CREATE_WEBSITE" || input.intent === "CREATE_PROJECT") return undefined;
  const projects = (await readConversationProjects(store, auth, input.conversationId, input.history))
    .filter((project) => !companyId || project.companyId === companyId);
  // "Check both projects" / "change the background in both": a batch over every project of this chat, one project at a time.
  const plural = projectBatchIntent(input.message, input.intent, { allowEdit: true }) ? pluralProjectTargets(input.message, projects) : [];
  if (plural.length && plural.every((project) => project.companyId === plural[0]!.companyId)) {
    const loaded = (await Promise.all(plural.map((project) => store.getProject(auth, project.companyId, project.id).catch(() => undefined)))).filter((project): project is Project => Boolean(project));
    if (loaded.length >= 2) {
      input.log.info({ projectIds: loaded.map((project) => project.id) }, "chat_conversation_project_batch");
      return { ...await resolver.resolve(auth, { contextType: "company", companyId: plural[0]!.companyId }), projects: loaded, pluralReference: true };
    }
  }
  const target = conversationProjectTarget(input.message, from?.id, projects);
  if (!target) return undefined;
  input.log.info({ fromProjectId: from?.id ?? null, companyId: companyId ?? null, projectId: target.id }, "chat_conversation_project_target");
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
