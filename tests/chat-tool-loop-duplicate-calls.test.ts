import { expect, it } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall } from "@npati/omniroute-adapter";
import { CORE_CHAT_TOOLS, runChatToolLoop } from "../apps/agent-api/src/chat-tool-orchestrator";

const call = (id: string, args: Record<string, unknown>): ChatToolCall => ({ id, type: "function", function: { name: "npati_company_action", arguments: JSON.stringify(args) } });

it("executes a call repeated within one assistant turn once and answers every call id", async () => {
  const replies: ChatRequest["messages"][] = [];
  let step = 0;
  const ai = { chat: async (request: ChatRequest) => {
    replies.push(request.messages);
    // The provider repeats the create with a new id and reordered keys, plus one genuinely different call.
    if (step++ === 0) return { content: "", toolCalls: [
      call("call-a", { action: "create", fields: { name: "Nova", industry: "Retail" } }),
      call("call-b", { fields: { industry: "Retail", name: "Nova" }, action: "create" }),
      call("call-c", { action: "create", fields: { name: "Orbit" } }),
    ] };
    return { content: "Created" };
  } } as unknown as AIEngine;
  const executed: string[] = [];
  const result = await runChatToolLoop({ ai, request: { model: "test/model", messages: [{ role: "user", content: "Create companies Nova and Orbit" }] }, tools: () => CORE_CHAT_TOOLS,
    execute: async (toolCall, args) => { executed.push(toolCall.id); return { output: { companyId: "id-" + String((args.fields as { name: string }).name) } }; } });
  expect(executed).toEqual(["call-a", "call-c"]);
  expect(result.traces.find(trace => trace.callId === "call-b")).toMatchObject({ status: "deduplicated", duplicateOf: "call-a" });
  expect(result.traces.filter(trace => trace.status === "requested")).toHaveLength(2);
  // The provider still receives one tool result per call id; the repeat reuses the first output.
  const toolMessages = replies[1]!.filter(message => message.role === "tool");
  expect(toolMessages.map(message => message.tool_call_id)).toEqual(["call-a", "call-b", "call-c"]);
  expect(toolMessages[1]!.content).toBe(toolMessages[0]!.content);
  expect(result.result.content).toBe("Created");
});

it("still runs the same call again in a later step when the model asks for it", async () => {
  let step = 0;
  const ai = { chat: async () => step++ < 2 ? { content: "", toolCalls: [call(`call-${step}`, { action: "update", companyName: "Nova", fields: { status: "active" } })] } : { content: "ok" } } as unknown as AIEngine;
  const executed: string[] = [];
  await runChatToolLoop({ ai, request: { model: "test/model", messages: [{ role: "user", content: "Activate Nova" }] }, tools: () => CORE_CHAT_TOOLS, execute: async (toolCall) => { executed.push(toolCall.id); return { output: {} }; } });
  expect(executed).toEqual(["call-1", "call-2"]);
});

it("streams every tool-loop step so the stream idle timeout bounds a silent provider", async () => {
  const streamed: boolean[] = [];
  let step = 0;
  const ai = { chat: async (request: ChatRequest) => { streamed.push(typeof request.onGenerationProgress === "function");
    return step++ === 0 ? { content: "", toolCalls: [call("call-1", { action: "create", fields: { name: "Nova" } })] } : { content: "done" }; } } as unknown as AIEngine;
  await runChatToolLoop({ ai, request: { model: "test/model", messages: [{ role: "user", content: "Create Nova" }] }, tools: () => CORE_CHAT_TOOLS, execute: async () => ({ output: {} }) });
  expect(streamed).toEqual([true, true]);
});
