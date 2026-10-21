import type { ServiceHealth } from "@npati/shared";
import { isChatCapableModel } from "./normalization";
import { providerToolNames } from "./provider-tool-names";
import { retainProviderContinuation } from "./provider-continuation";
import { readChatStream } from "./chat-stream";
import { observeProviderAttempt } from "./provider-attempt";
import type { A2AMessageRequest, A2AMessageResult, AIEngine, AudioTranscriptionInput, AudioTranscriptionResult, ChatContentPart, ChatMessage, ChatToolCall, EmbeddingInput, EmbeddingResult, ModerationInput, ModerationResult, RerankInput, RerankResult, ChatRequest, ChatResult, MCPToolCallRequest, ModelInfo, OmniRouteComboInput, OmniRouteConfig, OmniRouteResilienceSnapshot, SpeechAudioFormat, SpeechSynthesisInput, SpeechSynthesisResult, WebFetchInput, WebPageResult, WebSearchInput, WebSearchResponse } from "./types";

import {
  requestSignal,
  mcpJson,
  requiresResponsesApi,
  responsesText,
  responseInputMessage,
  responseToolCalls,
  boundedTextChunks,
  numericHeader,
  textHeader,
  chatUsage,
  normalizeM4aContainer,
} from "./omniroute-engine-helpers";

export class OmniRouteEngine implements AIEngine {
  private readonly chatModelMetadata = new Map<string, ModelInfo>();
  private readonly baseUrl?: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly transcriptionModel: string;
  private readonly ttsModel: string;
  private readonly embeddingModel?: string;
  private readonly rerankModel?: string;

  constructor(config: OmniRouteConfig) {
    this.baseUrl = config.baseUrl?.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 4_000;
    this.transcriptionModel = config.transcriptionModel ?? "openai/whisper-1";
    this.ttsModel = config.ttsModel ?? "openai/gpt-4o-mini-tts";
    this.embeddingModel = config.embeddingModel;
    this.rerankModel = config.rerankModel;
  }

  private headers(compression?: ChatRequest["compression"], idempotencyKey?: string): HeadersInit {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(compression ? { "x-omniroute-compression": compression } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      // NPATI owns Business, Goals, Memory and chat history. Prevent a second
      // OmniRoute memory/skills injection from inflating or contaminating context.
      "x-omniroute-no-memory": "true",
    };
  }

  supportsNativeTools() { return true; }

