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
});
