// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { streamChat } from "../chat-stream";

afterEach(() => vi.unstubAllGlobals());
const sse = (blocks: string[]) => new Response(new ReadableStream({ start(controller) { for (const block of blocks) controller.enqueue(new TextEncoder().encode(block)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });

it("reports the new conversation before the reply and keeps it out of the progress list", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => sse([
    'event: progress\ndata: {"type":"conversation_started","conversationId":"11111111-1111-4111-8111-111111111111"}\n\n',
    'event: progress\ndata: {"type":"final_generation_started","timestamp":"2026-11-11T00:00:00Z"}\n\n',
    'event: delta\ndata: {"delta":"Так."}\n\n',
    'event: result\ndata: {"message":"Так.","conversationId":"11111111-1111-4111-8111-111111111111"}\n\n',
  ])));
  const onConversation = vi.fn(); const onProgress = vi.fn();
  const result = await streamChat<{ message: string }>({ message: "hi" }, onProgress, { onConversation });
  expect(result.message).toBe("Так.");
  expect(onConversation).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  expect(onProgress.mock.calls.map(([event]) => event.type)).toEqual(["final_generation_started"]);
});
