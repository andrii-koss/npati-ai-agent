import { afterEach, expect, it, vi } from "vitest";
import { OmniRouteEngine, type ChatRequest } from "@npati/omniroute-adapter";
import { createProductionResilientAIEngine } from "../apps/agent-api/src/production-resilient-ai-engine";
afterEach(()=>vi.restoreAllMocks());
it.each([400,401,429,500,502])("records HTTP %i with duration and retry disposition without the response body",async status=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({error:{message:"token=private"}}),{status}));
  const engine=new OmniRouteEngine({baseUrl:"http://provider.invalid"});
  const events:unknown[]=[];
  await expect(engine.chat({model:"test/model",messages:[{role:"user",content:"private prompt"}],onProviderAttempt:e=>{events.push(e);}})).rejects.toMatchObject({httpStatus:status});
  expect(events).toEqual([expect.objectContaining({phase:"started",model:"test/model"}),expect.objectContaining({phase:"failed",httpStatus:status,retryScheduled:false,durationMs:expect.any(Number)})]);
  expect(JSON.stringify(events)).not.toContain("private");
});
it("records fallback recovery and tolerates a failing observer",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(new Response("Unavailable",{status:502})).mockImplementation(async()=>new Response(JSON.stringify({model:"fallback/model",choices:[{message:{content:"done"},finish_reason:"stop"}]}),{status:200}));
  const events:unknown[]=[];const engine=new OmniRouteEngine({baseUrl:"http://provider.invalid"});
  const input:ChatRequest={model:"first/model",fallbackModel:"fallback/model",messages:[],onProviderAttempt:e=>{events.push(e);}};
  expect((await engine.chat(input)).content).toBe("done");
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({phase:"failed",httpStatus:502,retryScheduled:true}),expect.objectContaining({phase:"completed",model:"fallback/model"})]));
  expect((await engine.chat({...input,onProviderAttempt:()=>{throw Error("logger failed");}})).content).toBe("done");
});
it.each([new TypeError("fetch failed"),new DOMException("Timeout","TimeoutError")])("records a connection or timeout failure",async error=>{
  vi.spyOn(globalThis,"fetch").mockRejectedValue(error);
  const events:unknown[]=[];const engine=new OmniRouteEngine({baseUrl:"http://provider.invalid"});
  await expect(engine.chat({model:"test/model",messages:[],onProviderAttempt:e=>{events.push(e);}})).rejects.toBe(error);
  expect(events.at(-1)).toMatchObject({phase:"failed",errorCode:error.name==="TimeoutError"?"provider_timeout":"provider_connection_error"});
});
it("records a retry chosen by the production resilience wrapper",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(new Response("overload",{status:502})).mockImplementation(async()=>new Response(JSON.stringify({choices:[{message:{content:"recovered"}}]}),{status:200}));
  const engine=createProductionResilientAIEngine(new OmniRouteEngine({baseUrl:"http://provider.invalid"}));
  const events:unknown[]=[];
  expect((await engine.chat({model:"first/model",fallbackModel:"next/model",messages:[],onProviderAttempt:e=>{events.push(e);}})).content).toBe("recovered");
  expect(events).toContainEqual(expect.objectContaining({model:"first/model",phase:"failed",httpStatus:502,retryScheduled:true}));
});
