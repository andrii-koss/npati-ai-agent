import { afterEach, expect, it, vi } from "vitest";
import { OmniRouteEngine, providerContinuationFor } from "@npati/omniroute-adapter";
import { generatedFiles, readChatStream } from "../packages/omniroute-adapter/src/chat-stream";
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
 expect(JSON.stringify(notices)).not.toMatch(/private reasoning|secret-value/);
});
it("reports the checked path and line count of a file still being written, never its text",()=>{
 const call=(name:string,args:string)=>({id:"c",type:"function" as const,function:{name,arguments:args}});
 expect(generatedFiles([call("code_fs_write",'{"path":"src/index.html","content":"a\\nb\\nc')])).toEqual([{path:"src/index.html",lines:3}]);
 expect(generatedFiles([call("code_fs_write",'{"path":"a.css"')])).toEqual([{path:"a.css",lines:0}]);
 expect(generatedFiles([call("code_fs_read",'{"path":"a.css"}')])).toEqual([]);
 expect(generatedFiles([call("code_fs_write",'{"path":"<img src=x>","content":"a"')])).toEqual([]);
 expect(generatedFiles([call("code_fs_write",'{"content":"\\"path\\":\\"fake.txt\\""')])).toEqual([]);
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

/** Emits OmniRoute-style empty keepalive chunks (optionally after some frames) until the reader cancels. */
function keepaliveStream(prefix = "", everyMs = 10) {
 let timer: ReturnType<typeof setInterval> | undefined; const state = { cancelled: false };
 const body = new ReadableStream({
  start(controller) { if (prefix) controller.enqueue(new TextEncoder().encode(prefix)); timer = setInterval(() => controller.enqueue(new TextEncoder().encode(event({id:"chatcmpl-keepalive",model:"keepalive",choices:[{index:0,delta:{},finish_reason:null}]}))), everyMs); },
  cancel() { state.cancelled = true; clearInterval(timer); },
 });
 return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }), state };
}
it("fails a stream that only receives keepalives with a retryable idle timeout and closes it",async()=>{
 const { response: stalled, state } = keepaliveStream(event({choices:[{index:0,delta:{content:"Partial"}}]}));
 const started = Date.now();
 await expect(readChatStream(stalled,{messages:[],streamIdleTimeoutMs:150})).rejects.toThrow(/provider_stream_idle_timeout/);
 expect(Date.now() - started).toBeLessThan(2_000);
 expect(state.cancelled).toBe(true);
});
it("keeps a slow stream whose reasoning and answer keep arriving within the idle window",async()=>{
 const frames = [event({choices:[{index:0,delta:{reasoning_content:"think"}}]}), event({choices:[{index:0,delta:{reasoning_content:" more"}}]}), event({choices:[{index:0,delta:{content:"Done"},finish_reason:"stop"}]}), "data: [DONE]\n\n"];
 const body = new ReadableStream({ async start(controller) { for (const frame of frames) { await new Promise(r => setTimeout(r, 80)); controller.enqueue(new TextEncoder().encode(frame)); } controller.close(); } });
 const payload = await readChatStream(new Response(body,{headers:{"content-type":"text/event-stream"}}),{messages:[],streamIdleTimeoutMs:150});
 expect(payload.choices[0].message.content).toBe("Done");
});
it("moves a text stream to the fallback model when the first model only sends keepalives",async()=>{
 const stalled = keepaliveStream();
 const models: string[] = [];
 vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{ const body=JSON.parse(String(init!.body)); models.push(body.model);
  return body.model === "test/stalled" ? stalled.response : response(event({choices:[{index:0,delta:{content:"Fallback answer"}}]})+"data: [DONE]\n\n"); }));
 const chunks: string[] = [];
 for await (const chunk of new OmniRouteEngine({baseUrl:"http://test"}).stream({model:"test/stalled",fallbackModel:"test/healthy",messages:[{role:"user",content:"hi"}],streamIdleTimeoutMs:150})) chunks.push(chunk);
 expect(chunks.join("")).toBe("Fallback answer");
 expect(models).toEqual(["test/stalled","test/healthy"]);
 expect(stalled.state.cancelled).toBe(true);
});
it("names the HTTP status of an SSE error frame so a cooldown or gateway failure stays retryable",async()=>{
 const { isRetryableInferenceFailure } = await import("../apps/agent-api/src/production-resilient-ai-engine");
 const cooldown = readChatStream(response(event({error:{message:"All credentials for model m are cooling down",type:"rate_limit_error",code:"model_cooldown"}})),{messages:[]});
 await expect(cooldown).rejects.toThrow(/provider_stream_error: OmniRoute stream failed with HTTP 429/);
 const gateway = await readChatStream(response(event({error:{message:"[node/m] [502]: bad gateway (reset after 1s)"}})),{messages:[]}).catch(error=>error as Error);
 expect(String(gateway.message)).toMatch(/HTTP 502/);
 expect(isRetryableInferenceFailure(gateway)).toBe(true);
});
it("falls back to the next model when a streamed request ends in an SSE error frame",async()=>{
 const { createProductionResilientAIEngine } = await import("../apps/agent-api/src/production-resilient-ai-engine");
 const models: string[] = [];
 vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{ const body=JSON.parse(String(init!.body)); models.push(body.model);
  return body.model === "test/cooling" ? response(event({error:{message:"All credentials for model test/cooling are cooling down",type:"rate_limit_error",code:"model_cooldown"}}))
   : response(event({model:body.model,choices:[{index:0,delta:{content:"Fallback answer"},finish_reason:"stop"}]})+"data: [DONE]\n\n"); }));
 const engine = createProductionResilientAIEngine(new OmniRouteEngine({baseUrl:"http://test"}));
 const chunks: string[] = [];
 for await (const chunk of engine.stream({model:"test/cooling",fallbackModel:"test/healthy",messages:[{role:"user",content:"hi"}]})) chunks.push(chunk);
 expect(chunks.join("")).toBe("Fallback answer");
 const streamed = await engine.chat({model:"test/cooling",fallbackModel:"test/healthy",messages:[{role:"user",content:"hi"}],onGenerationProgress:()=>undefined});
 expect(streamed.content).toBe("Fallback answer");
 expect(models).toEqual(["test/cooling","test/healthy","test/cooling","test/healthy"]);
});
it("treats a status-less SSE error frame (deactivated credentials) as a retryable provider failure",async()=>{
 const { isRetryableInferenceFailure } = await import("../apps/agent-api/src/production-resilient-ai-engine");
 const error = await readChatStream(response(event({error:{message:"No active credentials for provider: node-1."}})),{messages:[]}).catch(e=>e as Error);
 expect(String(error.message)).toMatch(/^provider_stream_error: OmniRoute stream failed: No active credentials/);
 expect(isRetryableInferenceFailure(error)).toBe(true);
});
