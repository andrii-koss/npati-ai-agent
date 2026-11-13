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
import { forgetChatOpen } from "../chat-open";
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); forgetChatOpen(); document.body.innerHTML = ""; sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// D04 (Stage3 L25-EN): "Open in chat" on an empty Code project, then a greenfield request creates "My Tasks" in the
// same chat. The chat kept showing only the empty project's card, and its Preview opened the empty workspace.
const empty = { id: "empty", projectId: "empty", companyId: "company", name: "e2e-L25-EN", status: "idle", kind: "code_project" as const };
const created = { id: "tasks", projectId: "tasks", companyId: "company", name: "My Tasks", status: "completed", kind: "code_project" as const, runId: "run", previewUrl: "/preview/tasks", lastBuildStatus: "ready" };
const processes: DevelopmentProcess[] = [
  { id: "open", companyId: "company", projectId: "empty", parentConversationId: "root", conversationId: "chat", name: empty.name, framework: "", status: "idle", hidden: true, createdAt: "2026-11-01T09:35:00.000Z", updatedAt: "2026-11-01T09:35:00.000Z" },
  { id: "dev", companyId: "company", projectId: "tasks", sessionId: "session", runId: "run", parentConversationId: "chat", conversationId: "chat", name: "My Tasks", framework: "React + Vite", status: "completed", previewUrl: "/preview/tasks", hidden: false, createdAt: "2026-11-01T09:36:00.000Z", updatedAt: "2026-11-01T09:42:00.000Z" },
];
const messages = [
  { id: "intro", role: "assistant", content: empty.name, projectCard: empty, createdAt: "2026-11-01T09:35:00.000Z" },
  { id: "request", role: "user", content: "Create a task management application using React + Vite + TypeScript.", projectCard: created, createdAt: "2026-11-01T09:36:00.000Z" },
  { id: "database", role: "assistant", content: "Created database", projectCard: created, createdAt: "2026-11-01T09:36:05.000Z" },
  { id: "reply", role: "assistant", content: "Implemented the My Tasks app.", createdAt: "2026-11-01T09:42:00.000Z" },
];

const finalReviewText = "Fixed the blocking review finding: the publishable API key is no longer hardcoded in main.py. The service now reads PROJECT_API_URL and PROJECT_PUBLISHABLE_KEY from the environment at request time and returns a clear 503 when the key is not configured, so no credential lives in source control. Re-ran the configured tests after the change and all 5 passed.";
it.each(["/c/chat", "/c/chat?company=company&project=empty"].flatMap(entry => [false,true].map(replayed => ({entry,replayed}))))("puts Preview directly below the final review text from $entry (replayed=$replayed)", async ({entry,replayed}) => {
  const scenarioMessages = messages.map(message => !replayed && message.id === "reply" ? {...message, content: finalReviewText, createdAt: "2026-11-01T09:43:05.000Z"} : message);
  const completed = processes.map(p => p.id === "dev" ? { ...p, progress: [
    { id: "final-check", stage: "tool", tool: "code.verify.run", title: "Final syntax check", status: "completed" as const, at: "2026-11-01T09:43:00.000Z" },
    ...(replayed ? [{ id: "review-reply", kind: "assistant_message" as const, stage: "planning", title: finalReviewText, status: "completed" as const, at: "2026-11-01T09:43:05.000Z" }] : []),
  ] } : p);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  const project = (id: string) => id === "tasks" ? { id, name: "My Tasks", status: "ready", type: "code_project", previewUrl: "/preview/tasks" } : { id, name: empty.name, status: "ready", type: "code_project" };
  mocks.api.mockImplementation(async (url: string) => url.startsWith("/chat/development/processes") ? { processes: completed }
    : /\/projects\/(empty|tasks)$/u.test(url) ? project(url.split("/").at(-1)!)
    : url === "/conversations" ? [] : url.startsWith("/conversations/chat") ? { messages: scenarioMessages, earlier: 0 } : {});
  const previewRequests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/chat/development/processes/stream")) return new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener("abort", () => c.close(), { once: true }); } }));
    if (url.startsWith("/api/chat/open")) return new Response(JSON.stringify({ overview: null, conversation: { id: "chat", title: "", messages: scenarioMessages, earlier: 0 }, company: null, chats: { items: [], more: false }, processes: completed }));
    if (url.includes("/preview")) { previewRequests.push(url); return new Response(JSON.stringify(url.endsWith("/preview/token") ? { token: "t" } : { isRunning: true })); }
    return new Response("{}");
  }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter initialEntries={[entry]}><I18nProvider><BusinessChatPage neutralChat initialConversationId="chat" /></I18nProvider></MemoryRouter>); await new Promise(resolve => setTimeout(resolve, 50)); });
  const triggers = [...host.querySelectorAll<HTMLElement>(".coding-preview-trigger")];
  const cardOf = (el: HTMLElement) => el.closest("article")?.textContent ?? "";
  expect(triggers.some(el => cardOf(el).includes("React + Vite"))).toBe(true);
  // The superseded empty entry project offers no Preview of its empty workspace.
  expect(triggers).toHaveLength(1);
  expect(triggers.some(el => cardOf(el).includes(empty.name))).toBe(false);
  // The created project's card follows the messages and operations.
  expect(cardOf(triggers.at(-1)!)).toContain("React + Vite");
  expect(host.querySelector("article.user .coding-preview-trigger")).toBeNull();
  const lastOperation = [...host.querySelectorAll(".codex-trace-row")].at(-1);
  expect(lastOperation).toBeDefined();
  expect(lastOperation!.compareDocumentPosition(triggers.at(-1)! ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const finalReply = host.querySelector(`[data-chat-reply-id="${replayed ? "review-reply" : "reply"}"]`);
  expect(finalReply?.textContent).toContain(finalReviewText);
  expect(finalReply?.contains(triggers.at(-1)!)).toBe(true);
  expect(finalReply?.querySelector(".chat-message-content")?.nextElementSibling?.classList.contains("chat-project-preview-card")).toBe(true);
  await act(async () => { triggers.at(-1)!.click(); await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(previewRequests.some(url => url.includes("/projects/tasks/"))).toBe(true);
  expect(previewRequests.some(url => url.includes("/projects/empty/preview/start"))).toBe(false);
});

it("offers no Preview while this chat's project is still being built", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  const building = processes.map(p => p.id === "dev" ? { ...p, status: "running" as const } : p);
  mocks.api.mockImplementation(async (url: string) => url.startsWith("/chat/development/processes") ? { processes: building }
    : url === "/conversations" ? [] : url.startsWith("/conversations/chat") ? { messages, earlier: 0 } : {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/chat/development/processes/stream")) return new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener("abort", () => c.close(), { once: true }); } }));
    if (url.startsWith("/api/chat/open")) return new Response(JSON.stringify({ overview: null, conversation: { id: "chat", title: "", messages, earlier: 0 }, company: null, chats: { items: [], more: false }, processes: building }));
    return new Response(JSON.stringify({ isRunning: true }));
  }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter initialEntries={["/c/chat"]}><I18nProvider><BusinessChatPage neutralChat initialConversationId="chat" /></I18nProvider></MemoryRouter>); await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(host.querySelectorAll(".coding-preview-trigger")).toHaveLength(0);
  expect(host.textContent).not.toContain("Live Preview Running");
});
