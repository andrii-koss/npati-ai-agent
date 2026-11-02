// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { DevelopmentProcess } from "@npati/shared";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../business-workspace-shared", async importOriginal => ({ ...await importOriginal<object>(), api: mocks.api, useWorkspace: () => ({ overview: { currentBusiness: null }, loading: false }) }));
import { I18nProvider } from "../i18n";
import { BusinessChatPage } from "../BusinessWorkspace";
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Step 4c: a TODO chat created a separate game (S09), then worked in the TODO again (S14). After a reload the chat
// bound its inbox to the game's session (the newest process) and queued "Створи файл …" there, past D02 routing.
const card = (id: string, name: string, runId?: string) => ({ id, projectId: id, companyId: "company", name, status: "ready", kind: "code_project" as const, ...(runId ? { runId } : {}) });
const processes: DevelopmentProcess[] = [
  { id: "open-todo", companyId: "company", projectId: "todo", sessionId: "todo-session", inboxEnabled: true, parentConversationId: "root", conversationId: "chat", name: "TODO", framework: "", status: "idle", hidden: true, createdAt: "2026-11-01T17:46:00.000Z", updatedAt: "2026-11-01T17:46:00.000Z" },
  { id: "dev-game", companyId: "company", projectId: "game", sessionId: "game-session", runId: "game-run", inboxEnabled: true, parentConversationId: "chat", conversationId: "chat", name: "Змійка", framework: "HTML/CSS", status: "completed", previewUrl: "/preview/game", hidden: false, createdAt: "2026-11-01T17:50:00.000Z", updatedAt: "2026-11-01T18:04:00.000Z" },
];
const messages = [
  { id: "intro", role: "assistant", content: "TODO", projectCard: card("todo", "TODO"), createdAt: "2026-11-01T17:46:00.000Z" },
  { id: "s09", role: "user", content: "Створи ОКРЕМИЙ тестовий браузерний проєкт гри «Змійка», не змінюючи TODO.", projectCard: card("game", "Змійка", "game-run"), createdAt: "2026-11-01T17:50:00.000Z" },
  { id: "s09-reply", role: "assistant", content: "Створено гру.", createdAt: "2026-11-01T17:56:00.000Z" },
  { id: "s14", role: "user", content: "У TODO додай фільтр «Виконані».", createdAt: "2026-11-01T18:10:00.000Z" },
  { id: "s14-reply", role: "assistant", content: "Додав фільтр.", projectCard: card("todo", "TODO", "todo-run"), createdAt: "2026-11-01T18:11:00.000Z" },
];

it("sends the next request through routing for the project the chat last worked on, not into another project's inbox", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  mocks.api.mockImplementation(async (url: string) => url.startsWith("/chat/development/processes") ? { processes }
    : url === "/conversations" ? [] : url.startsWith("/conversations/chat") ? { messages, earlier: 0 } : {});
  const streamed: Record<string, unknown>[] = []; const inboxPosts: string[] = []; const inboxReads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/chat/development/processes/stream")) return new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener("abort", () => c.close(), { once: true }); } }));
    if (url.startsWith("/api/chat/open")) return new Response(JSON.stringify({ overview: null, conversation: { id: "chat", title: "", messages, earlier: 0 }, company: null, chats: { items: [], more: false }, processes }));
    const inbox = url.match(/\/code\/sessions\/([^/]+)\/messages/u);
    if (inbox) {
      if (init?.method === "POST") inboxPosts.push(inbox[1]!); else inboxReads.push(inbox[1]!);
      // The game's previous run still reads as sealed: an inbox that would accept a queued message.
      return new Response(JSON.stringify({ revision: 1, phase: inbox[1] === "game-session" ? "sealed" : "settled", runId: null, lastError: null, messages: [] }), { status: init?.method === "POST" ? 202 : 200 });
    }
    if (url === "/api/chat/stream") {
      streamed.push(JSON.parse(String(init?.body)));
      const result = { message: "Створено файл.", conversationId: "chat", activeContext: { contextType: "project", companyId: "company", projectId: "todo" } };
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("event: result\ndata: " + JSON.stringify(result) + "\n\n")); c.close(); } }));
    }
    return new Response("{}");
  }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter initialEntries={["/c/chat"]}><I18nProvider><BusinessChatPage neutralChat initialConversationId="chat" /></I18nProvider></MemoryRouter>); await new Promise(resolve => setTimeout(resolve, 80)); });
  expect(inboxReads).not.toContain("game-session");
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Створи файл e2e-smoke/hello.txt з текстом Hello"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(inboxPosts).toEqual([]);
  expect(streamed).toHaveLength(1);
  expect(streamed[0]).toMatchObject({ projectId: "todo", conversationId: "chat" });
});
