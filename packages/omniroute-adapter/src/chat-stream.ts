import type { ChatRequest, ChatToolCall } from "./types";
import { PROVIDER_STREAM_IDLE_TIMEOUT_MS, readBeforeIdle, streamErrorMessage } from "./omniroute-engine-helpers";

const SAFE_PROGRESS_PATH = /^[\p{L}\p{N}_@.()\/ -]{1,200}$/u;

/** Files a streaming write call is producing: only the checked path and a line count, never the partial arguments. */
export function generatedFiles(calls: Iterable<ChatToolCall>): {path:string;lines:number}[] {
  const files: {path:string;lines:number}[] = [];
  for (const call of calls) {
    if (!/fs[._]write/.test(call.function.name)) continue;
    const args = call.function.arguments, content = args.indexOf('"content"');
    const path = (content >= 0 ? args.slice(0, content) : args.slice(0, 2_000)).match(/"path"\s*:\s*"([^"\\]+)"/)?.[1];
    if (path && SAFE_PROGRESS_PATH.test(path)) files.push({path, lines: content < 0 ? 0 : (args.slice(content).match(/\\n/g)?.length ?? 0) + 1});
  }
  return files;
}

/** Assemble complete calls before execution; progress exposes counters and file paths only, never provider text. */
export async function readChatStream(response: Response, request: ChatRequest, started = Date.now()) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response.json();
  if (!response.body) throw new Error("provider_stream_missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const message = { content: "", reasoning_content: "", reasoning_text: "", tool_calls: [] as ChatToolCall[] };
  const calls = new Map<number, ChatToolCall>();
  let pending = "", bytes = 0, completed = false, finishReason: string | undefined;
  let model: string | undefined, usage: Record<string, unknown> | undefined;
  let firstTokenMs: number | undefined, outputCharacters = 0, lastNotice = 0, lastPhase = "";
  let lastProgressAt = Date.now();
  const idleMs = request.streamIdleTimeoutMs ?? PROVIDER_STREAM_IDLE_TIMEOUT_MS;
  const consume = async (frame: string) => {
    const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data.trim() === "[DONE]") { completed = true; return; }
    const payload = JSON.parse(data);
    if (payload.error) throw new Error(streamErrorMessage(payload.error));
    model = payload.model ?? model;
    usage = payload.usage ?? usage;
    const choice = payload.choices?.find((item: {index?: number}) => !item.index);
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    for (const key of ["content", "reasoning_content", "reasoning_text"] as const) {
      if (typeof delta[key] === "string") message[key] += delta[key];
    }
    /**
     * Step 5: forward only the assistant's answer text. Reasoning and tool arguments are deliberately excluded: the
     * former is internal, the latter is partial JSON that must never reach a client. The listener is isolated so a
     * broken consumer cannot interrupt inference.
     */
    if (typeof delta.content === "string" && delta.content.length > 0 && request.onTextDelta) {
      try { request.onTextDelta(delta.content); } catch { /* Presentation cannot interrupt inference. */ }
    }
    let toolCharacters = 0;
    for (const part of delta.tool_calls ?? []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index > 200) throw new Error("provider_stream_invalid_call");
      const call = calls.get(part.index) ?? {id:"", type:"function" as const, function:{name:"", arguments:""}};
      if (part.id) call.id = part.id;
      if (typeof part.function?.name === "string") call.function.name += part.function.name;
      if (typeof part.function?.arguments === "string") { call.function.arguments += part.function.arguments; toolCharacters += part.function.arguments.length; }
      calls.set(part.index, call);
    }
    const meaningful = toolCharacters || delta.content?.length || delta.reasoning_content?.length || delta.reasoning_text?.length;
    if (!meaningful) return;
    lastProgressAt = Date.now();
    firstTokenMs ??= Date.now() - started;
    outputCharacters += toolCharacters + (typeof delta.content === "string" ? delta.content.length : 0);
    const phase = toolCharacters || lastPhase === "tool_arguments" ? "tool_arguments" : "response";
    const now = Date.now();
    if (!lastNotice || phase !== lastPhase || now - lastNotice >= 1000) {
      lastNotice = now; lastPhase = phase;
      try { await request.onGenerationProgress?.({phase, firstTokenMs, outputCharacters, files: generatedFiles(calls.values())}); } catch { /* Presentation cannot interrupt inference. */ }
    }
  };
  try {
    while (!completed) {
      const chunk = await readBeforeIdle(reader, lastProgressAt, idleMs);
      if (chunk.done) { pending += decoder.decode(); break; }
      bytes += chunk.value.byteLength;
      if (bytes > 32 * 1024 * 1024) throw new Error("provider_stream_too_large");
      pending = (pending + decoder.decode(chunk.value, {stream:true})).replace(/\r\n/g,"\n");
      let separator: number;
      while ((separator = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, separator); pending = pending.slice(separator + 2);
        await consume(frame);
        if (completed) break;
      }
    }
    if (pending.trim() && !completed) await consume(pending);
    if (!completed && !finishReason) throw new Error("provider_stream_incomplete");
    message.tool_calls = [...calls.entries()].sort(([a],[b])=>a-b).map(([,call])=>call);
    if (message.tool_calls.some(call => !call.id || !call.function.name)) throw new Error("provider_stream_invalid_call");
    const assembled = {content:message.content,tool_calls:message.tool_calls,...(message.reasoning_content ? {reasoning_content:message.reasoning_content} : {}),...(message.reasoning_text ? {reasoning_text:message.reasoning_text} : {})};
    return {model, usage, choices:[{message:assembled, finish_reason:finishReason}]};
  } finally {
    await reader.cancel().catch(()=>undefined);
    reader.releaseLock();
  }
}
