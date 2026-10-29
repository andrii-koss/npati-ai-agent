import { retainProviderContinuation } from "@npati/omniroute-adapter";
import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest } from "@npati/omniroute-adapter";
import { CORE_CHAT_TOOLS, runChatToolLoop } from "../apps/agent-api/src/chat-tool-orchestrator";

describe("forced tool choice on a thinking model", () => {
  it("retries the step with auto once and stops forcing it for that model", async () => {
    const choices: unknown[] = [];
    const ai = { chat: async (request: ChatRequest) => {
      choices.push(request.toolChoice);
      if (typeof request.toolChoice === "object") throw new Error("OmniRoute chat failed with HTTP 400: [400]: Thinking mode does not support this tool_choice");
      if (!request.messages.some(message => message.role === "tool")) return { content: "", toolCalls: [{ id: "create", type: "function", function: { name: "npati_company_action", arguments: "{}" } }] };
      return { content: "answer" };
    } } as unknown as AIEngine;
    const request = { model: "deepseek/deepseek-flash-test", messages: [{ role: "user" as const, content: "Create company Nova" }], toolChoice: { type: "function" as const, function: { name: "npati_company_action" } } };
    const first = await runChatToolLoop({ ai, request, tools: () => CORE_CHAT_TOOLS, execute: async () => ({ output: {} }) });
    expect(first.result.content).toBe("answer");
    expect(choices).toEqual([request.toolChoice, "auto", "auto"]);
    choices.length = 0;
    await runChatToolLoop({ ai, request, tools: () => CORE_CHAT_TOOLS, execute: async () => ({ output: {} }) });
    expect(choices).toEqual(["auto", "auto"]);
  });
});

it("preserves a forced web fetch by requesting the existing non-thinking compatibility mode",async()=>{
 const choices:unknown[]=[];let calls=0;
 const ai={chat:async(request:ChatRequest)=>{choices.push(request.toolChoice);calls++;if(calls===1){expect(request.reasoningMode).toBe("disabled");return{content:"",toolCalls:[{id:"fetch-proof",type:"function",function:{name:"web_fetch",arguments:JSON.stringify({url:"https://example.com"})}}]};}expect(request.reasoningMode).toBe("disabled");return{content:"Fetched proof"};}} as unknown as AIEngine;
 const result=await runChatToolLoop({ai,request:{model:"deepseek/deepseek-flash",messages:[{role:"user",content:"Fetch https://example.com"}],toolChoice:{type:"function",function:{name:"web_fetch"}}},tools:()=>CORE_CHAT_TOOLS,execute:async()=>({output:{title:"Example Domain"}})});
 expect(choices[0]).toEqual({type:"function",function:{name:"web_fetch"}});expect(result.traces.some(x=>x.toolName==="web_fetch"&&x.status==="succeeded")).toBe(true);
});


it("returns provider continuation state only to the next inference in an automatic tool loop", async () => {
  let count = 0;
  const ai = { chat: async (request: ChatRequest) => {
    count++;
    if (count === 1) return retainProviderContinuation({ content: "", toolCalls: [{ id: "continuation-fetch", type: "function" as const, function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://example.com" }) } }] }, { reasoning_text: "PRIVATE_PROVIDER_CONTINUATION" });
    expect(request.messages.find(message => message.role === "assistant" && message.tool_calls)?.reasoning_text).toBe("PRIVATE_PROVIDER_CONTINUATION");
    return { content: "Grounded answer" };
  } } as unknown as AIEngine;
  const result = await runChatToolLoop({ ai, request: { model: "deepseek/deepseek-flash", messages: [{ role: "user", content: "Review the source" }], toolChoice: "auto" }, tools: () => CORE_CHAT_TOOLS, execute: async () => ({ output: { evidence: "Example Domain" } }) });
  expect(count).toBe(2);
  expect(result.result.content).toBe("Grounded answer");
  expect(JSON.stringify({ result: result.result, traces: result.traces, metadata: result.metadata })).not.toContain("PRIVATE_PROVIDER_CONTINUATION");
});
