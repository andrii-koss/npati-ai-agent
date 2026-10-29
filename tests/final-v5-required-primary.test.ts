import { expect, it, vi } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall, ChatToolDefinition } from "@npati/omniroute-adapter";
import { runChatToolLoop } from "../apps/agent-api/src/chat-tool-orchestrator";

const name = "npati_business_profile";
const tools: ChatToolDefinition[] = [{ type: "function", function: { name, description: "Owned profile action", parameters: { type: "object", properties: {} } } }];
const request: ChatRequest = { model: "test/auto-only", messages: [{ role: "user", content: "Create a Business Profile called Local Bakery" }], toolChoice: { type: "function", function: { name } } };
const call: ChatToolCall = { id: "profile", type: "function", function: { name, arguments: '{"action":"create","profile":{"name":"Local Bakery"}}' } };

it("requires the primary named tool even when a provider silently treats tool_choice as auto", async () => {
  let step = 0;
  const ai = { chat: async () => ++step === 2 ? { content: "", toolCalls: [call] } : { content: "Created and saved." } } as unknown as AIEngine;
  const execute = vi.fn(async () => ({ output: { businessId: "persisted-owned-id" } }));
  const result = await runChatToolLoop({ ai, request, tools: () => tools, execute });
  expect(execute).toHaveBeenCalledExactlyOnceWith(call, { action: "create", profile: { name: "Local Bakery" } });
  expect(result.traces.some(trace => trace.status === "succeeded")).toBe(true);
});

it("rejects unverified success after one reminder without inventing or executing arguments", async () => {
  const chat = vi.fn(async () => ({ content: "Created and saved." }));
  const execute = vi.fn(async () => ({ output: {} }));
  await expect(runChatToolLoop({ ai: { chat } as unknown as AIEngine, request, tools: () => tools, execute })).rejects.toMatchObject({ code: "TOOL_PRIMARY_INCOMPLETE" });
  expect(chat).toHaveBeenCalledTimes(2);
  expect(execute).not.toHaveBeenCalled();
});

it("returns a deferred capability to the caller's deterministic planner after one reminder", async () => {
  const company = "npati_company_action";
  const companyTools: ChatToolDefinition[] = [{ type: "function", function: { name: company, description: "Company action", parameters: { type: "object", properties: {} } } }];
  const chat = vi.fn(async () => ({ content: "Brand tone updated." }));
  const execute = vi.fn(async () => ({ output: {} }));
  const result = await runChatToolLoop({ ai: { chat } as unknown as AIEngine, request: { ...request, toolChoice: { type: "function", function: { name: company } } },
    tools: () => companyTools, deferredTools: [company], execute });
  expect(result.traces).toEqual([]);
  expect(chat).toHaveBeenCalledTimes(2);
  expect(execute).not.toHaveBeenCalled();
});

it("keeps ordinary conversation without a required action to one inference", async () => {
  const chat = vi.fn(async () => ({ content: "A Business Profile describes your business." }));
  const execute = vi.fn(async () => ({ output: {} }));
  const result = await runChatToolLoop({ ai: { chat } as unknown as AIEngine, request: { ...request, toolChoice: "auto" }, tools: () => tools, execute });
  expect(result.result.content).toContain("describes");
  expect(chat).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});
