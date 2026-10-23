import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest } from "@npati/omniroute-adapter";
import { CORE_CHAT_TOOLS, runChatToolLoop } from "../apps/agent-api/src/chat-tool-orchestrator";

describe("forced tool choice on a thinking model", () => {
  it("retries the step with auto once and stops forcing it for that model", async () => {
    const choices: unknown[] = [];
    const ai = { chat: async (request: ChatRequest) => {
      choices.push(request.toolChoice);
      if (typeof request.toolChoice === "object") throw new Error("OmniRoute chat failed with HTTP 400: [400]: Thinking mode does not support this tool_choice");
      return { content: "answer" };
    } } as unknown as AIEngine;
    const request = { model: "deepseek/deepseek-flash-test", messages: [{ role: "user" as const, content: "Create company Nova" }], toolChoice: { type: "function" as const, function: { name: "npati_company_action" } } };
    const first = await runChatToolLoop({ ai, request, tools: () => CORE_CHAT_TOOLS, execute: async () => ({ output: {} }) });
    expect(first.result.content).toBe("answer");
    expect(choices).toEqual([request.toolChoice, "auto"]);
    choices.length = 0;
    await runChatToolLoop({ ai, request, tools: () => CORE_CHAT_TOOLS, execute: async () => ({ output: {} }) });
    expect(choices).toEqual(["auto"]);
  });
});

it("preserves a forced web fetch by requesting the existing non-thinking compatibility mode",async()=>{
 const choices:unknown[]=[];let calls=0;
 const ai={chat:async(request:ChatRequest)=>{choices.push(request.toolChoice);calls++;if(calls===1){expect(request.reasoningMode).toBe("disabled");return{content:"",toolCalls:[{id:"fetch-proof",type:"function",function:{name:"web_fetch",arguments:JSON.stringify({url:"https://example.com"})}}]};}return{content:"Fetched proof"};}} as unknown as AIEngine;
 const result=await runChatToolLoop({ai,request:{model:"deepseek/deepseek-flash",messages:[{role:"user",content:"Fetch https://example.com"}],toolChoice:{type:"function",function:{name:"web_fetch"}}},tools:()=>CORE_CHAT_TOOLS,execute:async()=>({output:{title:"Example Domain"}})});
 expect(choices[0]).toEqual({type:"function",function:{name:"web_fetch"}});expect(result.traces.some(x=>x.toolName==="web_fetch"&&x.status==="succeeded")).toBe(true);
});
