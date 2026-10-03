import { OmniRouteEngine } from "@npati/omniroute-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());
async function seedModels(engine: OmniRouteEngine, models: Array<{ id: string; type?: string; supported_endpoints?: string[] }>) {
  const providerFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: models }), { status: 200 })));
  await engine.listModels();
  vi.stubGlobal("fetch", providerFetch);
}

describe("OmniRoute adapter", () => {
  it("sends the current DeepSeek Flash API model ID for a selected V4.1 model", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      model: "deepseek-flash",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });

    for (const model of ["deepseek/DeepSeek-V4.1-Flash", "deepseek/deepseek-v4-flash"]) {
      await expect(engine.chat({ model, messages: [{ role: "user", content: "hello" }] })).resolves.toMatchObject({ content: "ok" });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) {
      expect(JSON.parse(String(options.body)).model).toBe("deepseek/deepseek-flash");
    }
  });

  it("uses the verified upstream monitoring endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "healthy", version: "3.8.49" })));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });

    await expect(engine.healthCheck()).resolves.toEqual({ status: "ok", version: "3.8.49" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://omniroute:20128/api/monitoring/health",
      expect.any(Object),
    );
  });

  it("reports a missing engine configuration without throwing", async () => {
    await expect(new OmniRouteEngine({}).healthCheck()).resolves.toMatchObject({ status: "not_configured" });
  });

  it("reads native OmniRoute resilience configuration and bounded runtime status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        requestQueue: { concurrentRequests: 8 },
        providerBreaker: { apikey: { failureThreshold: 3 } },
        waitForCooldown: { enabled: true, maxRetries: 2 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "healthy",
        providerBreakers: [{ provider: "openai", state: "closed" }],
        lockouts: [],
        adaptiveAdmission: { enabled: true },
        chatAdmission: { active: 1 },
        memory: { rss: 123456 },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128", apiKey: "secret" });

    await expect(engine.resilienceStatus()).resolves.toEqual({
      source: "omniroute",
      configuration: expect.objectContaining({
        requestQueue: { concurrentRequests: 8 },
        providerBreaker: { apikey: { failureThreshold: 3 } },
        waitForCooldown: { enabled: true, maxRetries: 2 },
      }),
      runtime: {
        status: "healthy",
        providerBreakers: [{ provider: "openai", state: "closed" }],
        lockouts: [],
        adaptiveAdmission: { enabled: true },
        chatAdmission: { active: 1 },
      },
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://omniroute:20128/api/resilience",
      "http://omniroute:20128/api/monitoring/health",
    ]);
  });

  it("routes the OpenAI GPT-5.6 family through OmniRoute Responses API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "gpt-5.6-luna",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello from Luna" }] }],
      output_text: "Hello from Luna",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    await seedModels(engine, [{ id: "openai/gpt-5.6-luna", type: "chat", supported_endpoints: ["/v1/responses"] }]);

    await expect(engine.chat({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "Hello" }],
    })).resolves.toMatchObject({ content: "Hello from Luna", model: "gpt-5.6-luna" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://omniroute:20128/api/v1/responses",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "openai/gpt-5.6-luna",
          input: [{ role: "user", content: "Hello" }],
          stream: false,
        }),
      }),
    );
  });

  it("keeps non-Responses models on chat completions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "gpt-4o",
      choices: [{ message: { content: "Hello from chat completions" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });

    await expect(engine.chat({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    })).resolves.toMatchObject({ content: "Hello from chat completions" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://omniroute:20128/api/v1/chat/completions",
      expect.any(Object),
    );
  });

  it("serializes native tools and parses chat-completions tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "gpt-4o",
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{
        id: "call-company", type: "function",
        function: { name: "npati_company_action", arguments: JSON.stringify({ action: "create" }) },
      }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    const tools = [{ type: "function" as const, function: { name: "npati_company_action", description: "Manage an NPATI company", parameters: { type: "object" } } }];

    await expect(engine.chat({ model: "openai/gpt-4o", messages: [{ role: "user", content: "Create it" }], tools, toolChoice: "auto" })).resolves.toMatchObject({
      content: "", finishReason: "tool_calls",
      toolCalls: [{ id: "call-company", function: { name: "npati_company_action" } }],
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ model: "openai/gpt-4o", tools, tool_choice: "auto", parallel_tool_calls: false });
  });

  it("round-trips function calls and outputs through the Responses API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "gpt-5.6-luna",
      output: [{ type: "function_call", call_id: "call-web", name: "web_search", arguments: JSON.stringify({ query: "current market" }) }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    await seedModels(engine, [{ id: "openai/gpt-5.6-luna", type: "chat", supported_endpoints: ["/v1/responses"] }]);
    const tools = [{ type: "function" as const, function: { name: "web_search", description: "Search public sources", parameters: { type: "object" } } }];

    await expect(engine.chat({
      model: "openai/gpt-5.6-luna",
      temperature: 0,
      tools,
      toolChoice: "auto",
      messages: [
        { role: "user", content: "Research the market" },
        { role: "assistant", content: null, tool_calls: [{ id: "previous", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "market" }) } }] },
        { role: "tool", tool_call_id: "previous", name: "web_search", content: JSON.stringify({ result: "evidence" }) },
      ],
    })).resolves.toMatchObject({
      toolCalls: [{ id: "call-web", function: { name: "web_search", arguments: JSON.stringify({ query: "current market" }) } }],
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      model: "openai/gpt-5.6-luna",
      temperature: 0,
      tool_choice: "auto",
      parallel_tool_calls: false,
      tools: [{ type: "function", name: "web_search" }],
    });
    expect(body.input).toContainEqual({ type: "function_call", call_id: "previous", name: "web_search", arguments: JSON.stringify({ query: "market" }) });
    expect(body.input).toContainEqual({ type: "function_call_output", call_id: "previous", output: JSON.stringify({ result: "evidence" }) });
  });

  it("normalizes live usage, routing, cost, cache, and failover telemetry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "openai/gpt-4o",
      provider: "openai",
      choices: [{ message: { content: "Measured answer" } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }), { status: 200, headers: {
      "content-type": "application/json",
      "x-request-id": "req-live-telemetry",
      "x-omniroute-routing-strategy": "priority",
      "x-omniroute-cost-usd": "0.0042",
      "x-omniroute-cache-hit": "true",
      "x-omniroute-cache-savings-usd": "0.0018",
      "x-omniroute-failover-count": "1",
      "x-omniroute-latency-ms": "240",
    } })));
    const result = await new OmniRouteEngine({ baseUrl: "http://omniroute:20128" }).chat({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "Measure this" }],
    });

    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150, cachedTokens: 80 });
    expect(result.telemetry).toEqual({
      requestId: "req-live-telemetry",
      provider: "openai",
      routingStrategy: "priority",
      latencyMs: 240,
      costUsd: 0.0042,
      costSource: "upstream",
      cacheHit: true,
      cacheSavingsUsd: 0.0018,
      failoverCount: 1,
    });
  });

  it("streams chat-completion deltas from split upstream SSE frames", async () => {
    const encoder = new TextEncoder();
    const upstream = [
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const item of upstream) controller.enqueue(encoder.encode(item)); controller.close(); } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });

    const chunks:string[]=[];
    for await(const chunk of engine.stream({model:"openai/gpt-4o",messages:[{role:"user",content:"Hello"}]}))chunks.push(chunk);

    expect(chunks).toEqual(["Hello ","world"]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({model:"openai/gpt-4o",stream:true});
  });

  it("streams Responses API deltas for GPT-5.6 models", async () => {
    const body='data: {"type":"response.output_text.delta","delta":"Luna"}\n\ndata: {"type":"response.output_text.delta","delta":" works"}\n\ndata: [DONE]\n\n';
    const fetchMock=vi.fn().mockResolvedValue(new Response(body,{status:200,headers:{"content-type":"text/event-stream"}}));
    vi.stubGlobal("fetch",fetchMock);
    const engine=new OmniRouteEngine({baseUrl:"http://omniroute:20128"});
    await seedModels(engine, [{ id: "openai/gpt-5.6-luna", type: "chat", supported_endpoints: ["/v1/responses"] }]);

    const chunks:string[]=[];for await(const chunk of engine.stream({model:"openai/gpt-5.6-luna",messages:[{role:"user",content:"Hello"}]}))chunks.push(chunk);

    expect(chunks).toEqual(["Luna"," works"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://omniroute:20128/api/v1/responses");
  });

  it("bounds oversized stream deltas without splitting surrogate pairs", async () => {
    const source="x".repeat(2_047)+"😀"+"y".repeat(2_100);
    const body=`data: ${JSON.stringify({choices:[{delta:{content:source}}]})}\n\ndata: [DONE]\n\n`;
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body,{status:200,headers:{"content-type":"text/event-stream"}})));
    const engine=new OmniRouteEngine({baseUrl:"http://omniroute:20128"});
    await seedModels(engine, [{ id: "openai/gpt-4o", type: "chat", supported_endpoints: ["/v1/chat/completions"] }]);

    const chunks:string[]=[];for await(const chunk of engine.stream({messages:[{role:"user",content:"Long"}]}))chunks.push(chunk);

    expect(chunks.join("")).toBe(source);
    expect(chunks.every(chunk=>chunk.length<=2_048)).toBe(true);
    expect(chunks.some(chunk=>chunk.endsWith("\ud83d"))).toBe(false);
  });

  it("cancels the upstream provider request when the caller aborts", async () => {
    const fetchMock=vi.fn((_url:string,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      if (init?.signal?.aborted) reject(init.signal.reason);
      else init?.signal?.addEventListener("abort",()=>reject(init.signal?.reason),{once:true});
    }));
    vi.stubGlobal("fetch",fetchMock);
    const engine=new OmniRouteEngine({baseUrl:"http://omniroute:20128"});
    await seedModels(engine, [{ id: "openai/gpt-4o", type: "chat", supported_endpoints: ["/v1/chat/completions"] }]);
    const controller=new AbortController();
    const next=engine.stream({messages:[{role:"user",content:"Cancel"}],signal:controller.signal})[Symbol.asyncIterator]().next();

    controller.abort(new DOMException("Stopped","AbortError"));

    await expect(next).rejects.toMatchObject({name:"AbortError"});
  });

  it("falls back on quota failure and sends the compression policy", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "quota exhausted" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "gemini/free-model",
        choices: [{ message: { content: "Fallback worked" } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    await seedModels(engine, [{ id: "gemini/free-model", type: "chat", supported_endpoints: ["/v1/chat/completions"] }]);

    await expect(engine.chat({
      model: "openai/gpt-4o",
      fallbackModel: "auto/chat:free",
      compression: "default",
      messages: [{ role: "user", content: "Hello" }],
    })).resolves.toMatchObject({ content: "Fallback worked", model: "gemini/free-model" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        "x-omniroute-compression": "default",
        "x-omniroute-no-memory": "true",
      }),
      body: JSON.stringify({ model: "gemini/free-model", messages: [{ role: "user", content: "Hello" }] }),
    }));
  });

  it("maps image attachments to Responses vision content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "gpt-5.6-luna",
      output_text: "A wooden chair",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    await seedModels(engine, [{ id: "openai/gpt-5.6-luna", type: "chat", supported_endpoints: ["/v1/responses"] }]);

    await engine.chat({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ] }],
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).input[0].content).toEqual([
      { type: "input_text", text: "What is this?" },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=", detail: "auto" },
    ]);
  });

  it("sends audio as multipart data to OmniRoute transcription", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "I sell furniture in Lviv." }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128", transcriptionModel: "openai/whisper-1" });

    await expect(engine.transcribeAudio({
      data: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm",
      filename: "voice.webm",
    })).resolves.toMatchObject({ text: "I sell furniture in Lviv." });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://omniroute:20128/api/v1/audio/transcriptions");
    expect((request.body as FormData).get("model")).toBe("openai/whisper-1");
    expect((request.body as FormData).get("file")).toBeInstanceOf(Blob);
  });

  it("synthesizes real speech bytes through the OmniRoute audio endpoint", async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 4, 5, 6]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128", apiKey: "secret", ttsModel: "openai/tts-1" });

    await expect(engine.synthesizeSpeech({ text: "Hello", voice: "nova", format: "mp3" })).resolves.toMatchObject({
      data: bytes, mimeType: "audio/mpeg", model: "openai/tts-1", voice: "nova", format: "mp3",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://omniroute:20128/api/v1/audio/speech", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ model: "openai/tts-1", input: "Hello", voice: "nova", response_format: "mp3" }),
    }));
  });

  it("rebrands AAC-in-3GP files mislabeled as M4A before transcription", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "Lyrics" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    const data = new Uint8Array(48);
    data.set([0, 0, 0, 24], 0);
    data.set(new TextEncoder().encode("ftyp3gp4\0\0\0\0isom3gp4"), 4);
    data.set(new TextEncoder().encode("mp4a"), 40);

    await engine.transcribeAudio({ data, mimeType: "audio/mp4", filename: "music.m4a" });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const file = (request.body as FormData).get("file") as Blob;
    const uploaded = new Uint8Array(await file.arrayBuffer());
    expect(new TextDecoder().decode(uploaded.subarray(8, 12))).toBe("M4A ");
    expect(new TextDecoder().decode(uploaded.subarray(20, 24))).toBe("M4A ");
    expect(new TextDecoder().decode(data.subarray(8, 12))).toBe("3gp4");
  });
  it("enables A2A through OmniRoute settings and sends smart-routing JSON-RPC", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false, online: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ a2aEnabled: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, online: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: "2.0", id: "request", result: {
          task: { id: "task-1", state: "completed" },
          artifacts: [{ type: "text", content: '{"mode":"single"}' }],
          metadata: { routing_explanation: "auto" },
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128", apiKey: "secret" });
    await engine.ensureA2AEnabled();
    await expect(engine.a2aSend({
      model: "auto", messages: [{ role: "user", content: "Plan" }],
    })).resolves.toMatchObject({ taskId: "task-1", content: '{"mode":"single"}' });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://omniroute:20128/api/settings");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ a2aEnabled: true }),
    }));
    const rpc = JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body));
    expect(rpc).toMatchObject({ method: "message/send", params: { skill: "smart-routing", metadata: { model: "auto" } } });
  });

  it("creates Pipeline/Fusion combos through OmniRoute and treats deterministic name conflicts as idempotent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "combo-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Combo name already exists" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128", apiKey: "secret" });
    const combo = { name: "npati/p/test", strategy: "pipeline" as const,
      models: [{ kind: "model" as const, model: "auto", prompt: "Worker instruction" }],
      config: { maxRetries: 2, failoverBeforeRetry: true } };
    await expect(engine.ensureCombo(combo)).resolves.toEqual({ name: combo.name });
    await expect(engine.ensureCombo(combo)).resolves.toEqual({ name: combo.name });
    expect(fetchMock).toHaveBeenCalledWith("http://omniroute:20128/api/combos", expect.objectContaining({
      method: "POST", body: JSON.stringify(combo),
    }));
  });

  it("discovers rerank models from the unified OmniRoute catalog", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "jina-ai/jina-reranker-v3", apiFormat: "rerank", supportedEndpoints: ["rerank"] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "jina-reranker-v3", results: [{ index: 1, relevance_score: 0.97 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128", apiKey: "secret" });
    await expect(engine.rerank!({ query: "support", documents: ["sales", "support hours"], topN: 1 })).resolves.toMatchObject({ results: [{ index: 1, relevanceScore: 0.97 }] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://omniroute:20128/api/v1/models");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://omniroute:20128/api/v1/rerank");
  });

});

describe("OmniRoute capability routing", () => {
  it("never sends an embedding to chat and skips an unsupported chat model", async () => {
    const requests: string[] = [];
    const providerFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/v1/models")) return new Response(JSON.stringify({ data: [
        { id: "provider/embedder", type: "embedding", supported_endpoints: ["/v1/embeddings"] },
        { id: "provider/unavailable", type: "chat", supported_endpoints: ["/v1/chat/completions"] },
        { id: "provider/working", type: "chat", supported_endpoints: ["/v1/chat/completions"] },
      ] }), { status: 200 });
      const model = JSON.parse(String(init?.body)).model as string;
      requests.push(model);
      if (model === "provider/unavailable") return new Response(JSON.stringify({ error: { message: "unsupported model" } }), { status: 404 });
      return new Response(JSON.stringify({ model, choices: [{ message: { content: "ready" } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", providerFetch);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    await expect(engine.chat({ model: "auto", messages: [{ role: "user", content: "build site" }] })).resolves.toMatchObject({ content: "ready", model: "provider/working" });
    expect(requests).toEqual(["provider/unavailable", "provider/working"]);
  });
});
