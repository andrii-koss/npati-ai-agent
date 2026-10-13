import type { ChatMessage, ChatToolCall, ModelInfo } from "./types";

export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function mcpJson(text: string) {
  const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  const source = data || text;
  return JSON.parse(source) as { result?: { content?: Array<{ type?: string; text?: string }> }; error?: { message?: string } };
}

export function requiresResponsesApi(model?: ModelInfo) {
  const format = model?.apiFormat?.toLowerCase();
  if (format === "responses" || format === "openai-responses") return true;
  if (format === "chat-completions") return false;
  const endpoints = model?.supportedEndpoints ?? [];
  return endpoints.some((endpoint) => /responses/i.test(endpoint)) && !endpoints.some((endpoint) => /chat/i.test(endpoint));
}

export function responsesText(payload: {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
}) {
  if (typeof payload.output_text === "string") return payload.output_text;
  return payload.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("") ?? "";
}

export function responseInputMessage(message: ChatMessage): unknown {
  if (message.role === "tool") {
    return { type: "function_call_output", call_id: message.tool_call_id, output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") };
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    return [
      ...(message.content ? [{ role: "assistant", content: message.content }] : []),
      ...message.tool_calls.map((call) => ({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments })),
    ];
  }
  const content = Array.isArray(message.content)
    ? message.content.map((part) => part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_image", image_url: part.image_url.url, detail: part.image_url.detail ?? "auto" })
    : message.content ?? "";
  return { role: message.role, content };
}

export function responseToolCalls(payload: { output?: Array<Record<string, unknown>> }): ChatToolCall[] {
  return (payload.output ?? []).flatMap((item) => item.type === "function_call" && typeof item.name === "string"
    ? [{ id: String(item.call_id ?? item.id ?? crypto.randomUUID()), type: "function" as const, function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) } }]
    : []);
}

export function* boundedTextChunks(value: string, maxCharacters = 2_048) {
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + maxCharacters);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end -= 1;
    if (end <= offset) end = Math.min(value.length, offset + maxCharacters + 1);
    yield value.slice(offset, end);
    offset = end;
  }
}

export function numericHeader(headers: Headers, ...names: string[]) {
  for (const name of names) {
    const value = headers.get(name);
    if (value != null && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function textHeader(headers: Headers, ...names: string[]) {
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

export function chatUsage(payload: Record<string, unknown>) {
  const usage = (payload.usage ?? payload.usageMetadata) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return undefined;
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? 0);
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokenCount ?? promptTokens + completionTokens);
  const promptTokensDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const inputTokensDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  const cachedTokens = Number(usage.cached_tokens ?? promptTokensDetails?.cached_tokens ?? inputTokensDetails?.cached_tokens ?? 0);
  if (![promptTokens, completionTokens, totalTokens, cachedTokens].every(Number.isFinite)) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
  };
}

export function matchesAscii(data: Uint8Array, offset: number, value: string) {
  if (offset < 0 || offset + value.length > data.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

export function containsAscii(data: Uint8Array, value: string) {
  for (let offset = 0; offset <= data.length - value.length; offset += 1) {
    if (matchesAscii(data, offset, value)) return true;
  }
  return false;
}

/**
 * Some mobile/audio tools write AAC into an ISO-BMFF file branded as 3GP and
 * then give it an .m4a extension. Browsers play those files, but strict
 * Whisper-compatible providers inspect the ftyp brand and reject them as an
 * unsupported 3GP upload. AAC is already valid M4A media, so rebrand the small
 * ftyp box without transcoding or touching the audio samples.
 */
export function normalizeM4aContainer(data: Uint8Array, filename: string) {
  const normalized = new Uint8Array(data);
  if (!/\.m4a$/i.test(filename)
    || normalized.length < 24
    || !matchesAscii(normalized, 4, "ftyp")
    || !matchesAscii(normalized, 8, "3gp")
    || !containsAscii(normalized, "mp4a")) {
    return normalized;
  }

  const ftypSize = (normalized[0]! * 0x1000000)
    + (normalized[1]! << 16)
    + (normalized[2]! << 8)
    + normalized[3]!;
  if (ftypSize < 16 || ftypSize > Math.min(normalized.length, 1024)) return normalized;

  const m4aBrand = [0x4d, 0x34, 0x41, 0x20];
  normalized.set(m4aBrand, 8);
  for (let offset = 16; offset + 4 <= ftypSize; offset += 4) {
    if (matchesAscii(normalized, offset, "3gp")) normalized.set(m4aBrand, offset);
  }
  return normalized;
}
