import {afterEach,describe,expect,it,vi} from "vitest";
import {cancelChatStream,streamChat} from "../apps/web/src/chat-stream";

afterEach(()=>vi.unstubAllGlobals());

describe("WebChat SSE client",()=>{
  it("ignores invalid JSON, non-text deltas and invalid session/progress payloads", async () => {
    vi.stubGlobal("localStorage",{getItem:()=>null});
    const body = new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('event: delta\ndata: invalid\n\nevent: delta\ndata: {"delta":{}}\n\nevent: code_session\ndata: {}\n\nevent: progress\ndata: {"type":"page_fetch_completed","url":{}}\n\nevent: result\ndata: {"message":"done"}'));c.close();}});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body)));const progress=vi.fn(),delta=vi.fn(),session=vi.fn();
    expect(await streamChat({message:"edit"},progress,{onDelta:delta,onCodeSession:session})).toEqual({message:"done"});
    expect(progress).not.toHaveBeenCalled();expect(delta).not.toHaveBeenCalled();expect(session).not.toHaveBeenCalled();
  });
  it("parses split progress, delta and result frames in order",async()=>{
    vi.stubGlobal("localStorage",{getItem:()=>"token"});
    const encoder=new TextEncoder();
    const pieces=[
      'event: progress\ndata: {"type":"final_generation_started"}\n\nevent: delta\ndata: {"delta":"Hel',
      'lo "}\n\nevent: delta\ndata: {"delta":"world"}\n\nevent: result\ndata: {"message":"Hello world"}\n\n',
    ];
    const body=new ReadableStream<Uint8Array>({start(controller){for(const piece of pieces)controller.enqueue(encoder.encode(piece));controller.close();}});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body,{status:200,headers:{"content-type":"text/event-stream"}})));
    const deltas:string[]=[],progress:string[]=[];

    const result=await streamChat<{message:string}>({message:"Hello",contextType:"none"},event=>progress.push(event.type),{onDelta:delta=>deltas.push(delta)});

    expect(progress).toEqual(["final_generation_started"]);
    expect(deltas).toEqual(["Hello ","world"]);
    expect(result).toEqual({message:"Hello world"});
  });

  it("ignores routing metadata and malformed progress while continuing a coding reply", async () => {
    vi.stubGlobal("localStorage",{getItem:()=>"token"});
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({start(c){c.enqueue(encoder.encode('event: progress\ndata: {"routed":"code_runner","runId":"run"}\n\nevent: progress\ndata: null\n\nevent: progress\ndata: {"type":"project_progress","stage":"build","status":"completed"}\n\nevent: delta\ndata: {"delta":"Updated the button"}\n\nevent: result\ndata: {"message":"Updated the button"}\n\n'));c.close();}});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body)));
    const events: string[] = [], deltas: string[] = [];
    const result = await streamChat<{message:string}>({message:"Make the button green",projectId:"project"}, e => { events.push(e.type); expect(() => e.type.startsWith("final_generation")).not.toThrow(); }, {onDelta: d=>deltas.push(d)});
    expect(events).toEqual(["project_progress"]);expect(deltas).toEqual(["Updated the button"]);expect(result.message).toBe("Updated the button");
  });
  it("ignores an untyped final progress frame without a trailing delimiter", async () => {
    vi.stubGlobal("localStorage",{getItem:()=>null});
    const body = new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('event: result\ndata: {"message":"done"}\n\nevent: progress\ndata: {"routed":"code_runner"}'));c.close();}});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body)));const progress=vi.fn();
    expect(await streamChat({message:"edit"},progress)).toEqual({message:"done"});expect(progress).not.toHaveBeenCalled();
  });
  it("propagates cancellation to the browser fetch",async()=>{
    vi.stubGlobal("localStorage",{getItem:()=>null});
    const fetchMock=vi.fn((_url:string,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener("abort",()=>reject(init.signal?.reason),{once:true})));
    vi.stubGlobal("fetch",fetchMock);
    const controller=new AbortController();
    const pending=streamChat({message:"Stop",contextType:"none"},()=>{},{signal:controller.signal});

    controller.abort(new DOMException("Stopped","AbortError"));

    await expect(pending).rejects.toMatchObject({name:"AbortError"});
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
  });

  it("waits for an authenticated server cancellation acknowledgement",async()=>{
    vi.stubGlobal("localStorage",{getItem:()=>"secret-token"});
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({cancelled:true}),{status:200,headers:{"content-type":"application/json"}}));
    vi.stubGlobal("fetch",fetchMock);

    await expect(cancelChatStream("stream-12345678")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/chat/streams/stream-12345678/cancel",expect.objectContaining({method:"POST",keepalive:true,headers:{authorization:"Bearer secret-token"}}));
  });
});
