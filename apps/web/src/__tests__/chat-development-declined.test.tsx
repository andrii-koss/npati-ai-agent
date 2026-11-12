// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { planChatDevelopment } from "@npati/shared";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../business-workspace-shared", async importOriginal => ({ ...await importOriginal<object>(), api: mocks.api }));
import { I18nProvider } from "../i18n";
import { useChatDevelopment } from "../use-chat-development";

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Live V6 step 03: "створи ще одну компанію V6TEST_Flowers - квітковий магазин" matched the keyword planner ("магазин"),
// the server found no project (400), and the message was dropped instead of reaching the chat.
it("hands a message the server does not read as a project back to the ordinary chat", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const message = "тепер створи ще одну компанію V6TEST_Flowers - квітковий магазин у Львові, без агентів";
  expect(planChatDevelopment(message, undefined).length).toBeGreaterThan(0);
  mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url === "/chat/development/processes") throw Object.assign(new Error("Describe a website, blog, shop, mobile app or CRM to create."), { code: "not_development_request", status: 400 });
    return { processes: [] };
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start() {} }))));
  const onError = vi.fn(), onAccepted = vi.fn(), onDeclined = vi.fn();
  let submit: ((text: string) => Promise<boolean>) | undefined;
  function Harness() { const development = useChatDevelopment({ companyId: "company", conversationId: "chat", onConversation: vi.fn(), onError, onAccepted, onDeclined, onSession: vi.fn() }); submit = development.submit; return null; }
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<I18nProvider><MemoryRouter><Harness /></MemoryRouter></I18nProvider>));
  let handled: boolean | undefined;
  await act(async () => { handled = await submit!(message); });
  expect(handled).toBe(false);
  expect(onDeclined).toHaveBeenCalledWith(message);
  expect(onError).not.toHaveBeenCalled();
});

it("still shows a real development failure", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url === "/chat/development/processes") throw Object.assign(new Error("Four development processes are already active."), { status: 409 });
    return { processes: [] };
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start() {} }))));
  const onError = vi.fn(), onDeclined = vi.fn();
  let submit: ((text: string) => Promise<boolean>) | undefined;
  function Harness() { const development = useChatDevelopment({ companyId: "company", conversationId: "chat", onConversation: vi.fn(), onError, onAccepted: vi.fn(), onDeclined, onSession: vi.fn() }); submit = development.submit; return null; }
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<I18nProvider><MemoryRouter><Harness /></MemoryRouter></I18nProvider>));
  let handled: boolean | undefined;
  await act(async () => { handled = await submit!("створи сайт кав'ярні на HTML"); });
  expect(handled).toBe(true);
  expect(onError).toHaveBeenCalledWith("Four development processes are already active.");
  expect(onDeclined).not.toHaveBeenCalled();
});
