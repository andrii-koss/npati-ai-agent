import { expect, it, vi } from "vitest";
import type { ChatMessage } from "@npati/omniroute-adapter";
import { compactConversationContextIfNeeded, type CompactContextArgs } from "../apps/agent-api/src/coding-agent-context-compactor";
import { resolveCodeAgentLimits } from "../apps/agent-api/src/code-agent-config";

it("compacts recent successful write arguments through the runner boundary without losing the user's specification", async () => {
  const originalArguments = JSON.stringify({path:"catalog.html",content:"<p>Product</p>".repeat(12000)});
  const goal = "Create all thirteen pages, filters, checkout and local storage";
  const messages: ChatMessage[] = [
    {role:"system",content:"Build the requested site"},
    {role:"user",content:goal},
    {role:"assistant",content:"Creating catalog",tool_calls:[{id:"write-1",type:"function",function:{name:"code.fs.write",arguments:originalArguments}}]},
    {role:"tool",tool_call_id:"write-1",content:JSON.stringify({ok:true,result:{data:{path:"catalog.html",revision:"r1"}}})},
  ];
  const artifacts: Record<string,unknown>[] = [];
  const record = vi.fn(async () => {});
  const guard = vi.fn(async () => {});
  const args = {ports:{providerDataGuard:{guardProviderBoundText:guard}},
    limits:resolveCodeAgentLimits({}),input:{model:"test"},session:{dataClassification:"internal",retentionClass:"standard"},
    companyId:"company",projectId:"project",sessionId:"session",snapshotId:"snapshot",steps:2,
    systemPrompt:"Build the requested site",definitions:[],messages,profile:{contextWindow:128000},
    estimatedTokensPerCall:1000,compressionArtifacts:artifacts,record} as unknown as CompactContextArgs;
  const result = await compactConversationContextIfNeeded(args);
  expect(result.compacted).toBe(true);
  expect(messages.find(message=>message.role==="user")?.content).toBe(goal);
  expect(messages.flatMap(message=>message.tool_calls??[])).toEqual([]);
  expect(messages.filter(message=>message.role==="tool")).toEqual([]);
  expect(JSON.stringify(messages)).toContain("catalog.html");
  expect(JSON.stringify(messages)).not.toContain("contextCompacted");
  expect(JSON.stringify(messages)).not.toContain("argumentsHash");
  expect(messages.find(message=>String(message.content).startsWith("Runtime execution history"))?.role).toBe("user");
  expect(messages.filter(message=>message.role==="assistant")).toEqual([]);
  expect(messages.at(-1)?.content).toContain("These writes already succeeded");
  expect(JSON.stringify(messages).length).toBeLessThan(originalArguments.length / 10);
  expect(artifacts[0]).toMatchObject({prunedToolArguments:[{toolCallId:"write-1",originalChars:originalArguments.length}],modelRequestHash:expect.stringMatching(/^sha256:/)});
  expect(guard).toHaveBeenCalledOnce();
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ok:true,errorCode:"context_compacted"}));
});
