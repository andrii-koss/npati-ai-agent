import { describe, expect, it } from "vitest";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { conversationProjectTarget, readConversationProjects, type ConversationProject } from "../apps/agent-api/src/chat-conversation-project-target";
import { saveChatProjectCard } from "../apps/agent-api/src/project-chat-cards";

const auth: AuthContext = { userId: "target-user", workspaceId: "target-workspace", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

// The Stage 4 chat (D02): a TODO app, then a separate Snake game created from the same chat.
const todo: ConversationProject = { id: "todo", companyId: "c", name: "e2e-stage4-S01", kind: "website",
  requests: ["Створи новий React/Vite TODO-проєкт із додаванням і видаленням задач.", "Зміни основну кнопку на зелений колір #16a34a.", "Додай збереження задач у localStorage."] };
const game: ConversationProject = { id: "game", companyId: "c", name: "Змійка", kind: "game",
  requests: ["Створи ОКРЕМИЙ тестовий браузерний проєкт гри «Змійка», не змінюючи TODO."] };
const both = [todo, game];
const target = (message: string, current: string, projects = both) => conversationProjectTarget(message, current, projects)?.id;

describe("project a follow-up names among the chat's projects", () => {
  it("routes the Stage 4 game requests to the game while the client still selects the TODO app", () => {
    expect(target("У грі додай кнопку «Пауза».", "todo")).toBe("game");
    expect(target("У грі додай відображення рахунку.", "todo")).toBe("game");
    expect(target("Add a high score to the game", "todo")).toBe("game");
    expect(target("У змійці збільш швидкість", "todo")).toBe("game");
  });

  it("returns to the TODO app when a request names it", () => {
    expect(target("Повернись до TODO: зміни текст кнопки створення задачі на «Додати задачу».", "game")).toBe("todo");
    expect(target("У TODO додай фільтр «Виконані».", "game")).toBe("todo");
    expect(target("Поверни основній кнопці TODO колір, який вона мала до кроку 5; інші зміни збережи.", "game")).toBe("todo");
  });

  it("keeps the selected project when the request names no other one", () => {
    expect(target("У грі додай кнопку «Пауза».", "game")).toBeUndefined();
    expect(target("Додай пошук за назвою задачі.", "todo")).toBeUndefined();
    expect(target("Зміни колір кнопки на зелений", "game")).toBeUndefined();
    // A later edit's words ("localStorage", "зелений") do not describe the project.
    expect(target("Додай збереження рекорду у localStorage", "game")).toBeUndefined();
    // Quoted replacement text is not a location.
    expect(target("Зміни заголовок на «Гра в TODO»", "game")).toBeUndefined();
  });

  it("does not treat a project the request preserves as its target", () => {
    expect(target("Додай рахунок у грі, не змінюючи TODO", "todo")).toBe("game");
    expect(target("Додай фільтр, не змінюючи гру", "todo")).toBeUndefined();
  });

  it("does not guess between several matching projects or in a single-project chat", () => {
    const secondGame = { ...game, id: "game-2", name: "Тетріс", requests: ["Створи гру Тетріс"] };
    expect(target("У грі додай паузу", "todo", [todo, game, secondGame])).toBeUndefined();
    expect(target("У тетрісі додай паузу", "todo", [todo, game, secondGame])).toBe("game-2");
    expect(target("У грі додай паузу", "todo", [todo])).toBeUndefined();
    expect(target("У грі та в TODO додай паузу", "todo")).toBeUndefined();
  });
});

async function stage4Chat() {
  const store = new InMemoryWorkspaceStore();
  const company = await store.createCompany(auth, { name: "Target Labs" }, "target-labs");
  const { project: todoProject } = await store.createProject(auth, company.id, { name: "e2e-stage4-S01", type: "code_project", kind: "website" } as never, "todo");
  const { project: gameProject } = await store.createProject(auth, company.id, { name: "Змійка", type: "code_project", kind: "game" } as never, "game");
  const conversation = await store.createNeutralConversation(auth, "Stage 4");
  const card = (project: typeof todoProject) => ({ id: project.id, projectId: project.id, companyId: company.id, name: project.name, status: "ready", kind: "code_project" as const });
  const s01 = await store.appendNeutralMessage(auth, conversation.id, "user", "Створи новий React/Vite TODO-проєкт із додаванням і видаленням задач.");
  void s01;
  const s01Reply = await store.appendNeutralMessage(auth, conversation.id, "assistant", "Створено TODO.");
  await saveChatProjectCard(store, auth, conversation.id, s01Reply.id, card(todoProject));
  // The development service stores a new project's card with the request that created it.
  const s09 = await store.appendNeutralMessage(auth, conversation.id, "user", "Створи ОКРЕМИЙ тестовий браузерний проєкт гри «Змійка», не змінюючи TODO.");
  await saveChatProjectCard(store, auth, conversation.id, s09.id, card(gameProject));
  await store.appendNeutralMessage(auth, conversation.id, "assistant", "Створено гру.");
  return { store, company, todoProject, gameProject, conversation };
}

describe("projects of one conversation", () => {
  it("reads each project once with the request that created it and skips unavailable ones", async () => {
    const f = await stage4Chat();
    const { messages } = await f.store.getNeutralConversation(auth, f.conversation.id);
    const projects = await readConversationProjects(f.store, auth, f.conversation.id, messages);
    expect(projects.map((project) => [project.id, project.kind, project.requests[0]])).toEqual([
      [f.todoProject.id, "website", "Створи новий React/Vite TODO-проєкт із додаванням і видаленням задач."],
      [f.gameProject.id, "game", "Створи ОКРЕМИЙ тестовий браузерний проєкт гри «Змійка», не змінюючи TODO."],
    ]);
    const other: AuthContext = { ...auth, userId: "other-user", workspaceId: "other-workspace" };
    expect(await readConversationProjects(f.store, other, f.conversation.id, messages)).toEqual([]);
  });

  it("runs a Code request that names the game in the game although the client sends the TODO project", async () => {
    const f = await stage4Chat();
    const ai = { supportsNativeTools: () => true, chat: async () => ({ content: "Готово." }), async *stream() { yield "Готово."; } } as unknown as AIEngine;
    const app = buildApp({ workspaceStore: f.store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const send = (message: string) => app.inject({ method: "POST", url: "/chat/stream", payload: {
        message, conversationId: f.conversation.id, contextType: "project", companyId: f.company.id, projectId: f.todoProject.id, mode: "code" } });
      const projectOf = (body: string) => body.match(/"activeContext":\{[^}]*"projectId":"([^"]+)"/)?.[1];
      const toGame = await send("У грі додай відображення рахунку.");
      expect(toGame.statusCode).toBe(200);
      expect(projectOf(toGame.body)).toBe(f.gameProject.id);
      const stays = await send("Додай пошук за назвою задачі.");
      expect(projectOf(stays.body)).toBe(f.todoProject.id);
    } finally { await app.close(); }
  });

  // V6 step 20 (V6-D20-02): the client sends only the company. "Return to the TODO app" asked which of all the company's
  // projects to change, although this conversation created two of them and the request names one.
  it("resolves a project of this conversation when the client selects only the company", async () => {
    const f = await stage4Chat();
    const { project: unrelated } = await f.store.createProject(auth, f.company.id, { name: "Old landing", type: "code_project", kind: "website" } as never, "old-landing");
    const ai = { supportsNativeTools: () => true, chat: async () => ({ content: "Готово." }), async *stream() { yield "Готово."; } } as unknown as AIEngine;
    const app = buildApp({ workspaceStore: f.store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const send = (message: string) => app.inject({ method: "POST", url: "/chat/stream", payload: {
        message, conversationId: f.conversation.id, contextType: "company", companyId: f.company.id } });
      const projectOf = (body: string) => body.match(/"activeContext":\{[^}]*"projectId":"([^"]+)"/)?.[1];
      const toTodo = await send("Повернись до TODO: зміни текст кнопки створення задачі на «Додати задачу».");
      expect(toTodo.statusCode).toBe(200);
      expect(projectOf(toTodo.body)).toBe(f.todoProject.id);
      expect(toTodo.body).not.toContain(unrelated.name);
      const toGame = await send("У грі додай відображення рахунку.");
      expect(projectOf(toGame.body)).toBe(f.gameProject.id);
      const second = await send("у другому зміни колір фону на темно-синій");
      expect(projectOf(second.body)).toBe(f.gameProject.id);
    } finally { await app.close(); }
  });
});

describe("ordinal and plural references to the chat's projects (V6 step 02)", () => {
  it("'у другому' and 'the second one' name the second project this chat created; 'в першому' the first", () => {
    expect(target("у другому зміни колір фону на темно-синій", "todo")).toBe("game");
    expect(target("в першому зміни заголовок", "game")).toBe("todo");
    expect(target("в останньому додай паузу", "todo")).toBe("game");
    expect(target("in the second one make the background dark", "todo")).toBe("game");
    expect(target("змінити другий проєкт: темний фон", "todo")).toBe("game");
    // Live V6 step 02: a Russian verb after the ordinal ("во втором поменяй") stayed on the first project.
    expect(target("во втором поменяй цвет кнопок на оранжевый", "todo")).toBe("game");
    expect(target("в другому поміняй шрифт", "todo")).toBe("game");
    expect(target("в первом замени заголовок", "game")).toBe("todo");
  });

  it("does not move for an ordinal inside the project ('другу кнопку', 'у другому рядку')", () => {
    expect(target("зроби другу кнопку зеленою", "todo")).toBeUndefined();
    expect(target("у другому рядку таблиці виправ ціну", "todo")).toBeUndefined();
    expect(target("make the second button green", "todo")).toBeUndefined();
  });

  it("'перевір обидва проєкти' and 'check both' name every project of the chat", async () => {
    const { pluralProjectTargets } = await import("../apps/agent-api/src/chat-conversation-project-target");
    expect(pluralProjectTargets("перевір обидва проєкти", both).map(project => project.id)).toEqual(["todo", "game"]);
    expect(pluralProjectTargets("check both projects", both)).toHaveLength(2);
    expect(pluralProjectTargets("перевір усі проєкти", both)).toHaveLength(2);
    expect(pluralProjectTargets("перевір сайт", both)).toEqual([]);
    expect(pluralProjectTargets("перевір обидва", [todo])).toEqual([]);
  });
});

describe("plural check requests the intent router reads as conversation (V6 step 02, live D02-01)", () => {
  it("a check verb, also misspelled or in Russian/English, makes a read-only review batch; a change never does", async () => {
    const { projectBatchIntent } = await import("../apps/agent-api/src/chat-conversation-project-target");
    expect(projectBatchIntent("перевір обидва проєкти", "CHAT")).toBe("REVIEW_PROJECT");
    expect(projectBatchIntent("перевір обидва проєкти ще раз коротко", undefined)).toBe("REVIEW_PROJECT");
    expect(projectBatchIntent("перевирь обидва проекти", "CHAT")).toBe("REVIEW_PROJECT");
    expect(projectBatchIntent("проверь оба проекта", undefined)).toBe("REVIEW_PROJECT");
    expect(projectBatchIntent("check both projects", "CHAT")).toBe("REVIEW_PROJECT");
    expect(projectBatchIntent("протестуй обидва", "TEST_PROJECT")).toBe("TEST_PROJECT");
    expect(projectBatchIntent("зміни фон в обох проєктах", "CHAT")).toBeUndefined();
    expect(projectBatchIntent("перевір і виправ обидва", "EDIT_PROJECT")).toBeUndefined();
  });
});

describe("a change named for several projects (V6 step 02, live D02-04)", () => {
  it("is an edit batch only when the user named the projects together; a check stays read-only", async () => {
    const { projectBatchIntent } = await import("../apps/agent-api/src/chat-conversation-project-target");
    expect(projectBatchIntent("зміни фон в обох проєктах на білий", "CHAT", { allowEdit: true })).toBe("EDIT_PROJECT");
    expect(projectBatchIntent("поменяй цвет кнопок в обоих проектах", undefined, { allowEdit: true })).toBe("EDIT_PROJECT");
    expect(projectBatchIntent("make the title bigger in both projects", "EDIT_PROJECT", { allowEdit: true })).toBe("EDIT_PROJECT");
    expect(projectBatchIntent("перевір і виправ обидва", "REVIEW_PROJECT", { allowEdit: true })).toBe("EDIT_PROJECT");
    expect(projectBatchIntent("перевір обидва проєкти", "CHAT", { allowEdit: true })).toBe("REVIEW_PROJECT");
    expect(projectBatchIntent("зміни фон в обох проєктах", "EDIT_PROJECT")).toBeUndefined();
  });
});
