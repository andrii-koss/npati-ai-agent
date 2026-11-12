// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../business-workspace-shared", async importOriginal => ({ ...await importOriginal<object>(), api: mocks.api, useWorkspace: () => ({ overview: { currentBusiness: null }, loading: false }) }));
import { I18nProvider } from "../i18n";
import { BusinessChatPage } from "../BusinessWorkspace";
import { STREAMED_DEVELOPMENT_PROGRESS } from "../chat-development-progress-events";
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// V6 step 07 (D07-01): a new chat that creates a project learns the project from its own stream before it learns its
// conversation id. That project must not be treated as an "Open in chat" link: moving to the project's chat aborted the
// stream, and the server cancelled the run ("The run was cancelled" after 1 s, a game never built).
it("stays on the new chat while its own reply creates a project", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  mocks.api.mockImplementation(async (url: string) => url === "/chat/development/project" ? { url: "/c/other-project-chat" }
    : url.startsWith("/chat/development/processes") ? { processes: [] } : url === "/conversations" ? [] : url === "/companies" ? { companies: [{ id: "c" }] } : {});
  let streamSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/chat/stream") { streamSignal = init?.signal ?? undefined; return new Response(new ReadableStream({ start() {} })); }
    if (url.startsWith("/api/chat/development/processes/stream")) return new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener("abort", () => c.close(), { once: true }); } }));
    return new Response("{}");
  }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter initialEntries={["/chat?company=c"]}><I18nProvider><Routes>
    <Route path="/chat" element={<BusinessChatPage neutralChat />} />
    <Route path="/c/:id" element={<div className="moved-to-project-chat" />} />
  </Routes></I18nProvider></MemoryRouter>); await new Promise(resolve => setTimeout(resolve, 30)); });
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "зроби гру змійка V6TEST_S7_Snake на чистому джаваскріпт з canvas: керування стрілками, пауза на клавішу P, рахунок за їжу, гра закінчуєтся коли змія вдаряєтся в стіну або сама в себе, кнопка рестарт. дизайн мінімальний"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(streamSignal).toBeDefined();
  // The stream reports the new game project; the chat has no id yet.
  await act(async () => {
    window.dispatchEvent(new CustomEvent(STREAMED_DEVELOPMENT_PROGRESS, { detail: { conversationId: null, processes: [{
      id: "process-1", name: "V6TEST snake", companyId: "c", projectId: "new-game", conversationId: null, status: "running", progress: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }] } }));
    await new Promise(resolve => setTimeout(resolve, 50));
  });
  expect(mocks.api.mock.calls.some(([url]) => url === "/chat/development/project")).toBe(false);
  expect(host.querySelector(".moved-to-project-chat")).toBeNull();
  expect(streamSignal!.aborted).toBe(false);
});
