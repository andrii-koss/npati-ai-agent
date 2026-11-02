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
});
