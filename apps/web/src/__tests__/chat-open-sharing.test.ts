// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { chatOpen, sharedChatOpen, forgetChatOpen } from "../chat-open";
afterEach(() => { forgetChatOpen(); localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("shares a slow pending open beyond five seconds and starts its TTL after completion", async () => {
  let now = 0, finish!: (response: Response) => void;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetch);
  const first = chatOpen("slow"); now = 6000;
  expect(sharedChatOpen("slow")).toBe(first); expect(chatOpen("slow")).toBe(first); expect(fetch).toHaveBeenCalledTimes(1);
  finish(new Response(JSON.stringify({ conversation: null }))); await first;
  now = 10000; expect(sharedChatOpen("slow")).toBe(first);
  now = 11001; expect(sharedChatOpen("slow")).toBeNull();
});
it("never reuses another authentication token's pending response", async () => {
  const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
  localStorage.setItem("npati_agent_session_marker", "npati-cookie-session:first"); const first = chatOpen("same");
  localStorage.setItem("npati_agent_session_marker", "npati-cookie-session:second");
  expect(sharedChatOpen("same")).toBeNull(); expect(chatOpen("same")).not.toBe(first); expect(fetch).toHaveBeenCalledTimes(2);
});

it("makes messages available while the same response is still delivering development history", async () => {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(stream) { controller = stream; } });
  const fetch = vi.fn(async () => new Response(body, { headers: { "content-type": "application/x-ndjson" } }));
  vi.stubGlobal("fetch", fetch);
  const opened = chatOpen("chat");
  controller.enqueue(encoder.encode(JSON.stringify({ conversation: { id: "chat", messages: [{ content: "Ready now" }] }, processes: [], processesPending: true }) + "\n"));
  const data = await opened;
  expect(data.conversation?.messages[0]?.content).toBe("Ready now");
  expect(sharedChatOpen("chat")).toBe(opened);
  expect(fetch).toHaveBeenCalledTimes(1);
  const next = JSON.stringify({ processes: [{ id: "development" }] }) + "\n";
  controller.enqueue(encoder.encode(next.slice(0, 10)));
  controller.enqueue(encoder.encode(next.slice(10)));
  controller.close();
  await expect(data.pendingProcesses).resolves.toEqual({ processes: [{ id: "development" }] });
});
