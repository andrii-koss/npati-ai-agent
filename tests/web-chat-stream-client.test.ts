import {afterEach,describe,expect,it,vi} from "vitest";
import {streamChat} from "../apps/web/src/chat-stream";

afterEach(()=>vi.unstubAllGlobals());

describe("WebChat SSE client",()=>{
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
});
