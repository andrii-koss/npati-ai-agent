import { OmniRouteError, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

function mockOmni(options: { valid?: boolean; healthValid?: boolean; connected?: boolean; models?: Array<Record<string, unknown>> } = {}) {
  const calls: Array<{ path: string; body?: string }> = [];
  const models = options.models ?? [{ id: "gpt-test", name: "GPT Test" }];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ path: url.pathname + url.search, body: typeof init?.body === "string" ? init.body : undefined });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v1/provider-plugin-manifest") return json({ providers: [{ id: "openai", auth: { type: "apikey" }, models }] });
    if (url.pathname === "/api/monitoring/health") return json({ version: "3.8.49", providerSummary: { catalogCount: 299 }, localProviders: {} });
    if (url.pathname === "/api/providers" && (!init?.method || init.method === "GET")) return json({ connections: options.connected ? [{ id: "c1", provider: "openai", isActive: true, testStatus: "active" }] : [] });
    if (url.pathname === "/api/providers/validate") return json({ valid: options.valid !== false, error: options.valid === false ? "Invalid API key" : null });
    if (url.pathname === "/api/providers" && init?.method === "POST") return json({ connection: { id: "c1", provider: "openai" } }, 201);
    if (url.pathname === "/api/providers/c1/test") return json({ valid: options.healthValid !== false, error: options.healthValid === false ? "Provider health check failed" : null });
    if (url.pathname === "/api/providers/c1" && init?.method === "DELETE") return json({ ok: true });
    if (url.pathname === "/api/providers/c1/models") return json({ provider: "openai", connectionId: "c1", source: "api", models });
    if (url.pathname === "/api/providers/c1/sync-models") return json({ ok: true, syncedModels: models.length, modelChanges: { added: 1, removed: 0, updated: 0 } });
    return json({ error: "Not found" }, 404);
  }));
  return calls;
}

