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
  localStorage.setItem("npati_agent_access_token", "first"); const first = chatOpen("same");
  localStorage.setItem("npati_agent_access_token", "second");
  expect(sharedChatOpen("same")).toBeNull(); expect(chatOpen("same")).not.toBe(first); expect(fetch).toHaveBeenCalledTimes(2);
});
