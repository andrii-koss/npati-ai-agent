import { expect, it, vi } from "vitest";
import { chatProjectCreationReply, runChatProjectCreation } from "../apps/agent-api/src/chat-project-creation";

it("waits for persisted operations and the final agent reply before returning completion", async () => {
  const initial = { id: "p", status: "completed", name: "Site", projectId: "site" };
  const saved = { ...initial, resultMessageId: "reply", cardMessageId: "request", progress: [{ id: "write", tool: "code.fs.write", file: "index.html" }] };
  let finalized = false;
  const service = {
    start: vi.fn(async () => ({ conversationId: "chat", processes: [initial] })),
    list: vi.fn(async () => [finalized ? saved : initial]), stop: vi.fn(),
    waitForCompletion: vi.fn(async () => { finalized = true; }),
  };
  const progress = vi.fn();
  const run = await runChatProjectCreation({ service: service as never, ctx: {} as never, companyId: "company",
    message: "створи мені сат", requestId: "req", signal: new AbortController().signal, progress });
  expect(service.waitForCompletion).toHaveBeenCalledWith({}, ["p"]);
  expect(run.processes[0]).toEqual(saved);
  expect(progress.mock.calls.at(-1)![0]).toEqual([saved]);
});

it("returns the persisted assistant answer and project card instead of a technical status line", async () => {
  const projectCard = { id: "site", projectId: "site", companyId: "company", name: "Minimal site" };
  const userMessage = { id: "request", role: "user", content: "створи мені сат" };
  const assistantMessage = { id: "reply", role: "assistant", content: "**Готово:** створено мінімальний сайт." };
  const store = { getNeutralConversation: vi.fn(async () => ({ messages: [userMessage, assistantMessage] })), getConversation: vi.fn(),
    getUserSetting: vi.fn(async () => ({ value: { request: projectCard } })),
  };
  const run = { conversationId: "chat", status: "completed", processes: [{ id: "p", projectId: "site", name: "Minimal site", status: "completed", resultMessageId: "reply", cardMessageId: "request" }] };
  const reply = await chatProjectCreationReply(store as never, {} as never, run as never, "company");
  expect(reply).toMatchObject({ message: assistantMessage.content, assistantMessage, userMessage, projectCard,
    activeContext: { contextType: "project", companyId: "company", projectId: "site" },
  });
  expect(reply.message).not.toContain("completed [");
  expect(store.getUserSetting).toHaveBeenCalledWith({}, "chat-project-cards:chat");
});
