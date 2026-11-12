// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn(), stream: vi.fn() }));
vi.mock("../business-workspace-shared", async original => ({ ...await original<object>(), api: mocks.api, useWorkspace: () => ({ overview: { currentBusiness: null }, loading: false }) }));
vi.mock("../chat-open", () => ({ chatOpenData: () => null }));
vi.mock("../chat-stream", async original => ({ ...await original<object>(), streamChat: mocks.stream }));
vi.mock("../use-chat-development", () => ({ useChatDevelopment: () => ({ processesReady: false, project: null, activeProject: null,
  isActive: false, submitting: false, openingProjectChat: false, card: () => undefined, hideMessage: () => false, preview: null, stop: async () => {}, submit: async () => false }) }));
vi.mock("../use-code-inbox", () => ({ useCodeInbox: () => ({ session: null, snapshot: null, active: false, accept: () => {}, bindConversation: () => {}, refresh: () => {} }) }));
import { BusinessChatPage } from "../BusinessWorkspace";
import { I18nProvider } from "../i18n";
let host: HTMLDivElement, root: Root;
let frames: Map<number, FrameRequestCallback>, frameId: number;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map(); frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  mocks.api.mockReset(); mocks.stream.mockReset();
  mocks.api.mockResolvedValue({ messages: [{ id: "old", role: "assistant", content: "Loaded history is ready", createdAt: "2026-11-12" }], earlier: 0, cursor: "old" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); });
const render = (id = "chat") => act(async () => root.render(<MemoryRouter initialEntries={["/c/chat"]}><I18nProvider><BusinessChatPage neutralChat initialConversationId={id} /></I18nProvider></MemoryRouter>));

it("shows loaded messages even when development processes are still unresolved", async () => {
  await render(); expect(host.textContent).toContain("Loaded history is ready");
  expect(mocks.api).toHaveBeenCalledTimes(1);
});

it("replaces the previous conversation on an in-place chat switch", async () => {
  await render();
  mocks.api.mockResolvedValue({ messages: [{ id: "other", role: "assistant", content: "Another conversation", createdAt: "2026-11-12" }], earlier: 0, cursor: "other" });
  await render("other-chat");
  expect(host.textContent).toContain("Another conversation");
  expect(host.textContent).not.toContain("Loaded history is ready");
  expect(mocks.api).toHaveBeenLastCalledWith("/conversations/other-chat/messages");
});

it("paints received text before research presentation and the final stream result finish", async () => {
  let finish!: (reply: unknown) => void;
  mocks.stream.mockImplementation((_body: unknown, progress: (event: unknown) => void, options: { onDelta(delta: string): void }) => {
    progress({ type: "search_started", query: "test", timestamp: "t" });
    progress({ type: "page_fetch_completed", url: "https://example.com", timestamp: "t" });
    progress({ type: "final_generation_started", timestamp: "t" });
    options.onDelta("The first tokens are visible now.");
    return new Promise(resolve => { finish = resolve; });
  });
  await render();
  const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Hello"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(mocks.stream).toHaveBeenCalledTimes(1);
  await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
  expect(host.textContent).toContain("The first tokens are visible now.");
  await act(async () => finish({ message: "The first tokens are visible now.", conversationId: "chat" }));
});
