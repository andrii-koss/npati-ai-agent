// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../business-workspace-shared", async importOriginal => ({ ...await importOriginal<object>(), api: mocks.api, useWorkspace: () => ({ overview: { currentBusiness: null }, loading: false }) }));
import { I18nProvider } from "../i18n";
import { BusinessChatPage } from "../BusinessWorkspace";
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Step 4c (R3): "Open in chat" lands on /chat?company&project, which then moves to the project's own chat. A message sent
// before that move was cut off by it (the page remounts and aborts the stream) and silently lost.
it("keeps the first message until the project's chat is open instead of losing it to the move", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  let openChat: (value: { url: string }) => void = () => {};
  mocks.api.mockImplementation(async (url: string) => url === "/chat/development/project" ? new Promise(resolve => { openChat = resolve; })
    : url.startsWith("/chat/development/processes") ? { processes: [] } : url === "/conversations" ? [] : url.endsWith("/projects/p") ? { id: "p", name: "Fixture", status: "ready", type: "code_project" } : {});
  const streamed: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/chat/stream") { streamed.push(JSON.parse(String(init?.body))); return new Response(new ReadableStream({ start() {} })); }
    if (url.startsWith("/api/chat/development/processes/stream")) return new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener("abort", () => c.close(), { once: true }); } }));
    return new Response("{}");
  }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter initialEntries={["/chat?company=c&project=p"]}><I18nProvider><Routes>
    <Route path="/chat" element={<BusinessChatPage neutralChat />} />
    <Route path="/c/:id" element={<div className="opened-project-chat" />} />
  </Routes></I18nProvider></MemoryRouter>); await new Promise(resolve => setTimeout(resolve, 30)); });
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  // Typing is not offered yet: the move to the project chat would discard the draft with the page.
  expect(textarea.disabled).toBe(true);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Додай 12 функцій"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(true);
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(streamed).toHaveLength(0);
  expect(textarea.value).toBe("Додай 12 функцій");
  await act(async () => { openChat({ url: "/c/project-chat" }); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(host.querySelector(".opened-project-chat")).not.toBeNull();
});
