import type { ChatMessage, ChatToolCall, ModelInfo } from "./types";

export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * OmniRoute answers a streamed request at once and then sends empty keepalive chunks while the upstream is silent,
 * so a hung provider never closes the connection. Only answer text, reasoning or tool arguments count as progress;
 * without any for this long the read fails with a retryable timeout instead of holding the whole request budget.
 */
export const PROVIDER_STREAM_IDLE_TIMEOUT_MS = 90_000;

export async function readBeforeIdle<T>(reader: ReadableStreamDefaultReader<T>, lastProgressAt: number, idleMs: number) {
  const idle = () => new Error(`provider_stream_idle_timeout: no model output for ${Math.round(idleMs / 1000)} s`);
  const remaining = lastProgressAt + idleMs - Date.now();
  if (remaining <= 0) throw idle();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(idle()), remaining); })]);
  } finally { clearTimeout(timer); }
}

/**
 * In stream mode OmniRoute reports an upstream failure (after its own retries) as an SSE error frame inside an
 * HTTP 200 response, e.g. a 429 cooldown or a `[502]` gateway error. Name its status the way a failed HTTP response
 * is named, so fallback and retry decisions treat both forms alike. Frames without a status (OmniRoute sends
 * "No active credentials" where a plain request gets HTTP 401) keep the `provider_stream_error` marker.
 */
export function streamErrorMessage(error: unknown): string {
  const detail = (typeof error === "string" ? { message: error } : error ?? {}) as { message?: unknown; type?: unknown; code?: unknown; status?: unknown };
  const message = String(detail.message ?? JSON.stringify(error)).slice(0, 300);
  const status = Number(detail.status) || Number(detail.code) || Number(/\[(\d{3})\]/.exec(message)?.[1])
    || (/rate.?limit|cooldown/i.test(`${detail.type} ${detail.code}`) ? 429 : /server_error/i.test(String(detail.type)) ? 500 : 0);
  return `provider_stream_error: OmniRoute stream failed${status ? ` with HTTP ${status}` : ""}: ${message}`;
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

/**
 * Step 3: which models need an **explicit** cache marker.
 *
 * Anthropic-family models only cache a prefix that carries `cache_control`; every other provider NPATI is configured
 * with either caches implicitly (DeepSeek reports `cached_tokens` on repeated prompts without any directive) or does
 * not cache at all. Sending an Anthropic-shaped content-block array to a provider that expects a system string is not
 * neutral: measured on DeepSeek Flash, the array form made the provider drop the system prompt (prompt_tokens 2438 →
 * 37). The list is therefore an allowlist by explicit model id, and `auto/*` combos are excluded because the model
 * that actually answers is not known at request time — an unknown provider gets the plain string, never a guess.
 */
export function modelSupportsExplicitPromptCache(model?: string): boolean {
  const id = String(model ?? "").trim().toLowerCase();
  if (!id || id === "auto" || id.startsWith("auto/")) return false;
  return id.startsWith("anthropic/") || id.startsWith("claude") || id.includes("/claude");
}

/**
 * Marks the stable prefix of the first system message for models that require it. The prompt itself is unchanged:
 * the same text is split into two blocks, the first carrying the cache marker. Anything unexpected (no prefix, a
 * prefix that does not match, a system message that is already structured) returns the messages untouched.
 */
export function withExplicitPromptCache<M extends ChatMessage>(
  messages: readonly M[],
  prefix: string | undefined,
  model: string | undefined,
): M[] {
  if (!prefix || !modelSupportsExplicitPromptCache(model)) return [...messages];
  const index = messages.findIndex((message) => message.role === "system");
  if (index < 0) return [...messages];
  const content = messages[index]!.content;
  if (typeof content !== "string" || !content.startsWith(prefix)) return [...messages];
  const rest = content.slice(prefix.length);
  const blocks = [
    { type: "text" as const, text: prefix, cache_control: { type: "ephemeral" as const } },
    ...(rest ? [{ type: "text" as const, text: rest }] : []),
  ];
  return messages.map((message, position) => position === index
    ? ({ ...message, content: blocks } as unknown as M)
    : message);
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

/**
 * OmniRoute's own response cost (`X-OmniRoute-Response-Cost`, USD). It reports `0` for a model it has no price for,
 * so only a positive value is a real price; anything else stays undefined and NPATI keeps its budget estimate.
 */
export function upstreamCostUsd(headers: Headers) {
  const cost = numericHeader(headers, "x-omniroute-response-cost", "x-omniroute-cost-usd", "x-cost-usd");
  return cost !== undefined && cost > 0 ? cost : undefined;
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
