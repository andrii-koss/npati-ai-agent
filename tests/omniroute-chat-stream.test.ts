import { afterEach, expect, it, vi } from "vitest";
import { OmniRouteEngine, providerContinuationFor } from "@npati/omniroute-adapter";
import { readChatStream } from "../packages/omniroute-adapter/src/chat-stream";
const event = (data:unknown) => "data: " + JSON.stringify(data) + "\r\n\r\n";
function response(text:string) {
 const bytes = new TextEncoder().encode(text);
 return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i++)controller.enqueue(bytes.slice(i,i+1));controller.close();}}),{headers:{"content-type":"text/event-stream"}});
}
afterEach(()=>vi.unstubAllGlobals());
it("decodes fragmented UTF8/CRLF, tool calls, usage and private continuation while reporting safe live counters",async()=>{
 const notices:unknown[]=[];
 const text=event({model:"test/model",choices:[{index:0,delta:{reasoning_content:"private reasoning"}}]})+
 event({choices:[{index:0,delta:{content:"\u041f\u0440\u0438\u0432\u0456\u0442"}}]})+
 event({choices:[{index:0,delta:{tool_calls:[{index:0,id:"call",function:{name:"code_fs_write",arguments:'{"path":"index.html",'}}]}}]})+
 event({choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"content":"secret-value"}'}}]},finish_reason:"tool_calls"}]})+
 event({choices:[],usage:{prompt_tokens:12,completion_tokens:24,total_tokens:36}})+"data: [DONE]\r\n\r\n";
 const payload=await readChatStream(response(text),{messages:[],onGenerationProgress:e=>{notices.push(e)}});
 expect(payload.choices[0].message).toMatchObject({content:"\u041f\u0440\u0438\u0432\u0456\u0442",reasoning_content:"private reasoning",tool_calls:[{id:"call",function:{name:"code_fs_write",arguments:'{"path":"index.html","content":"secret-value"}'}}]});
 expect(payload.usage.total_tokens).toBe(36);
 expect(notices).toEqual(expect.arrayContaining([expect.objectContaining({phase:"response"}),expect.objectContaining({phase:"tool_arguments"})]));
 expect(JSON.stringify(notices)).not.toMatch(/private reasoning|secret-value|index.html/);
});
it("refuses a truncated stream so partial tool arguments never execute",async()=>{
 await expect(readChatStream(response(event({choices:[{delta:{tool_calls:[{index:0,id:"call",function:{name:"write",arguments:'{"path":'}}]}}]})),{messages:[]})).rejects.toThrow("provider_stream_incomplete");
});
it("Step 5: reports assistant prose only, never reasoning or tool-argument fragments",async()=>{
 const deltas:string[]=[];
 const text=event({choices:[{index:0,delta:{reasoning_content:"private reasoning"}}]})+
  event({choices:[{index:0,delta:{content:"Hel"}}]})+
  event({choices:[{index:0,delta:{tool_calls:[{index:0,id:"call",function:{name:"code_fs_write",arguments:'{"path":"secret.html",'}}]}}]})+
  event({choices:[{index:0,delta:{content:"lo"},finish_reason:"tool_calls"}]})+"data: [DONE]\r\n\r\n";
 const payload=await readChatStream(response(text),{messages:[],onTextDelta:(value)=>{deltas.push(value);}});
 expect(deltas.join("")).toBe("Hello");
 expect(deltas.join("")).not.toMatch(/private reasoning|secret\.html|\{"path"/);
 expect(payload.choices[0].message).toMatchObject({content:"Hello"});
});
it("does not convert an upstream stream error into an empty successful answer",async()=>{
 await expect(readChatStream(response(event({error:{message:"provider unavailable"}})),{messages:[]})).rejects.toThrow("provider_stream_error");
});
it("opts into streaming, decodes canonical tool aliases, preserves usage and hides continuation from serialized results",async()=>{
 vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{
  const body=JSON.parse(String(init!.body));expect(body.stream).toBe(true);expect(body.stream_options).toEqual({include_usage:true});
  const name=body.tools[0].function.name;
  return response(event({model:"test/model",choices:[{delta:{reasoning_content:"opaque secret",tool_calls:[{index:0,id:"call",function:{name,arguments:'{"path":"index.html","content":"done"}'}}]},finish_reason:"tool_calls"}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}})+"data: [DONE]\n\n");
 }));
 const result=await new OmniRouteEngine({baseUrl:"http://test"}).chat({model:"test/model",messages:[{role:"user",content:"Create a site"}],tools:[{type:"function",function:{name:"code.fs.write",description:"Write",parameters:{type:"object"}}}],onGenerationProgress:()=>{throw Error("UI unavailable")}});
 expect(result.toolCalls?.[0].function.name).toBe("code.fs.write");expect(result.usage?.totalTokens).toBe(30);
 expect(providerContinuationFor(result)).toEqual({reasoning_content:"opaque secret"});expect(JSON.stringify(result)).not.toContain("opaque secret");
});


it("disables thinking only for the explicitly requested DeepSeek Flash creation path",async()=>{
 const bodies:any[]=[];vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{bodies.push(JSON.parse(String(init!.body)));return new Response(JSON.stringify({choices:[{message:{content:"ok"}}]}));}));
 const engine=new OmniRouteEngine({baseUrl:"http://test"});
 await engine.chat({model:"deepseek/deepseek-flash",messages:[],reasoningMode:"disabled"});
 await engine.chat({model:"deepseek/deepseek-flash",messages:[]});
 await engine.chat({model:"other/model",messages:[],reasoningMode:"disabled"});
 expect(bodies[0].thinking).toEqual({type:"disabled"});expect(bodies[1].thinking).toBeUndefined();expect(bodies[2].thinking).toBeUndefined();
});
