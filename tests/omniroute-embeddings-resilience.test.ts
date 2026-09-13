import { OmniRouteEngine } from "@npati/omniroute-adapter";
import Fastify from "fastify";
import { registerAIRoutes } from "../apps/agent-api/src/ai-routes";
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

describe("OmniRoute Moderations production adapter", () => {
  it("uses the real moderation endpoint and preserves provider categories", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: "modr-live",
      model: "omni-moderation-latest",
      results: [{
        flagged: true,
        categories: { violence: true, hate: false },
        category_scores: { violence: 0.99, hate: 0.01 },
        category_applied_input_types: { violence: ["text"] },
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128", apiKey: "secret" });
    const result = await engine.moderate({ input: ["unsafe request"] });

    expect(fetchMock).toHaveBeenCalledWith("http://omniroute:20128/api/v1/moderations", expect.objectContaining({ method: "POST" }));
    expect(result.id).toBe("modr-live");
    expect(result.results[0]?.flagged).toBe(true);
    expect(result.results[0]?.categoryScores.violence).toBe(0.99);
  });

  it("rejects malformed provider responses instead of fabricating a result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 })));
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    await expect(engine.moderate({ input: ["one row required"] })).rejects.toThrow(/invalid moderations response/);
  });
});
describe("AI inference routes fail closed", () => {
  it("fails closed when production inference methods are absent", async () => {
    const app = Fastify();
    const auth = { authenticate: async () => ({ workspaceId: "ws-test", userId: "user-test", role: "owner", permissions: ["chat:use"] }) };
    registerAIRoutes(app, {} as never, {} as never, auth as never, {} as never);

    const embeddings = await app.inject({ method: "POST", url: "/ai/embeddings", payload: { input: "real vector required" } });
    expect(embeddings.statusCode).toBe(503);
    expect(embeddings.json().error.code).toBe("EMBEDDINGS_UNAVAILABLE");

    const moderation = await app.inject({ method: "POST", url: "/ai/moderations", payload: { input: "moderate this" } });
    expect(moderation.statusCode).toBe(503);
    expect(moderation.json().error.code).toBe("MODERATION_UNAVAILABLE");

    const rerank = await app.inject({ method: "POST", url: "/ai/rerank", payload: { query: "refund", documents: ["refund policy"] } });
    expect(rerank.statusCode).toBe(503);
    expect(rerank.json().error.code).toBe("RERANK_UNAVAILABLE");
    await app.close();
  });
});