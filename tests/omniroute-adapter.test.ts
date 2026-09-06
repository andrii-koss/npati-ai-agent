import { OmniRouteEngine } from "@npati/omniroute-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("OmniRoute adapter", () => {
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

    await expect(engine.chat({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "Hello" }],
    })).resolves.toEqual({ content: "Hello from Luna", model: "gpt-5.6-luna" });

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

  it("falls back on quota failure and sends the compression policy", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "quota exhausted" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "gemini/free-model",
        choices: [{ message: { content: "Fallback worked" } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });

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
      body: JSON.stringify({ model: "auto/chat:free", messages: [{ role: "user", content: "Hello" }] }),
    }));
  });

  it("maps image attachments to Responses vision content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "gpt-5.6-luna",
      output_text: "A wooden chair",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });

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
