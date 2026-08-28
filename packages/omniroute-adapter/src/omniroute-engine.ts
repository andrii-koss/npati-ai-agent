import type { ServiceHealth } from "@npati/shared";
import type { AIEngine, AudioTranscriptionInput, AudioTranscriptionResult, ChatContentPart, ChatRequest, ChatResult, ModelInfo, OmniRouteConfig, WebFetchInput, WebPageResult, WebSearchInput, WebSearchResponse } from "./types";

function requiresResponsesApi(model?: string) {
  return /^openai\/gpt-5\.6(?:$|-)/i.test(model ?? "");
}

function responsesText(payload: {
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

export class OmniRouteEngine implements AIEngine {
  private readonly baseUrl?: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly transcriptionModel: string;

  constructor(config: OmniRouteConfig) {
    this.baseUrl = config.baseUrl?.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 4_000;
    this.transcriptionModel = config.transcriptionModel ?? "openai/whisper-1";
  }

  private headers(compression?: ChatRequest["compression"]): HeadersInit {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(compression ? { "x-omniroute-compression": compression } : {}),
      // NPATI owns Business, Goals, Memory and chat history. Prevent a second
      // OmniRoute memory/skills injection from inflating or contaminating context.
      "x-omniroute-no-memory": "true",
    };
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const models = [request.model ?? "auto", request.fallbackModel]
      .filter((model): model is string => Boolean(model))
      .filter((model, index, values) => values.indexOf(model) === index);
    let lastError = "OmniRoute chat failed";
    for (const [index, model] of models.entries()) {
      const useResponses = requiresResponsesApi(model);
      const path = useResponses ? "/api/v1/responses" : "/api/v1/chat/completions";
      const responseContent = (content: string | ChatContentPart[]) => Array.isArray(content)
        ? content.map((part) => part.type === "text"
          ? { type: "input_text", text: part.text }
          : { type: "input_image", image_url: part.image_url.url, detail: part.image_url.detail ?? "auto" })
        : content;
      const body = useResponses
        ? {
            model,
            input: request.messages.map(({ role, content }) => ({ role, content: responseContent(content) })),
            stream: false,
          }
        : { model, messages: request.messages };
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(request.compression),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
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
        const retryable = response.status === 404 || response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500
          || /quota|rate.?limit|unavailable|model.*(?:missing|disabled|locked)/i.test(message);
        if (index < models.length - 1 && retryable) continue;
        throw new Error(lastError);
      }
      const payload = (await response.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        output_text?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      return {
        content: useResponses ? responsesText(payload) : payload.choices?.[0]?.message?.content ?? "",
        model: payload.model ?? model,
      };
    }
    throw new Error(lastError);
  }

  async *stream(request: ChatRequest): AsyncIterable<string> {
    const result = await this.chat(request);
    yield result.content;
  }

  async transcribeAudio(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult> {
    if (!this.baseUrl) throw new Error("OmniRoute is not configured");
    const form = new FormData();
    form.set("file", new Blob([input.data], { type: input.mimeType }), input.filename);
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

  async listModels(): Promise<ModelInfo[]> {
    if (!this.baseUrl) return [];
    const response = await fetch(`${this.baseUrl}/api/v1/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: Array<{ id: string; name?: string }> };
    return payload.data ?? [];
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

  async executeTool(): Promise<unknown> {
    throw new Error("Tool execution is not enabled in the foundation milestone");
  }

  async searchMemory(): Promise<unknown[]> {
    return [];
  }

  async saveMemory(): Promise<void> {
    throw new Error("OmniRoute memory is intentionally isolated from NPATI Business Memory");
  }

  async getCapabilities(): Promise<string[]> {
    return ["chat", "vision", "audio.transcription", "stream", "models", "web.search", "web.fetch", "health"];
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
