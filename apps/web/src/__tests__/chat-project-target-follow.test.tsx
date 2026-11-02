// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../business-workspace-shared", async importOriginal => ({ ...await importOriginal<object>(), api: mocks.api, useWorkspace: () => ({ overview: { currentBusiness: null }, loading: false }) }));
import { I18nProvider } from "../i18n";
import { BusinessChatPage } from "../BusinessWorkspace";
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("continues in the project the server routed a follow-up to, not in the project the chat was opened with", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  const project = (id: string, name: string) => ({ id, name, status: "ready", type: "code_project" });
  mocks.api.mockImplementation(async (url: string) => url.endsWith("/projects/todo") ? project("todo", "TODO")
    : url.endsWith("/projects/game") ? project("game", "Змійка")
    : url.startsWith("/chat/development/processes") ? { processes: [] } : url === "/conversations" ? [] : url.startsWith("/conversations/chat") ? { messages: [], earlier: 0 } : {});
  const requests: Record<string, unknown>[] = [];
  const projectReads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/chat/development/processes/stream")) return new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener("abort", () => c.close(), { once: true }); } }));
    if (url.startsWith("/api/chat/open")) return new Response(JSON.stringify({ overview: null, conversation: { id: "chat", title: "", messages: [], earlier: 0 }, company: null, chats: { items: [], more: false }, processes: [] }));
    if (url === "/api/chat/stream") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      // The server reads "У грі …" as the chat's game and answers with the project it worked in.
      const projectId = String(body.message).startsWith("У грі") ? "game" : String(body.projectId);
      const result = { message: "Готово.", conversationId: "chat", activeContext: { contextType: "project", companyId: "company", projectId } };
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("event: result\ndata: " + JSON.stringify(result) + "\n\n")); c.close(); } }));
    }
    return new Response("{}");
  }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter initialEntries={["/c/chat?company=company&project=todo"]}><I18nProvider><BusinessChatPage neutralChat initialConversationId="chat" /></I18nProvider></MemoryRouter>));
  const send = async (text: string) => {
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 30)); });
  };
  await send("У грі додай кнопку «Пауза».");
  await send("Додай ще відображення рахунку.");
  expect(requests.map(item => item.projectId)).toEqual(["todo", "game"]);
  for (const [url] of mocks.api.mock.calls as [string][]) if (/\/projects\/(todo|game)$/u.test(url)) projectReads.push(url.split("/").at(-1)!);
  // The chat's project card follows the selection too.
  expect(projectReads.at(-1)).toBe("game");
});
