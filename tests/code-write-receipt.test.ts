import { describe, expect, it } from "vitest";
import { compactWriteReceipt, recordWrittenFiles, compactWrittenArguments } from "../apps/agent-api/src/code-write-receipt";
import type { ChatMessage } from "@npati/omniroute-adapter";
import type { CodingAgentRunSummary } from "../apps/agent-api/src/coding-agent-runner-contracts";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";
import { validateArguments } from "../apps/agent-api/src/code-tool-runtime";

describe("write receipts and factual file counts", () => {
  it("removes both sides of a settled write from a mixed batch, preserving other call/result pairs", () => {
    const messages: ChatMessage[] = [
      {role:"system",content:"Build the requested website"}, {role:"user",content:"Create a store"},
      {role:"assistant",content:"",tool_calls:[
        {id:"write",type:"function",function:{name:"code.fs.write",arguments:JSON.stringify({path:"index.html",content:"<p>Item</p>".repeat(1000)})}},
        {id:"read",type:"function",function:{name:"code.fs.read",arguments:JSON.stringify({path:"app.js"})}},
      ]},
      {role:"tool",tool_call_id:"write",content:JSON.stringify({ok:true,result:{data:{path:"index.html"}}})},
      {role:"tool",tool_call_id:"read",content:"existing JavaScript"},
    ];
    const result=compactWrittenArguments(messages);
    expect(result.messages.flatMap(message=>message.tool_calls??[]).map(call=>call.id)).toEqual(["read"]);
    expect(result.messages.filter(message=>message.role==="tool").map(message=>message.tool_call_id)).toEqual(["read"]);
    expect(result.messages.find(message=>message.role==="assistant"&&message.tool_calls)?.tool_calls?.[0]?.function.arguments).toBe('{"path":"app.js"}');
    expect(result.messages.find(message=>message.role==="user"&&String(message.content).startsWith("Runtime execution history"))?.content).toContain("index.html");
    expect(result.messages.at(-1)?.content).toContain("These writes already succeeded");
    expect(result.messages.map(message=>JSON.stringify(message.tool_calls??[])).join()).not.toContain("contextCompacted");
    for(const message of result.messages) for(const call of message.tool_calls??[]) {
      const schema=CODE_TOOL_SCHEMAS.find(tool=>tool.name===call.function.name)!;
      expect(()=>validateArguments(schema.inputSchema,JSON.parse(call.function.arguments))).not.toThrow();
    }
    expect(messages[2]!.tool_calls).toHaveLength(2);
  });
  it("elides only successful historical write bodies, preserving original calls in the journal input", () => {
    const body = "const source = 1;\n".repeat(5000);
    const call = (id:string,dryRun=false) => ({id,type:"function" as const,function:{name:"code.fs.write",arguments:JSON.stringify({path:id+".js",content:body,dryRun})}});
    const messages: ChatMessage[] = [
      {role:"user",content:"Implement all thirteen store pages"},
      {role:"assistant",content:"Writing files",tool_calls:[call("ok"),call("failed"),call("dry",true),call("legacy")]},
      {role:"tool",tool_call_id:"ok",content:JSON.stringify({ok:true,result:{data:{path:"ok.js"}}})},
      {role:"tool",tool_call_id:"failed",content:JSON.stringify({ok:false,error:{code:"revision_conflict"}})},
      {role:"tool",tool_call_id:"dry",content:JSON.stringify({ok:true,result:{data:{dryRun:true}}})},
      {role:"tool",tool_call_id:"legacy",content:'{"ok":true,"tool":"code.fs.write","result":{"diff":"partial\n…[truncated 9000 chars]'},
      {role:"assistant",content:"Pending write",tool_calls:[call("pending")]},
    ];
    const result=compactWrittenArguments(messages);
    expect(result.references.map(ref=>ref.toolCallId)).toEqual(["ok","legacy"]);
    const compacted=result.messages.find(message=>message.tool_calls)!.tool_calls!;
    expect(compacted.map(call=>call.id)).toEqual(["failed","dry"]);
    for(const [after,before] of [[0,1],[1,2]])expect(compacted[after!]!.function.arguments).toBe(messages[1]!.tool_calls![before!]!.function.arguments);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(JSON.parse(messages[1]!.tool_calls![0]!.function.arguments).content === body).toBe(true);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages.filter(message=>message.role==="tool").map(message=>message.tool_call_id)).toEqual(["failed","dry"]);
    expect(result.references[0]).toMatchObject({toolCallId:"ok",argumentsHash:expect.stringMatching(/^sha256:/)});
    expect(JSON.stringify(compactWrittenArguments(result.messages).messages)).toBe(JSON.stringify(result.messages));
  });
  it("keeps write metadata without repeating a large diff in subsequent model context", () => {
    const text = JSON.stringify({ok:true,result:{data:{path:"assets/js/app.js",revision:"r1",linesAdded:200,linesRemoved:3,diff:"+source code\n".repeat(10_000)}}});
    const receipt = compactWriteReceipt("code.fs.write",text);
    expect(receipt.length).toBeLessThan(500);
    expect(JSON.parse(receipt)).toMatchObject({ok:true,result:{data:{path:"assets/js/app.js",revision:"r1",linesAdded:200,linesRemoved:3}}});
    expect(text).toContain("+source code");
    expect(receipt).not.toContain("+source code");
    expect(compactWriteReceipt("code.fs.read",text)).toBe(text);
    const failed = JSON.stringify({ok:false,error:{diff:"x".repeat(5000)}});
    expect(compactWriteReceipt("code.fs.edit",failed)).toBe(failed);
  });
  it("counts actual writes, edits and patches once per file, ignoring read and dry-run results", () => {
    const summary = {filesChanged:[],diffStats:{files:0,linesAdded:0,linesRemoved:0}} as unknown as CodingAgentRunSummary;
    recordWrittenFiles(summary,"code.fs.write",{data:{path:"index.html",linesAdded:20,linesRemoved:0}});
    recordWrittenFiles(summary,"code.fs.edit",{data:{path:"index.html",linesAdded:2,linesRemoved:1}});
    recordWrittenFiles(summary,"code.fs.apply_patch",{data:{files:[{path:"cart.html",linesAdded:10,linesRemoved:0}]}});
    recordWrittenFiles(summary,"code.fs.read",{path:"read.html"});
    recordWrittenFiles(summary,"code.fs.write",{dryRun:true,path:"never.html",linesAdded:90});
    expect(summary.filesChanged).toEqual(["index.html","cart.html"]);
    expect(summary.diffStats).toEqual({files:2,linesAdded:32,linesRemoved:1});
  });
});
