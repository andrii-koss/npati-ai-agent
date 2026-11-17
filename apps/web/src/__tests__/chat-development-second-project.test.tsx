// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { DevelopmentProcess } from "@npati/shared";
const mocks = vi.hoisted(() => ({ api: vi.fn(), push: undefined as undefined | ((snapshot: DevelopmentProcess[]) => void) }));
vi.mock("../business-workspace-shared", async importOriginal => ({ ...await importOriginal<object>(), api: mocks.api }));
vi.mock("../chat-development-stream", () => ({ watchDevelopmentTrace: (_signal: AbortSignal, receive: (snapshot: DevelopmentProcess[]) => void) => { mocks.push = receive; return new Promise(() => {}); } }));
import { I18nProvider } from "../i18n";
import { useChatDevelopment } from "../use-chat-development";

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

const base = { companyId: "company", parentConversationId: "chat", conversationId: "chat", framework: "HTML/CSS", hidden: false, createdAt: "2026-11-12" };
const site: DevelopmentProcess = { ...base, id: "site-process", projectId: "site", name: "V6TEST_S4_R1", status: "completed", updatedAt: "2026-11-12T09:00:00Z" };
const game = (status: DevelopmentProcess["status"], updatedAt: string): DevelopmentProcess => ({ ...base, id: "game-process", projectId: "game", name: "V6TEST_S4_R2", status, updatedAt });

// Live V6 step 04: a second project created in the same chat finished, but its reply and card appeared only after a
// reload, because the chat watched its earlier project (the newest card it had loaded) instead.
it("reloads the chat when a second project of the same chat finishes", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.api.mockImplementation(async () => ({ processes: [site, game("running", "2026-11-12T09:01:00Z")] }));
  const onConversation = vi.fn();
  function Harness() { useChatDevelopment({ companyId: "company", conversationId: "chat", latestProjectId: "site", onConversation, onError: vi.fn(), onAccepted: vi.fn(), onSession: vi.fn() }); return null; }
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<I18nProvider><MemoryRouter><Harness /></MemoryRouter></I18nProvider>));
  await act(async () => { await Promise.resolve(); });
  expect(mocks.push).toBeDefined();
  onConversation.mockClear();
  await act(async () => { mocks.push!([site, game("completed", "2026-11-12T09:02:00Z")]); });
  expect(onConversation).toHaveBeenCalledWith("chat");
});

// Live V6 step 18: the tab was closed during an edit and the chat opened again while the agent still worked. The chat
// was busy from the start, never recorded the run as running, and its answer appeared only after a reload.
it("reloads a chat reopened during a run once that run finishes, though the chat was busy when it opened", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.api.mockImplementation(async () => ({ processes: [site, game("running", "2026-11-12T09:01:00Z")] }));
  const onConversation = vi.fn();
  let busy = true;
  function Harness() { useChatDevelopment({ companyId: "company", conversationId: "chat", latestProjectId: "game", busy, onConversation, onError: vi.fn(), onAccepted: vi.fn(), onSession: vi.fn() }); return null; }
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<I18nProvider><MemoryRouter><Harness /></MemoryRouter></I18nProvider>));
  await act(async () => { await Promise.resolve(); });
  onConversation.mockClear();
  // The run finishes while the chat still counts as busy, then the chat stops being busy.
  await act(async () => { mocks.push!([site, game("completed", "2026-11-12T09:02:00Z")]); });
  expect(onConversation).not.toHaveBeenCalled();
  busy = false;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await act(async () => root!.render(<I18nProvider><MemoryRouter><Harness /></MemoryRouter></I18nProvider>));
    expect(onConversation).toHaveBeenCalledWith("chat");
    // The answer is saved after the run's final steps: the chat reads the messages twice more.
    await act(async () => { vi.advanceTimersByTime(12_000); });
    expect(onConversation).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});
