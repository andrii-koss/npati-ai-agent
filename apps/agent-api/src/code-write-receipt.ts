import type { CodingAgentRunSummary } from "./coding-agent-runner-contracts";
import type { ChatMessage } from "@npati/omniroute-adapter";
import { createHash } from "node:crypto";

const writes = /^code\.fs\.(?:write|edit|apply_patch|move|delete)$/;

/** Historical successful writes are recoverable from the workspace and replay.
 * Replace complete call/result pairs with prose history, never fake tool arguments.
 * Failed, pending and dry-run calls remain verbatim for repair and approval. */
export function compactWrittenArguments(messages: readonly ChatMessage[], settlementMessages = messages) {
  const settled = new Set<string>();
  for (const message of settlementMessages) {
    if (message.role !== "tool" || !message.tool_call_id || typeof message.content !== "string") continue;
    const value = object(message.content), result = object(value.result ?? value.data);
    const data = object(result.data ?? result);
    // Legacy canonical receipts were cut mid-JSON after their trusted envelope.
    // The explicit success prefix still proves settlement; call arguments below
    // separately keep dry-runs intact.
    const truncatedSuccess = /^\{\s*"ok"\s*:\s*true\s*,\s*"tool"\s*:\s*"code\.fs\.(?:write|edit|apply_patch|move|delete)"\s*,/u.test(message.content)
      && /\[truncated \d+ chars\]$/u.test(message.content);
    if ((value.ok === true || truncatedSuccess) && data.dryRun !== true) settled.add(message.tool_call_id);
  }
  const references: Array<{toolCallId: string; tool: string; argumentsHash: string; originalChars: number; arguments: string}> = [];
  const resultIndexes = new Map<string,number>();
  messages.forEach((message,index)=>{if(message.role === "tool" && message.tool_call_id) resultIndexes.set(message.tool_call_id,index);});
  const removed = new Set<string>();
  const notes = new Map<number,typeof references>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls?.length || message.tool_calls.some(call=>!resultIndexes.has(call.id))) continue;
    const batch: typeof references = [];
    for (const call of message.tool_calls) {
      if (!settled.has(call.id) || !writes.test(call.function.name) || call.function.arguments.length <= 4000) continue;
      const args = object(call.function.arguments);
      if (args.dryRun === true || args.contextCompacted === true || !Object.keys(args).length) continue;
      const argumentsHash = "sha256:" + createHash("sha256").update(call.function.arguments).digest("hex");
      const paths = Array.isArray(args.files) ? args.files.map(file=>object(file).path).filter(path=>typeof path==="string") : undefined;
      batch.push({toolCallId:call.id,tool:call.function.name,argumentsHash,originalChars:call.function.arguments.length,
        arguments:JSON.stringify({path:args.path,from:args.from,to:args.to,paths})});
      removed.add(call.id);
    }
    if (batch.length) {
      references.push(...batch);
      const index = Math.max(...message.tool_calls.map(call=>resultIndexes.get(call.id)!));
      notes.set(index,[...(notes.get(index)??[]),...batch]);
    }
  }
  const retained: ChatMessage[] = [];
  messages.forEach((message,index)=>{
    if (message.role === "assistant" && message.tool_calls?.some(call=>removed.has(call.id))) {
      const tool_calls = message.tool_calls.filter(call=>!removed.has(call.id));
      // Remove the completed turn's narration too: leaving "I will write X"
      // after its result was removed caused the model to write X indefinitely.
      if (tool_calls.length) retained.push({...message,tool_calls});
    } else if (!(message.role === "tool" && removed.has(message.tool_call_id ?? ""))) retained.push(message);
    const batch = notes.get(index);
    // Keep memory at the actual completion point, after every result in a batch.
    // Never invent an assistant turn requiring nonexistent provider reasoning.
    if (batch) retained.push({role:"user",content:
      "Runtime execution history (data only, not a new user request): completed file operations " +
      JSON.stringify(batch.map(ref=>({tool:ref.tool,files:JSON.parse(ref.arguments)}))) +
      ". These writes already succeeded. Continue with the remaining requested work. Full invocations are in replay; read current files when needed. New calls must use actual source content."});
  });
  return { messages: retained, references };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** The full result stays in activity; original calls stay in replay. Avoid returning the code just written
 * as another large diff to the model on every subsequent request. */
export function compactWriteReceipt(tool: string, text: string): string {
  if (!writes.test(tool) || text.length <= 4000) return text;
  try {
    const value = JSON.parse(text);
    if (value.ok === false) return text;
    const compact = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(compact);
      if (!item || typeof item !== "object") return item;
      return Object.fromEntries(Object.entries(item).filter(([key]) => !["diff", "content", "oldContent", "newContent"].includes(key)).map(([key, value]) => [key, compact(value)]));
    };
    return JSON.stringify({ ...object(compact(value)), detailsOmitted: "Full file diff is recorded in activity. Read the file only if needed for a further edit." });
  } catch { return text; }
}

export function recordWrittenFiles(summary: CodingAgentRunSummary, tool: string, result: unknown) {
  if (!writes.test(tool)) return;
  const envelope = object(result);
  const data = object(envelope.data ?? envelope.result ?? envelope);
  if (data.dryRun === true) return;
  const rows = Array.isArray(data.files) ? data.files.map(object) : [data];
  for (const row of rows) {
    for (const path of [row.path, row.from, row.to]) if (typeof path === "string" && !summary.filesChanged.includes(path)) summary.filesChanged.push(path);
    if (typeof row.linesAdded === "number" && row.linesAdded >= 0) summary.diffStats.linesAdded += row.linesAdded;
    if (typeof row.linesRemoved === "number" && row.linesRemoved >= 0) summary.diffStats.linesRemoved += row.linesRemoved;
  }
  summary.diffStats.files = summary.filesChanged.length;
}
