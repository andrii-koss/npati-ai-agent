import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../AuthContext", () => ({ getStoredAuthToken: () => "test-session" }));
import { watchDevelopmentTrace } from "../chat-development-stream";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("development trace transport", () => {
  it("accepts a real multi-chunk file diff larger than 64 KB and receives the terminal update", async () => {
    const controller = new AbortController();
    const process = {id:"p",companyId:"c",parentConversationId:"parent",name:"NovaShop",framework:"HTML/CSS",createdAt:"",updatedAt:"",hidden:false,status:"failed",
      progress:[{id:"write",stage:"tool",title:"code.fs.write",tool:"code.fs.write",file:"assets/js/app.js",diff:"+line\n".repeat(40_000),at:"",status:"completed"}]};
    const bytes = new TextEncoder().encode("event: change\ndata: " + JSON.stringify({processes:[process]}) + "\n\n");
    const stream = new ReadableStream<Uint8Array>({start(c) { for(let i=0;i<bytes.length;i+=32768)c.enqueue(bytes.slice(i,i+32768));c.close(); }});
    const change = vi.fn(() => controller.abort());
    const fetch = vi.fn().mockResolvedValue(new Response(stream)); vi.stubGlobal("fetch", fetch);
    await watchDevelopmentTrace(controller.signal,change);
    expect(change).toHaveBeenCalledWith([process]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("decodes split SSE frames, uses authenticated headers, and stops on cancellation", async () => {
    const controller = new AbortController(), onChange = vi.fn(() => controller.abort());
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("event: cha")); c.enqueue(new TextEncoder().encode("nge\r\ndata: {}\r\n\r\n")); c.close(); } });
    const fetch = vi.fn().mockResolvedValue(new Response(stream, { status: 200 })); vi.stubGlobal("fetch", fetch);
    await watchDevelopmentTrace(controller.signal, onChange);
    expect(onChange).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0]![1].headers.authorization).toBe("Bearer test-session");
    expect(fetch.mock.calls[0]![0]).not.toContain("test-session");
  });
  it("reconnects after a transport failure and stops retrying when permission is denied", async () => {
    vi.useFakeTimers(); const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetch); const controller = new AbortController();
    const task = watchDevelopmentTrace(controller.signal, vi.fn());
    await vi.advanceTimersByTimeAsync(1000); await task;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it("delivers validated snapshots immediately instead of requiring a duplicate GET",async()=>{
 const controller=new AbortController();const process={id:"p",companyId:"c",parentConversationId:"parent",name:"Site",framework:"Next.js",createdAt:"",updatedAt:"",hidden:false,status:"running"};
 const change=vi.fn(()=>controller.abort());const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('event: change\ndata: '+JSON.stringify({processes:[process]})+'\n\n'));c.close();}});
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body)));await watchDevelopmentTrace(controller.signal,change);expect(change).toHaveBeenCalledWith([process]);
});
it("recovers invalid snapshots via a normal change hint",async()=>{
 const controller=new AbortController();const change=vi.fn(()=>controller.abort());const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('event: change\ndata: {"processes":[{"name":{}}]}\n\n'));c.close();}});
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body)));await watchDevelopmentTrace(controller.signal,change);expect(change).toHaveBeenCalledWith(undefined);
});