describe("OmniRoute marketplace client", () => {
  it("proxies an actual provider icon asset without exposing OmniRoute to the browser", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>';
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/providers/openai.svg") return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
      return new Response("Not found", { status: 404 });
    }));

    const icon = await new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).providerIcon("openai");
    expect(icon.contentType).toBe("image/svg+xml");
    expect(new TextDecoder().decode(icon.body)).toBe(svg);
  });

  it("returns a safe metadata badge when OmniRoute has no static provider logo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", { status: 404 })));
    const icon = await new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).providerIcon("9router");
    const svg = new TextDecoder().decode(icon.body);
    expect(icon.contentType).toBe("image/svg+xml");
    expect(svg).toContain('data-fallback-icon="router"');
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("<text");
    expect(svg).not.toContain("<script");
  });

  it("uses the bundled Antigravity brand asset when the runtime has no remote logo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", { status: 404 })));
    const icon = await new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).providerIcon("agy");
    const svg = new TextDecoder().decode(icon.body);
    expect(icon.contentType).toBe("image/svg+xml");
    expect(svg).toContain('id="ag-mask"');
    expect(svg).not.toContain('data-fallback-icon="terminal"');
  });

  it("makes a white-only OmniRoute SVG visible on the light NPATI icon surface", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/providers/anthropic.svg") {
        return new Response('<svg xmlns="http://www.w3.org/2000/svg" fill="#ffff"><path d="M0 0h1v1z"/></svg>', { headers: { "content-type": "image/svg+xml" } });
      }
      return new Response("Not found", { status: 404 });
    }));
    const icon = await new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).providerIcon("anthropic");
    const svg = new TextDecoder().decode(icon.body);
    expect(svg).toContain('fill="#171717"');
    expect(svg).not.toContain('fill="#ffff"');
  });

  it("9. validates credentials before creating a connection", async () => {
    const calls = mockOmni({ valid: true });
    await expect(new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).connect("openai", { apiKey: "secret" })).resolves.toMatchObject({ connected: true });
    expect(calls.findIndex((call) => call.path === "/api/providers/validate")).toBeLessThan(calls.findIndex((call) => call.path === "/api/providers" && call.body !== undefined));
  });

  it("10. rejects invalid credentials without saving them", async () => {
    const calls = mockOmni({ valid: false });
    await expect(new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).connect("openai", { apiKey: "bad" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(calls.filter((call) => call.path === "/api/providers" && call.body !== undefined)).toHaveLength(0);
  });

  it("10a. rejects embedded services before calling the generic connection API", async () => {
    const calls = mockOmni();
    await expect(new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).connect("9router", {})).rejects.toMatchObject({
      code: "PROVIDER_SETUP_REQUIRED",
      status: 400,
    });
    expect(calls.filter((call) => call.path === "/api/providers" && call.body !== undefined)).toHaveLength(0);
  });

  it("10b. rolls back a newly created connection when its health check fails", async () => {
    const calls = mockOmni({ healthValid: false });
    await expect(new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).connect("openai", { apiKey: "secret" })).rejects.toMatchObject({
      code: "PROVIDER_TEST_FAILED",
      status: 502,
    });
    expect(calls.map((call) => call.path)).toContain("/api/providers/c1");
  });

  it("11. loads the provider-specific model catalog", async () => {
    mockOmni({ connected: true, models: [{ id: "live-model", name: "Live Model" }] });
    await expect(new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).models("openai")).resolves.toMatchObject([{ id: "openai/live-model" }]);
  });

  it("12. invokes actual model synchronization", async () => {
    const calls = mockOmni({ connected: true });
    await expect(new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).refreshModels("openai")).resolves.toMatchObject({ ok: true, syncedModels: 1 });
    expect(calls.some((call) => call.path === "/api/providers/c1/sync-models")).toBe(true);
  });

  it("18. maps an unavailable OmniRoute to a friendly service error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).marketplace()).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
  });

  it("19. handles an empty model catalog", async () => {
    mockOmni({ models: [] });
    await expect(new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).marketplace()).resolves.toMatchObject({ overview: { models: 0 } });
  });

  it("20. searches a large 5,000-model response without returning the full payload", async () => {
    const models = Array.from({ length: 5_000 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` }));
    mockOmni({ models });
    const result = await new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).marketplace({ search: "Model 4999", limit: 24 });
    expect(result.providers.map((provider) => provider.id)).toEqual(["openai"]);
    expect(result.overview.models).toBe(5_000);
  });

  it("21. keeps All count equal to the filtered pagination total", async () => {
    mockOmni();
    const result = await new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).marketplace({ tab: "all", connectableOnly: true });
    expect(result.counts.all).toBe(result.pagination.total);
    expect(result.providers[0]?.id).toBe("openai");
  });
});

it("keeps manifest capability metadata when a connection refresh lists only id and name (A040)", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v1/provider-plugin-manifest") return json({ providers: [{ id: "ollama-cloud", auth: { type: "apikey" },
      models: [{ id: "minimax-m3", name: "MiniMax M3", supportsVision: true }, { id: "gemma4:31b", name: "Gemma 4 31B" }] }] });
    if (url.pathname === "/api/monitoring/health") return json({ version: "3.8.49", providerSummary: { catalogCount: 1 }, localProviders: {} });
    if (url.pathname === "/api/providers" && (!init?.method || init.method === "GET")) return json({ connections: [{ id: "c1", provider: "ollama-cloud", isActive: true, testStatus: "active" }] });
    if (url.pathname === "/api/providers/c1/models") return json({ models: [{ id: "minimax-m3", name: "MiniMax M3" }, { id: "gemma4:31b", name: "Gemma 4 31B" }, { id: "new-model", name: "New" }] });
    return json({ error: "Not found" });
  }));
  const models = await new OmniRouteMarketplace({ baseUrl: "http://omniroute" }).models("ollama-cloud", [], true);
  expect(models.find((model) => model.id === "ollama-cloud/minimax-m3")?.capabilities).toContain("vision");
  expect(models.find((model) => model.id === "ollama-cloud/gemma4:31b")?.capabilities).not.toContain("vision");
  expect(models.map((model) => model.id)).toContain("ollama-cloud/new-model");
});
it("never installs a monthly allowance from legacy stop-paid preferences", async () => {
 const requests: Array<{path:string;body:Record<string,unknown>}> = [];
 vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  requests.push({path:url.pathname,body:JSON.parse(String(init?.body ?? "{}"))});
  return new Response(JSON.stringify({ok:true}), {headers:{"content-type":"application/json"}});
 }));
 await new OmniRouteMarketplace({baseUrl:"http://omniroute"}).configureRuntimePolicy({compression:"off",monthlyBudgetUsd:1,warningPercent:80,stopPaidWhenLimitReached:true});
 expect(requests.find(r=>r.path==="/api/usage/budget")?.body).toMatchObject({dailyLimitUsd:0,weeklyLimitUsd:0,monthlyLimitUsd:0});
});
