import { expect, it } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall, ChatToolDefinition } from "@npati/omniroute-adapter";
import { runChatToolLoop } from "../apps/agent-api/src/chat-tool-orchestrator";

const tool = (name: string): ChatToolDefinition => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } });
const tools = [tool("npati_goal_action"), tool("npati_workspace_action")];
const call = (id: string, name: string): ChatToolCall => ({ id, type: "function", function: { name, arguments: "{}" } });
const request = { model: "test/model", messages: [{ role: "user" as const, content: "Add a goal and remember the opening date" }] };

it("reminds the model once about an additional semantic capability it stopped without trying", async () => {
  const seen: ChatRequest["messages"][] = [];
  const ai = { chat: async (req: ChatRequest) => {
    seen.push(req.messages);
    if (seen.length === 1) return { content: "", toolCalls: [call("goal", "npati_goal_action")] };
    // The model claims the memory write is unavailable instead of calling the offered tool.
    if (seen.length === 2) return { content: "Memory writes are not available here." };
    if (seen.length === 3) return { content: "", toolCalls: [call("memory", "npati_workspace_action")] };
    return { content: "Goal added and opening date remembered." };
  } } as unknown as AIEngine;
  const executed: string[] = [];
  const result = await runChatToolLoop({ ai, request, tools: () => tools, requiredTools: ["npati_workspace_action"],
    execute: async (toolCall) => { executed.push(toolCall.function.name); return { output: { ok: true } }; } });
  expect(executed).toEqual(["npati_goal_action", "npati_workspace_action"]);
  expect(String(seen[2]!.at(-1)!.content)).toContain("npati_workspace_action");
  expect(result.result.content).toBe("Goal added and opening date remembered.");
});

it("does not force a retry of an attempted capability or remind more than once", async () => {
  let steps = 0;
  const ai = { chat: async () => (++steps === 1 ? { content: "", toolCalls: [call("memory", "npati_workspace_action")] } : { content: "The memory write failed: quota." }) } as unknown as AIEngine;
  const result = await runChatToolLoop({ ai, request, tools: () => tools, requiredTools: ["npati_workspace_action"],
    execute: async () => { throw new Error("quota"); } });
  expect(steps).toBe(2);
  expect(result.result.content).toBe("The memory write failed: quota.");

  let silent = 0;
  const stubborn = { chat: async () => { silent += 1; return { content: "No." }; } } as unknown as AIEngine;
  await runChatToolLoop({ ai: stubborn, request, tools: () => tools, requiredTools: ["npati_workspace_action"], execute: async () => ({ output: {} }) });
  expect(silent).toBe(2);
});

it("ignores a required capability that is not offered", async () => {
  let steps = 0;
  const ai = { chat: async () => { steps += 1; return { content: "Answer" }; } } as unknown as AIEngine;
  await runChatToolLoop({ ai, request, tools: () => [tools[0]!], requiredTools: ["npati_email_action"], execute: async () => ({ output: {} }) });
  expect(steps).toBe(1);
});
