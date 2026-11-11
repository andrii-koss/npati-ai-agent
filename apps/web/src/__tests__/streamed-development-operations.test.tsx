// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DevelopmentProcess } from "@npati/shared";

const mocks = vi.hoisted(() => ({ api: vi.fn(), watch: vi.fn() }));
vi.mock("../business-workspace-shared", () => ({ api: mocks.api }));
vi.mock("../chat-open", () => ({ chatOpenData: () => null, currentChatConversationId: () => null, isChatPage: () => true }));
vi.mock("../chat-development-stream", () => ({ watchDevelopmentTrace: mocks.watch }));
import { useChatDevelopment } from "../use-chat-development";
import { publishStreamedDevelopment } from "../chat-development-progress-events";
import { I18nProvider } from "../i18n";

let root: Root | undefined;
beforeEach(() => { mocks.api.mockReset().mockResolvedValue({ processes: [] }); mocks.watch.mockReset().mockResolvedValue(undefined); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; });

const process: DevelopmentProcess = {
  id: "process", companyId: "company", projectId: "site", conversationId: "server-chat", parentConversationId: "server-chat",
  name: "Minimal website", framework: "HTML/CSS", status: "running", hidden: false,
  createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:02Z",
  progress: [
    { id: "write", stage: "tool", title: "Write index.html", tool: "code.fs.write", file: "index.html",
      files: [{ path: "index.html", action: "created", linesAdded: 24 }], status: "completed",
      conversationId: "server-chat", at: "2026-11-11T00:00:01Z" },
    { id: "build", stage: "build", title: "Verify production build", tool: "code.shell.exec", command: "npm run build",
      status: "running", conversationId: "server-chat", at: "2026-11-11T00:00:02Z" },
  ],
};

it.each([null, "existing-chat"])("uses the existing operations panel for a streamed creation in %s", async conversationId => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  let receipt: DevelopmentProcess | undefined;
  const noop = () => {};
  function View() {
    const development = useChatDevelopment({ conversationId, busy: true, companyId: "company",
      onConversation: noop, onAccepted: noop, onError: noop, onSession: noop });
    receipt = development.project;
    return <>{development.timeline}</>;
  }
  await act(async () => root!.render(<MemoryRouter><I18nProvider><View /></I18nProvider></MemoryRouter>));
  await act(async () => publishStreamedDevelopment({ routed: "chat_development", processes: [process] }, conversationId));
  expect(host.querySelector(".coding-run-activity")).not.toBeNull();
  expect(receipt?.progress?.map(item => [item.id, item.tool, item.file, item.command, item.files, item.status]))
    .toEqual(process.progress!.map(item => [item.id, item.tool, item.file, item.command, item.files, item.status]));
  expect(host.textContent).toContain("npm run build");
  expect(host.textContent).toContain("index.html");
  expect(host.textContent).not.toContain("Company settings");
  await act(async () => publishStreamedDevelopment({ routed: "chat_development", processes: [{ ...process, name: "Other chat", progress: [] }] }, "other-chat"));
  expect(receipt?.name).toBe("Minimal website");
  expect(host.querySelector(".coding-run-activity")).not.toBeNull();
});

it("retains completed operations when the root chat receives its id, after stale events and after reopening", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const completed: DevelopmentProcess = { ...process, status: "completed",
    progress: process.progress!.map(item => ({ ...item, status: "completed" })),
  };
  mocks.api.mockImplementation(async (url: string) => ({ processes: url.includes("server-chat") ? [completed] : [] }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const noop = () => {};
  function View({ id, busy }: { id: string | null; busy: boolean }) {
    const development = useChatDevelopment({ conversationId: id, busy, companyId: "company",
      onConversation: noop, onAccepted: noop, onError: noop, onSession: noop });
    return <>{development.timeline}</>;
  }
  const render = (id: string | null, busy: boolean) => act(async () => root!.render(
    <MemoryRouter><I18nProvider><View id={id} busy={busy} /></I18nProvider></MemoryRouter>,
  ));
  await render(null, true);
  await act(async () => publishStreamedDevelopment({ routed: "chat_development", processes: [process] }, null));
  expect(host.querySelector(".coding-run-activity")).not.toBeNull();
  await act(async () => publishStreamedDevelopment({ routed: "chat_development", processes: [completed] }, null));
  const oldStream = mocks.watch.mock.calls.at(-1)!;
  await render("server-chat", false);
  expect((oldStream[0] as AbortSignal).aborted).toBe(true);
  expect(mocks.watch.mock.calls.at(-1)![2]).toBe("server-chat");
  await act(async () => oldStream[1]([]));
  expect(host.querySelector(".coding-run-activity")).not.toBeNull();
  expect(host.textContent).toContain("index.html");
  await act(async () => root!.unmount());
  root = createRoot(host);
  await render("server-chat", false);
  expect(host.querySelector(".coding-run-activity")).not.toBeNull();
  expect(host.textContent).toContain("index.html");
});