  private async chatCandidates(primary?: string, fallback?: string): Promise<string[]> {
    const requested = [primary ?? "auto", fallback].filter((model): model is string => Boolean(model));
    const discover = requested.some((model) => model === "auto" || model.startsWith("auto/"));
    const available = discover && this.chatModelMetadata.size === 0 ? await this.listModels().catch(() => []) : [...this.chatModelMetadata.values()];
    const metadata = new Map(available.map((model) => [model.id, model]));
    const candidates = requested.flatMap((model) => model === "auto" || model.startsWith("auto/")
      ? available.map((entry) => entry.id)
      : [model]);
    const canonicalCandidates = candidates.map((model) => /^deepseek\/(?:DeepSeek-V4\.1-Flash|deepseek-v4\.1-flash|deepseek-v4-flash)$/i.test(model)
      ? "deepseek/deepseek-flash"
      : model);
    const compatible = [...new Set(canonicalCandidates)].filter((id) => id !== "auto" && !id.startsWith("auto/") && ((requested.includes(id) && id.startsWith("npati/")) || isChatCapableModel(metadata.get(id) ?? { id })));
    if (!compatible.length) throw new Error("model_unavailable: no chat-compatible model supports the requested inference interface");
    return compatible;
  }
  async chat(request: ChatRequest): Promise<ChatResult> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const wire = await providerToolNames(request);
    const candidateModels = await this.chatCandidates(request.model, request.fallbackModel);
    let lastError = "OmniRoute chat failed";
    const startedAt = Date.now();
    for (const [index, model] of candidateModels.entries()) {
      const useResponses = requiresResponsesApi(this.chatModelMetadata.get(model));
      const path = useResponses ? "/api/v1/responses" : "/api/v1/chat/completions";
      const responseTools = wire.tools?.map((tool) => ({ type: "function", ...tool.function }));
      const responseChoice = typeof wire.toolChoice === "object" ? { type: "function", name: wire.toolChoice.function.name } : wire.toolChoice ?? "auto";
      const body = useResponses
        ? {
            model,
            input: wire.messages.flatMap<any>((message) => responseInputMessage(message)),
            stream: false,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(responseTools?.length ? { tools: responseTools, tool_choice: responseChoice, parallel_tool_calls: false } : {}),
          }
        : {
            model,
            messages: wire.messages,
            ...(request.reasoningMode === "disabled" && model === "deepseek/deepseek-flash" ? {thinking:{type:"disabled"},reasoning_effort:"none"} : {}),
            ...(request.onGenerationProgress ? {stream:true,stream_options:{include_usage:true}} : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(wire.tools?.length ? { tools: wire.tools, tool_choice: wire.toolChoice ?? "auto", parallel_tool_calls: false } : {}),
          };
      const attemptStarted=Date.now();
      await observeProviderAttempt(request,{model,phase:"started"});
      let response:Response;
      try { response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(request.compression, request.idempotencyKey),
        body: JSON.stringify(body),
        signal: requestSignal(request.signal, request.timeoutMs ?? 180_000),
      }); } catch(error) {
        await observeProviderAttempt(request,{model,phase:"failed",durationMs:Date.now()-attemptStarted,errorCode:request.signal?.aborted?"aborted":error instanceof Error && /timeout/i.test(error.name+error.message)?"provider_timeout":"provider_connection_error"});
        throw error;
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        let message = "";
        try {
          const parsed = JSON.parse(detail) as { error?: { message?: string } | string; message?: string };
          message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? "";
        } catch {
          message = detail.slice(0, 300);
        }
        lastError = `OmniRoute chat failed with HTTP ${response.status}${message ? `: ${message}` : ""}`;
        const canRetryNext = index < candidateModels.length - 1;
        const retryable = response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 || response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500
          || /unsupported|quota|rate.?limit|unavailable|model.*(?:missing|disabled|locked|does not support|invalid)/i.test(message);
        await observeProviderAttempt(request,{model,phase:"failed",durationMs:Date.now()-attemptStarted,httpStatus:response.status,errorCode:"provider_http_error",retryScheduled:canRetryNext && retryable});
        if (canRetryNext && retryable) continue;
        throw Object.assign(new Error(lastError),{httpStatus:response.status,code:"provider_http_error"});
      }
      const payload = (await (useResponses ? response.json() : readChatStream(response, request, attemptStarted))) as {
        model?: string;
        provider?: string;
        usage?: Record<string, unknown>;
        usageMetadata?: Record<string, unknown>;
        choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: ChatToolCall[]; reasoning_content?: string; reasoning_text?: string } }>;
        output_text?: string;
        output?: Array<Record<string, any>>;
      };
      const toolCalls = wire.decode(useResponses ? responseToolCalls(payload) : payload.choices?.[0]?.message?.tool_calls ?? []);
      await observeProviderAttempt(request,{model:payload.model ?? model,phase:"completed",durationMs:Date.now()-attemptStarted,httpStatus:response.status});
      return retainProviderContinuation({
        content: useResponses ? responsesText(payload) : payload.choices?.[0]?.message?.content ?? "",
        ...(toolCalls.length ? { toolCalls } : {}),
        finishReason: useResponses ? (toolCalls.length ? "tool_calls" : "stop") : payload.choices?.[0]?.finish_reason,
        model: payload.model ?? model,
        usage: chatUsage(payload),
        telemetry: {
          requestId: textHeader(response.headers, "x-request-id", "x-omniroute-request-id"),
          provider: textHeader(response.headers, "x-omniroute-provider", "x-provider") ?? payload.provider,
          routingStrategy: textHeader(response.headers, "x-omniroute-routing-strategy", "x-routing-strategy") ?? (model === "auto" ? "auto" : "manual"),
          latencyMs: numericHeader(response.headers, "x-omniroute-latency-ms", "x-response-time-ms") ?? Math.max(0, Date.now() - startedAt),
          costUsd: numericHeader(response.headers, "x-omniroute-cost-usd", "x-cost-usd"),
          costSource: numericHeader(response.headers, "x-omniroute-cost-usd", "x-cost-usd") != null ? "upstream" : undefined,
          cacheHit: textHeader(response.headers, "x-omniroute-cache-hit", "x-cache-hit") === "true" || (chatUsage(payload)?.cachedTokens ?? 0) > 0,
          cacheSavingsUsd: numericHeader(response.headers, "x-omniroute-cache-savings-usd", "x-cache-savings-usd"),
          failoverCount: numericHeader(response.headers, "x-omniroute-failover-count", "x-failover-count") ?? index,
        },
      }, useResponses ? undefined : payload.choices?.[0]?.message);
    }
    throw new Error(lastError);
  }

  async *stream(request: ChatRequest): AsyncIterable<string> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const candidateModels = await this.chatCandidates(request.model, request.fallbackModel);
    for (const [index, model] of candidateModels.entries()) {
      const useResponses = requiresResponsesApi(this.chatModelMetadata.get(model));
      const path = useResponses ? "/api/v1/responses" : "/api/v1/chat/completions";
      const responseContent = (content: string | ChatContentPart[]) => Array.isArray(content)
        ? content.map((part) => part.type === "text"
          ? { type: "input_text", text: part.text }
          : { type: "input_image", image_url: part.image_url.url, detail: part.image_url.detail ?? "auto" })
        : content;
      const body = useResponses
        ? { model, input: request.messages.map(({ role, content }) => ({ role, content: responseContent(content ?? "") })), stream: true, ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) }
        : { model, messages: request.messages, stream: true, ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) };
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST", headers: this.headers(request.compression, request.idempotencyKey), body: JSON.stringify(body),
        signal: requestSignal(request.signal, request.timeoutMs ?? 180_000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const canRetryNext = index < candidateModels.length - 1;
        const retryable = response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 || response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500
          || /unsupported|quota|rate.?limit|unavailable|model/i.test(detail);
        if (canRetryNext && retryable) continue;
        throw new Error(`OmniRoute stream failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }
      if (!response.body) throw new Error("OmniRoute stream returned no response body");
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
        const content = useResponses ? responsesText(payload) : payload.choices?.[0]?.message?.content ?? "";
        for (const chunk of boundedTextChunks(content)) yield chunk;
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let yieldedAny = false;
      let streamError: Error | null = null;
      const emitLine = function* (line: string) {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let payload: any;
        try { payload = JSON.parse(data); } catch { return; }
        if (payload?.error) {
          const message = typeof payload.error === "string" ? payload.error : payload.error.message || JSON.stringify(payload.error);
          throw new Error(message);
        }
        const delta = useResponses
          ? payload.type === "response.output_text.delta" ? payload.delta : payload.output_text?.delta
          : payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.text;
        if (typeof delta === "string" && delta) yield* boundedTextChunks(delta);
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          for (const line of lines) {
            for (const chunk of emitLine(line)) {
              yieldedAny = true;
              yield chunk;
            }
          }
        }
        pending += decoder.decode();
        if (pending) {
          for (const chunk of emitLine(pending)) {
            yieldedAny = true;
            yield chunk;
          }
        }
      } catch (err) {
        streamError = err instanceof Error ? err : new Error(String(err));
      } finally {
        reader.releaseLock();
      }
      if (streamError) {
        if (!yieldedAny && index < candidateModels.length - 1) continue;
        throw streamError;
      }
      if (!yieldedAny && index < candidateModels.length - 1) {
        continue;
      }
      return;
    }
  }

  async transcribeAudio(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const form = new FormData();
    const audioData = normalizeM4aContainer(new Uint8Array(input.data), input.filename);
    form.set("file", new Blob([audioData.buffer as ArrayBuffer], { type: input.mimeType }), input.filename);
    form.set("model", input.model ?? this.transcriptionModel);
    form.set("response_format", "json");
    if (input.language) form.set("language", input.language);
    const response = await fetch(this.baseUrl + "/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        "x-omniroute-no-memory": "true",
      },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw await this.responseError("audio transcription", response);
    const payload = await response.json() as { text?: string; model?: string };
    if (!payload.text?.trim()) throw new Error("OmniRoute audio transcription returned no text");
    return { text: payload.text.trim(), model: payload.model ?? input.model ?? this.transcriptionModel };
  }

  async synthesizeSpeech(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const text = input.text.trim();
    if (!text) throw new Error("Text-to-speech input is required");
    const format: SpeechAudioFormat = input.format ?? "mp3";
    const model = input.model?.trim() || this.ttsModel;
    const voice = input.voice?.trim() || "alloy";
    const response = await fetch(this.baseUrl + "/api/v1/audio/speech", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: format,
        ...(typeof input.speed === "number" ? { speed: Math.max(0.25, Math.min(input.speed, 4)) } : {}),
      }),
      signal: requestSignal(input.signal, input.timeoutMs ?? Math.max(this.timeoutMs, 60_000)),
    });
    if (!response.ok) throw await this.responseError("text-to-speech", response);
    const mimeByFormat: Record<SpeechAudioFormat, string> = {
      mp3: "audio/mpeg", opus: "audio/opus", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav", pcm: "audio/L16",
    };
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type")?.split(";", 1)[0] || mimeByFormat[format],
      model,
      voice,
      format,
    };
  }

  async ensureA2AEnabled(): Promise<void> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const status = await fetch(this.baseUrl + "/api/a2a/status", {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (status.ok && ((await status.json()) as { enabled?: boolean }).enabled === true) return;
    const response = await fetch(this.baseUrl + "/api/settings", {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ a2aEnabled: true }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await this.responseError("A2A enablement", response);
    const verify = await fetch(this.baseUrl + "/api/a2a/status", {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = verify.ok ? await verify.json() as { enabled?: boolean; online?: boolean } : {};
    if (!payload.enabled || !payload.online) throw new Error("OmniRoute A2A endpoint is not online");
  }


  async ensureMCPEnabled(): Promise<void> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const status = await fetch(this.baseUrl + "/api/mcp/status", {
      headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs),
    });
    const current = status.ok ? await status.json() as { enabled?: boolean; online?: boolean; transport?: string } : {};
    if (current.enabled && current.online && current.transport === "streamable-http") return;
    const response = await fetch(this.baseUrl + "/api/settings", {
      method: "PATCH", headers: this.headers(),
      body: JSON.stringify({ mcpEnabled: true, mcpTransport: "streamable-http" }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await this.responseError("MCP enablement", response);
    const verify = await fetch(this.baseUrl + "/api/mcp/status", {
      headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs),
    });
    const ready = verify.ok ? await verify.json() as { enabled?: boolean; online?: boolean; transport?: string } : {};
    if (!ready.enabled || !ready.online || ready.transport !== "streamable-http") throw new Error("OmniRoute MCP endpoint is not online");
  }

  async mcpCall(request: MCPToolCallRequest): Promise<unknown> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    await this.ensureMCPEnabled();
    const url = this.baseUrl + "/api/mcp/stream";
    const signal = requestSignal(request.signal, request.timeoutMs ?? 30_000);
    const headers = new Headers(this.headers());
    headers.set("accept", "application/json, text/event-stream");
    const initialize = await fetch(url, {
      method: "POST", headers, signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "npati-agent", version: "0.1.0" } } }),
    });
    if (!initialize.ok) throw await this.responseError("MCP initialize", initialize);
    mcpJson(await initialize.text());
    const sessionId = initialize.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("OmniRoute MCP did not return a session");
    headers.set("mcp-session-id", sessionId);
    try {
      const ready = await fetch(url, {
        method: "POST", headers, signal,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      if (!ready.ok) throw await this.responseError("MCP initialization", ready);
      const response = await fetch(url, {
        method: "POST", headers, signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call",
          params: { name: request.name, arguments: request.arguments ?? {} } }),
      });
      if (!response.ok) throw await this.responseError("MCP tool call", response);
      const payload = mcpJson(await response.text());
      if (payload.error) throw new Error("OmniRoute MCP failed: " + (payload.error.message ?? "unknown error"));
      const values = payload.result?.content?.filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text!) ?? [];
      if (!values.length) return payload.result ?? {};
      if (values.length === 1) {
        try { return JSON.parse(values[0]!); } catch { return values[0]; }
      }
      return values;
    } finally {
      await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(3_000) }).catch(() => undefined);
    }
  }

  async a2aSend(request: A2AMessageRequest): Promise<A2AMessageResult> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const id = crypto.randomUUID();
    const response = await fetch(this.baseUrl + "/a2a", {
      method: "POST",
      headers: this.headers(undefined, request.idempotencyKey),
      body: JSON.stringify({
        jsonrpc: "2.0", id, method: "message/send",
        params: {
          skill: "smart-routing",
          messages: request.messages,
          metadata: { model: request.model ?? "auto", ...(request.combo ? { combo: request.combo } : {}) },
        },
      }),
      signal: requestSignal(request.signal, request.timeoutMs ?? 60_000),
    });
    if (!response.ok) throw await this.responseError("A2A message", response);
    const payload = await response.json() as {
      error?: { code?: number; message?: string };
      result?: { task?: { id?: string }; artifacts?: Array<{ type?: string; content?: string }>; metadata?: Record<string, unknown> };
    };
    if (payload.error) throw new Error(`OmniRoute A2A failed: ${payload.error.message ?? payload.error.code ?? "unknown error"}`);
    const taskId = payload.result?.task?.id;
    const content = payload.result?.artifacts?.filter((item) => item.type === "text" && typeof item.content === "string")
      .map((item) => item.content).join("\n") ?? "";
    if (!taskId || !content.trim()) throw new Error("OmniRoute A2A returned an incomplete result");
    return { taskId, content, metadata: payload.result?.metadata ?? {} };
  }

  async cancelA2ATask(taskId: string, signal?: AbortSignal): Promise<void> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const response = await fetch(this.baseUrl + "/a2a", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tasks/cancel", params: { taskId } }),
      signal: requestSignal(signal, this.timeoutMs),
    });
    if (!response.ok) throw await this.responseError("A2A cancellation", response);
    const payload = await response.json() as { error?: { message?: string } };
    if (payload.error) throw new Error(`OmniRoute A2A cancellation failed: ${payload.error.message ?? "unknown error"}`);
  }

  async ensureCombo(input: OmniRouteComboInput, signal?: AbortSignal): Promise<{ name: string }> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const response = await fetch(this.baseUrl + "/api/combos", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
      signal: requestSignal(signal, Math.max(this.timeoutMs, 15_000)),
    });
    if (response.ok) return { name: input.name };
    const detail = await response.text().catch(() => "");
    if (response.status === 400 && /already exists/i.test(detail)) return { name: input.name };
    let message = detail.slice(0, 300);
    try {
      const payload = JSON.parse(detail) as { error?: string | { message?: string } };
      message = typeof payload.error === "string" ? payload.error : payload.error?.message ?? message;
    } catch { /* keep safe response text */ }
    throw new Error(`OmniRoute combo setup failed with HTTP ${response.status}${message ? `: ${message}` : ""}`);
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.baseUrl) return [];
    const response = await fetch(`${this.baseUrl}/api/v1/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
    const models = (payload.data ?? []).filter((model) => typeof model.id === "string").map((model) => ({
      id: model.id as string,
      name: typeof model.name === "string" ? model.name : undefined,
      type: typeof model.type === "string" ? model.type : undefined,
      apiFormat: typeof (model.api_format ?? model.apiFormat) === "string" ? (model.api_format ?? model.apiFormat) as string : undefined,
      capabilities: Array.isArray(model.capabilities) ? model.capabilities.filter((item): item is string => typeof item === "string")
        : model.capabilities && typeof model.capabilities === "object" ? Object.entries(model.capabilities).filter(([, enabled]) => enabled === true).map(([name]) => name) : undefined,
      outputModalities: Array.isArray(model.output_modalities ?? model.outputModalities)
        ? ((model.output_modalities ?? model.outputModalities) as unknown[]).filter((item): item is string => typeof item === "string") : undefined,
      ownedBy: typeof model.owned_by === "string" ? model.owned_by : undefined,
      parent: typeof model.parent === "string" ? model.parent : null,
      supportedEndpoints: Array.isArray(model.supported_endpoints ?? model.supportedEndpoints)
        ? ((model.supported_endpoints ?? model.supportedEndpoints) as unknown[]).filter((item): item is string => typeof item === "string") : undefined,
    }));
    for (const model of models) this.chatModelMetadata.set(model.id, model);
    return models;
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    return (await this.listModels()).find((model) => model.id === id);
  }

  async webSearch(input: WebSearchInput): Promise<WebSearchResponse> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const response = await fetch(this.baseUrl + "/api/v1/search", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        query: input.query,
        max_results: Math.max(1, Math.min(input.maxResults ?? 5, 20)),
        search_type: input.searchType ?? "web",
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.country ? { country: input.country } : {}),
        ...(input.language ? { language: input.language } : {}),
      }),
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 20_000)),
    });
    if (!response.ok) throw await this.responseError("web search", response);
    const payload = await response.json() as {
      provider?: string; query?: string; cached?: boolean;
      results?: Array<{ title?: string; url?: string; snippet?: string; position?: number; published_at?: string | null; citation?: { provider?: string; retrieved_at?: string } }>;
    };
    return {
      provider: payload.provider ?? "unknown",
      query: payload.query ?? input.query,
      cached: payload.cached === true,
      results: (payload.results ?? []).filter((item) => typeof item.url === "string" && typeof item.title === "string").map((item) => ({
        title: item.title!, url: item.url!, snippet: item.snippet || undefined,
        source: item.citation?.provider ?? payload.provider,
        publishedAt: item.published_at ?? undefined,
        position: item.position,
        retrievedAt: item.citation?.retrieved_at,
      })),
    };
  }

  async webFetch(input: WebFetchInput): Promise<WebPageResult> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const format = input.format ?? "markdown";
    const response = await fetch(this.baseUrl + "/api/v1/web/fetch", {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ url: input.url, format, depth: 0, include_metadata: input.includeMetadata ?? true, ...(input.provider ? { provider: input.provider } : {}) }),
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 30_000)),
    });
    if (!response.ok) throw await this.responseError("web fetch", response);
    const payload = await response.json() as { provider?: string; url?: string; content?: string; links?: string[]; metadata?: { title?: string | null; description?: string | null } | null };
    return {
      url: input.url, finalUrl: payload.url || input.url, title: payload.metadata?.title ?? undefined,
      description: payload.metadata?.description ?? undefined, links: Array.isArray(payload.links) ? payload.links : [],
      ...(format === "markdown" ? { markdown: payload.content ?? "", text: payload.content ?? "" } : { text: payload.content ?? "" }),
      provider: payload.provider, fetchedAt: new Date().toISOString(),
    };
  }

  private async responseError(operation: string, response: Response) {
    const detail = await response.text().catch(() => "");
    let message = detail.slice(0, 300);
    try { const value = JSON.parse(detail) as { error?: { message?: string } }; message = value.error?.message ?? message; } catch { /* keep safe text */ }
    return new Error("OmniRoute " + operation + " failed with HTTP " + response.status + (message ? ": " + message : ""));
  }

  async executeTool(name: string, input: unknown): Promise<unknown> {
    const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
    if (name === "web.search") {
      const query = typeof value.query === "string" ? value.query.trim() : "";
      if (!query) throw new Error("web.search requires a query");
      return this.webSearch({
        query,
        maxResults: typeof value.maxResults === "number" ? value.maxResults : undefined,
        searchType: value.searchType === "news" ? "news" : "web",
      });
    }
    if (name === "web.fetch") {
      const url = typeof value.url === "string" ? value.url.trim() : "";
      if (!url) throw new Error("web.fetch requires a URL");
      return this.webFetch({ url, format: value.format === "html" || value.format === "links" ? value.format : "markdown" });
    }
    if (name === "audio.speech") {
      const input = typeof value.input === "string" ? value.input : typeof value.text === "string" ? value.text : "";
      const format = ["mp3", "opus", "aac", "flac", "wav", "pcm"].includes(String(value.format))
        ? value.format as SpeechAudioFormat
        : undefined;
      const result = await this.synthesizeSpeech({
        text: input,
        model: typeof value.model === "string" ? value.model : undefined,
        voice: typeof value.voice === "string" ? value.voice : undefined,
        speed: typeof value.speed === "number" ? value.speed : undefined,
        format,
      });
      return { ...result, data: undefined, audioBase64: Buffer.from(result.data).toString("base64") };
    }
    throw new Error(`Tool "${name}" is not exposed by the NPATI OmniRoute adapter`);
  }

  private async specialtyModel(path: string, configured?: string) {
    if (configured) return configured;
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const response = await fetch(this.baseUrl + path, { headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw await this.responseError("specialty model discovery", response);
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const model = payload.data?.find((item) => typeof item.id === "string")?.id;
    if (!model) throw new Error("No configured OmniRoute model is available for " + path);
    return model;
  }

  private async rerankSpecialtyModel(configured?: string) {
    if (configured) return configured;
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const response = await fetch(this.baseUrl + "/api/v1/models", { headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw await this.responseError("rerank model discovery", response);
    const payload = await response.json() as { data?: Array<{ id?: string; apiFormat?: string; supportedEndpoints?: string[] }> };
    const model = payload.data?.find((item) => item.apiFormat === "rerank" || item.supportedEndpoints?.includes("rerank"))?.id;
    if (!model) throw new Error("No configured OmniRoute rerank model is available");
    return model;
  }

  async embed(input: EmbeddingInput): Promise<EmbeddingResult> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const model = await this.specialtyModel("/api/v1/embeddings", input.model ?? this.embeddingModel);
    const response = await fetch(this.baseUrl + "/api/v1/embeddings", {
      method: "POST", headers: this.headers(), body: JSON.stringify({ model, input: input.input }),
      signal: requestSignal(input.signal, input.timeoutMs ?? 120_000),
    });
    if (!response.ok) throw await this.responseError("embeddings", response);
    const payload = await response.json() as { model?: string; data?: Array<{ index?: number; embedding?: number[] }>; usage?: Record<string, number> };
    const rows = (payload.data ?? []).slice().sort((a,b)=>(a.index ?? 0)-(b.index ?? 0));
    if (rows.length !== input.input.length || rows.some((row) => !Array.isArray(row.embedding))) throw new Error("OmniRoute returned an invalid embeddings response");
    return { model: payload.model ?? model, vectors: rows.map((row) => row.embedding!), usage: payload.usage };
  }

  async moderate(input: ModerationInput): Promise<ModerationResult> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const model = input.model ?? "omni-moderation-latest";
    const response = await fetch(this.baseUrl + "/api/v1/moderations", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, input: input.input.length === 1 ? input.input[0] : input.input }),
      signal: requestSignal(input.signal, input.timeoutMs ?? 30_000),
    });
    if (!response.ok) throw await this.responseError("moderations", response);
    const payload = await response.json() as {
      id?: string;
      model?: string;
      results?: Array<{ flagged?: boolean; categories?: Record<string, boolean>; category_scores?: Record<string, number>; category_applied_input_types?: Record<string, string[]> }>;
    };
    if (!Array.isArray(payload.results) || payload.results.length !== input.input.length) {
      throw new Error("OmniRoute returned an invalid moderations response");
    }
    return {
      id: payload.id,
      model: payload.model ?? model,
      results: payload.results.map((row) => ({
        flagged: row.flagged === true,
        categories: row.categories ?? {},
        categoryScores: row.category_scores ?? {},
        categoryAppliedInputTypes: row.category_applied_input_types,
      })),
    };
  }
  async rerank(input: RerankInput): Promise<RerankResult> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const model = await this.rerankSpecialtyModel(input.model ?? this.rerankModel);
    const response = await fetch(this.baseUrl + "/api/v1/rerank", {
      method: "POST", headers: this.headers(), body: JSON.stringify({ model, query: input.query, documents: input.documents, top_n: input.topN ?? input.documents.length, return_documents: false }),
      signal: requestSignal(input.signal, input.timeoutMs ?? 120_000),
    });
    if (!response.ok) throw await this.responseError("rerank", response);
    const payload = await response.json() as { model?: string; results?: Array<{ index?: number; relevance_score?: number; relevanceScore?: number }> };
    return { model: payload.model ?? model, results: (payload.results ?? []).flatMap((row) => typeof row.index === "number" ? [{ index: row.index, relevanceScore: Number(row.relevance_score ?? row.relevanceScore ?? 0) }] : []) };
  }

  async searchMemory(): Promise<unknown[]> {
    return [];
  }

  async saveMemory(): Promise<void> {
    throw new Error("OmniRoute memory is intentionally isolated from NPATI Business Memory");
  }

  async getCapabilities(): Promise<string[]> {
    return ["chat", "vision", "audio.transcription", "audio.speech", "moderations", "embeddings", "rerank", "stream", "models", "web.search", "web.fetch", "health"];
  }

  async resilienceStatus(): Promise<OmniRouteResilienceSnapshot> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const [configurationResponse, runtimeResponse] = await Promise.all([
      fetch(this.baseUrl + "/api/resilience", {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      }),
      fetch(this.baseUrl + "/api/monitoring/health", {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      }),
    ]);
    if (!configurationResponse.ok) throw await this.responseError("resilience configuration", configurationResponse);
    if (!runtimeResponse.ok) throw await this.responseError("resilience runtime", runtimeResponse);
    const configuration = await configurationResponse.json() as OmniRouteResilienceSnapshot["configuration"];
    const runtime = await runtimeResponse.json() as Record<string, unknown>;
    return {
      source: "omniroute",
      configuration: {
        requestQueue: configuration.requestQueue,
        connectionCooldown: configuration.connectionCooldown,
        providerBreaker: configuration.providerBreaker,
        waitForCooldown: configuration.waitForCooldown,
        comboCooldownWait: configuration.comboCooldownWait,
        quotaShareConcurrencyLimit: configuration.quotaShareConcurrencyLimit,
        providerCooldown: configuration.providerCooldown,
        providerQuotaOverrides: configuration.providerQuotaOverrides,
      },
      runtime: {
        status: typeof runtime.status === "string" ? runtime.status : "unknown",
        providerBreakers: Array.isArray(runtime.providerBreakers) ? runtime.providerBreakers : [],
        lockouts: Array.isArray(runtime.lockouts) ? runtime.lockouts : [],
        adaptiveAdmission: runtime.adaptiveAdmission ?? null,
        chatAdmission: runtime.chatAdmission ?? null,
      },
    };
  }

  async healthCheck(): Promise<ServiceHealth> {
    if (!this.baseUrl) return { status: "not_configured", detail: "OMNIROUTE_BASE_URL is empty" };
    try {
      const response = await fetch(`${this.baseUrl}/api/monitoring/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return { status: "unavailable", detail: `HTTP ${response.status}` };
      const payload = (await response.json()) as { status?: string; version?: string };
      return {
        status: payload.status === "ok" || payload.status === "healthy" ? "ok" : "degraded",
        version: payload.version,
      };
    } catch (error) {
      return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
