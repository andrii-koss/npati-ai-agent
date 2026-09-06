import { OmniRouteEngine } from "@npati/omniroute-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("OmniRoute Embeddings resilience and failure matrix (NPATI-004D)", () => {
  it("generates embeddings successfully with verified model discovery and vector ordering", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "openai/text-embedding-3-small", supportedEndpoints: ["embeddings"] }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "text-embedding-3-small",
        data: [
          { index: 1, embedding: [0.1, 0.2, 0.3] },
          { index: 0, embedding: [0.4, 0.5, 0.6] },
        ],
        usage: { prompt_tokens: 15, total_tokens: 15 },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128", apiKey: "secret" });
    const result = await engine.embed({
      input: ["First document chunk", "Second document chunk"],
    });

    expect(result.model).toBe("text-embedding-3-small");
    expect(result.vectors).toEqual([
      [0.4, 0.5, 0.6], // index 0 sorted first
      [0.1, 0.2, 0.3], // index 1 sorted second
    ]);
    expect(result.usage).toEqual({ prompt_tokens: 15, total_tokens: 15 });
  });

  it("handles provider timeout (504 Gateway Timeout) cleanly with structured error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "text-embedding-3-small", supportedEndpoints: ["embeddings"] }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Upstream provider timed out after 30s" },
      }), { status: 504, statusText: "Gateway Timeout" }));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    await expect(engine.embed({
      input: ["Heavy contract document chunk"],
    })).rejects.toThrow(/OmniRoute embeddings failed with HTTP 504/);
  });

  it("handles rate limiting (429 Too Many Requests) cleanly without crash", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "text-embedding-3-small", supportedEndpoints: ["embeddings"] }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Rate limit exceeded. Please retry after 10 seconds." },
      }), { status: 429, statusText: "Too Many Requests" }));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    await expect(engine.embed({
      input: ["Batch chunk 1"],
    })).rejects.toThrow(/OmniRoute embeddings failed with HTTP 429/);
  });

  it("handles provider internal failure (500 / 502 Bad Gateway)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "text-embedding-3-small", supportedEndpoints: ["embeddings"] }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 502, statusText: "Bad Gateway" }));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    await expect(engine.embed({
      input: ["Document chunk"],
    })).rejects.toThrow(/OmniRoute embeddings failed with HTTP 502/);
  });

  it("supports client request cancellation via AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();

    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128", embeddingModel: "text-embedding-3-small" });
    await expect(engine.embed({
      input: ["Test chunk"],
      signal: controller.signal,
    })).rejects.toThrow();
  });

  it("validates malformed responses and rejects missing or incomplete vector rows", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "text-embedding-3-small",
        data: [{ index: 0 }], // missing embedding array
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128", embeddingModel: "text-embedding-3-small" });
    await expect(engine.embed({
      input: ["Chunk 1", "Chunk 2"], // expects 2 rows, received 1 malformed row
    })).rejects.toThrow(/invalid embeddings response/);
  });
});
