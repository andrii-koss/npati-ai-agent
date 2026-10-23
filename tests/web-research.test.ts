import { OmniRouteEngine } from "@npati/omniroute-adapter";
import {
  Crawl4AIProvider,
  DefaultWebResearchProvider,
  MemoryResearchCache,
  OmniRouteFetchProvider,
  OmniRouteSearchProvider,
  SafeUrlValidator,
  UnsafeUrlError,
  WebResearchService,
  InMemoryResearchJobStore,
  researchCacheKey,
  type WebResearchLimits,
} from "@npati/web-research";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

const limits: WebResearchLimits = {
  maxSearchResults: 10,
  maxCompetitors: 5,
  maxPagesPerSite: 5,
  maxCrawlDepth: 2,
  timeoutMs: 5_000,
  maxConcurrentJobs: 2,
  cacheTtlSeconds: 600,
  maxContentCharacters: 20_000,
  perDomainDelayMs: 1,
};

describe("SafeUrlValidator", () => {
  const validator = new SafeUrlValidator();
  it.each([
    "http://127.0.0.1",
    "http://10.1.2.3",
    "http://172.20.0.2",
    "http://192.168.1.2",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]",
    "http://host.docker.internal",
    "http://omniroute:20128",
    "file:///etc/passwd",
    "ftp://example.com/file",
  ])("blocks unsafe target %s", async (url) => {
    await expect(validator.validate(url)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("accepts a literal public web IP", async () => {
    await expect(validator.validate("https://93.184.216.34/")).resolves.toBeInstanceOf(URL);
  });

  it("blocks a safe-looking URL whose final redirect is private", async () => {
    await expect(validator.validateRedirect("https://93.184.216.34/", "http://127.0.0.1/admin")).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe("OmniRoute web normalization", () => {
  it("normalizes search results and citations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      provider: "duckduckgo-free",
      query: "candles",
      cached: false,
      results: [{ title: "Candle Co", url: "https://candles.example/", snippet: "Soy candles", position: 1, published_at: "2026-01-01", citation: { provider: "duckduckgo-free", retrieved_at: "2026-08-26T00:00:00Z" } }],
    }), { status: 200 })));
    const result = await new OmniRouteEngine({ baseUrl: "http://omniroute:20128" }).webSearch({ query: "candles" });
    expect(result.results[0]).toMatchObject({ title: "Candle Co", source: "duckduckgo-free", publishedAt: "2026-01-01" });
  });

  it("normalizes fetched markdown and metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      provider: "jina-reader", url: "https://example.com/", content: "# Example", links: ["https://example.com/pricing"],
      metadata: { title: "Example", description: "Public page" }, screenshot_url: null,
    }), { status: 200 })));
    const result = await new OmniRouteEngine({ baseUrl: "http://omniroute:20128" }).webFetch({ url: "https://example.com/" });
    expect(result).toMatchObject({ title: "Example", markdown: "# Example", provider: "jina-reader" });
  });

  it("opens a URL through OmniRoute when Crawl4AI is not configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      provider: "jina-reader",
      url: "https://93.184.216.34/",
      content: "Verified public page body",
      links: ["https://93.184.216.34/pricing"],
      metadata: { title: "Public page" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new OmniRouteEngine({ baseUrl: "http://omniroute:20128" });
    const provider = new DefaultWebResearchProvider(
      new OmniRouteSearchProvider(engine),
      new OmniRouteFetchProvider(engine, new SafeUrlValidator()),
      undefined,
      limits,
    );

    const result = await provider.crawl({ url: "https://93.184.216.34/", deep: true });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({ title: "Public page", markdown: "Verified public page body", depth: 0 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/web/fetch");
  });

  it("surfaces normalized upstream errors without stack traces", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "No credentials configured" } }), { status: 400 })));
    await expect(new OmniRouteEngine({ baseUrl: "http://omniroute:20128" }).webSearch({ query: "test" })).rejects.toThrow("No credentials configured");
  });

  it("omits a full country name that OmniRoute would reject as a non-ISO code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      provider: "duckduckgo-free", query: "NPATI", results: [],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OmniRouteSearchProvider(new OmniRouteEngine({ baseUrl: "http://omniroute:20128" }));
    await provider.search({ query: "NPATI", country: "Україна" });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).not.toHaveProperty("country");
  });
});

describe("research cache", () => {
  it("stores values with TTL and supports explicit deletion", async () => {
    const cache = new MemoryResearchCache();
    const key = researchCacheKey("search", { query: "x" });
    await cache.set(key, ["value"], 60);
    await expect(cache.get(key)).resolves.toEqual(["value"]);
    await cache.delete(key);
    await expect(cache.get(key)).resolves.toBeUndefined();
  });
});

describe("research job isolation", () => {
  it("does not expose jobs across workspaces or businesses", async () => {
    const store = new InMemoryResearchJobStore();
    const owner = { workspaceId: "workspace-a", businessId: "business-a", userId: "user-a" };
    const job = await store.create({ ...owner, type: "crawl", input: { url: "https://example.com" } });
    await expect(store.get(owner, job.id)).resolves.toMatchObject({ status: "queued" });
    await expect(store.get({ ...owner, workspaceId: "workspace-b" }, job.id)).resolves.toBeUndefined();
    await expect(store.get({ ...owner, businessId: "business-b" }, job.id)).resolves.toBeUndefined();
    await expect(store.update(owner, job.id, { status: "running" })).resolves.toMatchObject({ status: "running" });
    await expect(store.update(owner, job.id, { status: "completed", resultSummary: "done" })).resolves.toMatchObject({ status: "completed", resultSummary: "done" });
  });
});

describe("Crawl4AI normalization and degradation", () => {
  it("normalizes a Crawl4AI result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      pages: [{
        url: "https://93.184.216.34/", title: "Public", fit_markdown: "# Public",
        links: { internal: [], external: [] }, media: {},
        structured: { products: ["Reusable bottle"], services: [], prices: ["$12"], social_links: [], content_topics: ["Products"], seo_signals: { title: "Public" } },
        depth: 0, score: 1,
      }],
      dispatcher: "memory", cache_mode: "enabled", recovered: false,
    }), { status: 200 })));
    const crawler = new Crawl4AIProvider("http://crawler:11235", new SafeUrlValidator(), limits);
    const result = await crawler.crawl({ url: "https://93.184.216.34/", maxPages: 1 });
    expect(result.pages[0]).toMatchObject({ title: "Public", markdown: "# Public", structured: { products: ["Reusable bottle"], prices: ["$12"] } });
  });

  it("passes filtering, extraction, dynamic rendering, media, dispatcher, cache bypass, and recovery options", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      pages: [{ url: "https://93.184.216.34/", fit_markdown: "# Product", links: {}, media: { images: [{ src: "https://93.184.216.34/a.jpg" }] }, structured: {}, extracted: [{ name: "Desk" }] }],
      dispatcher: "semaphore", cache_mode: "bypass", recovered: true,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const crawler = new Crawl4AIProvider("http://crawler:11235", new SafeUrlValidator(), limits);
    const result = await crawler.crawl({
      url: "https://93.184.216.34/", query: "desk pricing", deep: true, refresh: true,
      contentFilter: "bm25", includeMedia: true, dispatcher: "semaphore", concurrency: 2, resume: true,
      extraction: { strategy: "css", schema: { name: "Products", baseSelector: ".product", fields: [] } },
      dynamic: { waitFor: "css:.product", scanFullPage: true, loadMore: true, flattenShadowDom: true, sessionId: "research-1" },
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      content_filter: "bm25", refresh: true, include_media: true, dispatcher: "semaphore", concurrency: 2, resume: true,
      extraction: { strategy: "css" },
      dynamic: { wait_for: "css:.product", scan_full_page: true, load_more: true, flatten_shadow_dom: true, session_id: "research-1" },
    });
    expect(result).toMatchObject({ dispatcher: "semaphore", cacheMode: "bypass", recovered: true });
    expect(result.pages[0]?.extracted).toEqual([{ name: "Desk" }]);
    expect(result.pages[0]?.media?.images).toHaveLength(1);
  });
  it("reports crawler unavailability", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(new Crawl4AIProvider("http://crawler:11235", new SafeUrlValidator(), limits).healthCheck()).resolves.toBe("unavailable");
  });
});

describe("competitor discovery", () => {
  it("deduplicates domains and keeps business-aware candidates with sources", async () => {
    const provider = {
      search: vi.fn().mockResolvedValue([
        { title: "Eco Store", url: "https://eco.example/products", snippet: "eco bottles Ukraine", position: 1 },
        { title: "Eco Store Blog", url: "https://eco.example/blog", snippet: "eco store", position: 2 },
        { title: "Unrelated", url: "https://cars.example/", snippet: "cars", position: 3 },
      ]),
      fetch: vi.fn().mockResolvedValue({ url: "https://eco.example/products", finalUrl: "https://eco.example/products", title: "Eco Store", description: "Reusable bottles", fetchedAt: new Date().toISOString() }),
      crawl: vi.fn(),
    };
    const service = new WebResearchService(provider, { validate: async (url: string) => new URL(url) } as SafeUrlValidator, limits);
    const outcome = await service.run("Find competitors for my business", { productsServicesSummary: "eco bottles", country: "Ukraine" });
    expect(outcome?.kind).toBe("competitor_analysis");
    expect(outcome?.sources).toHaveLength(1);
    expect(outcome?.context).toContain("Current business");
  });

  it("uses a URL directly without competitor discovery", async () => {
    const provider = {
      search: vi.fn(),
      fetch: vi.fn().mockResolvedValue({ url: "https://example.com/", finalUrl: "https://example.com/", title: "Example", markdown: "# Example", fetchedAt: "" }),
      crawl: vi.fn().mockResolvedValue({ rootUrl: "https://example.com/", startedAt: "", completedAt: "", pages: [{ url: "https://example.com/", title: "Example", markdown: "# Example" }] }),
    };
    const service = new WebResearchService(provider, { validate: async (url: string) => new URL(url) } as SafeUrlValidator, limits);
    const outcome = await service.run("Analyze https://example.com", { name: "My Business" });
    expect(outcome?.kind).toBe("url_analysis");
    expect(provider.search).not.toHaveBeenCalled();
    expect(provider.crawl).toHaveBeenCalledWith(expect.objectContaining({ deep: true, maxDepth: 2, contentFilter: "auto", dispatcher: "memory", resume: true }));
    expect(outcome?.sources[0]?.url).toBe("https://example.com/");
  });

  it("reports crawler error pages as failed instead of analysed sources", async () => {
    const provider = {
      search: vi.fn(),
      fetch: vi.fn(),
      crawl: vi.fn().mockResolvedValue({
        rootUrl: "https://example.com/",
        startedAt: "",
        completedAt: "",
        pages: [
          { url: "https://example.com/", title: "Example", markdown: "# Example" },
          { url: "https://example.com/limited", title: "429 Too Many Requests", markdown: "Rate limited" },
        ],
      }),
    };
    const events: Array<{ type: string; title?: string }> = [];
    const service = new WebResearchService(provider, { validate: async (url: string) => new URL(url) } as SafeUrlValidator, limits);
    const outcome = await service.run("Analyze https://example.com", {}, false, (event) => events.push(event));

    expect(outcome?.sources.map((item) => item.url)).toEqual(["https://example.com/"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "page_fetch_failed", title: "429 Too Many Requests" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "page_fetch_completed", title: "429 Too Many Requests" }));
  });

  it("uses the user's subject for general research instead of replacing it with the current business", async () => {
    const provider = {
      search: vi.fn().mockResolvedValue([
        { title: "NPATI", url: "https://www.npati.com/", snippet: "Marketplace", position: 1 },
        { title: "NPATI Blog", url: "https://en.npati.com/", snippet: "Guides and tips", position: 2 },
      ]),
      fetch: vi.fn(),
      crawl: vi.fn(),
      crawlMany: vi.fn().mockResolvedValue({
        rootUrl: "https://www.npati.com/", startedAt: "", completedAt: "",
        pages: [
          { url: "https://www.npati.com/", title: "NPATI", markdown: "Footer: Blog https://en.npati.com/" },
          { url: "https://en.npati.com/", title: "NPATI Blog", markdown: "Guides and tips for sellers and buyers" },
        ],
      }),
    };
    const service = new WebResearchService(provider, { validate: async (url: string) => new URL(url) } as SafeUrlValidator, limits);
    const message = "у футері NPATI є посилання на блог? якщо є то проаналізуй блог";
    const progress: string[] = [];
    const outcome = await service.run(message, { name: "New Business Idea", productsServicesSummary: "Айфони", country: "Україна" }, false, (event) => progress.push(event.type));
    expect(provider.search).toHaveBeenCalledWith(expect.objectContaining({ query: "NPATI official website blog" }));
    expect(outcome?.kind).toBe("web_search");
    expect(outcome?.context).toContain("NPATI Blog");
    expect(outcome?.context).not.toContain("competitors companies");
    expect(outcome?.sources).toHaveLength(2);
    expect(progress).toEqual([
      "search_started",
      "search_results_received",
      "source_discovered",
      "source_discovered",
      "page_fetch_started",
      "page_fetch_started",
      "page_fetch_completed",
      "page_fetch_completed",
      "research_completed",
    ]);
  });

  it("extracts a title-case brand from a natural-language research request", async () => {
    const provider = {
      search: vi.fn().mockResolvedValue([]),
      fetch: vi.fn(),
      crawl: vi.fn(),
    };
    const service = new WebResearchService(provider, { validate: async (url: string) => new URL(url) } as SafeUrlValidator, limits);
    await service.run("Проаналізуй бренд Hostkoss і сайти, які до нього належать", {});
    expect(provider.search).toHaveBeenCalledWith(expect.objectContaining({ query: "Hostkoss official website" }));
  });

  it("isolates the current business context in each analysis", async () => {
    const provider = {
      search: vi.fn().mockResolvedValue([{ title: "Store", url: "https://store.example/", snippet: "candles tables", position: 1 }]),
      fetch: vi.fn().mockResolvedValue({ url: "https://store.example/", title: "Store", description: "Products", fetchedAt: "" }),
      crawl: vi.fn(),
    };
    const service = new WebResearchService(provider, { validate: async (url: string) => new URL(url) } as SafeUrlValidator, limits);
    const candle = await service.run("Find competitors", { name: "Candle A", productsServicesSummary: "candles" });
    const table = await service.run("Find competitors", { name: "Table B", productsServicesSummary: "tables" });
    expect(candle?.context).toContain("Candle A");
    expect(candle?.context).not.toContain("Table B");
    expect(table?.context).toContain("Table B");
  });

  it("analyzes domain directly without protocol, e.g. Analyze site hostkoss.com", async () => {
    const provider = {
      search: vi.fn(),
      fetch: vi.fn(),
      crawl: vi.fn().mockResolvedValue({
        rootUrl: "https://hostkoss.com/",
        startedAt: "",
        completedAt: "",
        pages: [
          { url: "https://hostkoss.com/", title: "Hostkoss - Хостинг", markdown: "# Hostkoss Hosting" },
          { url: "https://hostkoss.com/vps", title: "Hostkoss VPS", markdown: "# VPS Servers" },
        ],
      }),
    };
    const service = new WebResearchService(provider, { validate: async (url: string) => new URL(url) } as SafeUrlValidator, limits);
    const outcome = await service.run("Analyze site hostkoss.com", {});
    expect(outcome?.kind).toBe("url_analysis");
    expect(provider.search).not.toHaveBeenCalled();
    expect(provider.crawl).toHaveBeenCalledWith(expect.objectContaining({ url: "https://hostkoss.com/" }));
    expect(outcome?.sources.map((s) => s.url)).toEqual(["https://hostkoss.com/", "https://hostkoss.com/vps"]);
    expect(outcome?.context).toContain("Research target: hostkoss.com");
  });

  it("resolves and analyzes official website for brand name e.g. Analyze site hostkoss", async () => {
    const provider = {
      search: vi.fn().mockResolvedValue([
        { url: "https://sitechecker.pro/analyze/hostkoss.com", title: "Analyze site hostkoss", snippet: "SEO tool" },
        { url: "https://hostkoss.com/", title: "Hostkoss - Хостинг", snippet: "Надійний хостинг" },
        { url: "https://twitter.com/hostkoss", title: "Hostkoss Twitter", snippet: "Social" },
      ]),
      fetch: vi.fn(),
      crawl: vi.fn().mockResolvedValue({
        rootUrl: "https://hostkoss.com/",
        startedAt: "",
        completedAt: "",
        pages: [
          { url: "https://hostkoss.com/", title: "Hostkoss - Хостинг", markdown: "# Hostkoss Hosting" },
        ],
      }),
    };
    const service = new WebResearchService(provider, { validate: async (url: string) => new URL(url) } as SafeUrlValidator, limits);
    const outcome = await service.run("Analyze site hostkoss", {});
    expect(provider.search).toHaveBeenCalledWith(expect.objectContaining({ query: "hostkoss official website" }));
    expect(provider.crawl).toHaveBeenCalledWith(expect.objectContaining({ url: "https://hostkoss.com/" }));
    expect(outcome?.kind).toBe("url_analysis");
    expect(outcome?.sources[0]?.url).toBe("https://hostkoss.com/");
    expect(outcome?.context).toContain("Research target: hostkoss.com");
    // Crucial: Ensure sitechecker.pro was NOT crawled!
    expect(outcome?.sources.some((s) => s.url.includes("sitechecker.pro"))).toBe(false);
  });

  it("resolves and analyzes official website for Ukrainian query e.g. проаналізуй сайт hostkoss", async () => {
    const provider = {
      search: vi.fn().mockResolvedValue([
        { url: "https://hostkoss.com/", title: "Hostkoss", snippet: "Хостинг провайдер" },
      ]),
      fetch: vi.fn(),
      crawl: vi.fn().mockResolvedValue({
        rootUrl: "https://hostkoss.com/",
        startedAt: "",
        completedAt: "",
        pages: [
          { url: "https://hostkoss.com/", title: "Hostkoss", markdown: "# Hostkoss" },
        ],
      }),
    };
    const service = new WebResearchService(provider, { validate: async (url: string) => new URL(url) } as SafeUrlValidator, limits);
    const outcome = await service.run("проаналізуй сайт hostkoss", {});
    expect(provider.search).toHaveBeenCalledWith(expect.objectContaining({ query: "hostkoss official website" }));
    expect(provider.crawl).toHaveBeenCalledWith(expect.objectContaining({ url: "https://hostkoss.com/" }));
    expect(outcome?.kind).toBe("url_analysis");
    expect(outcome?.sources[0]?.url).toBe("https://hostkoss.com/");
  });
});

describe("an explicit web_search call is a search", () => {
  it("does not turn a framework name in the query into an official-site lookup", async () => {
    const provider = {
      search: vi.fn().mockResolvedValue([{ title: "Shop A", url: "https://shop-a.example/", snippet: "Home goods store", position: 1 }]),
      fetch: vi.fn(),
      crawl: vi.fn(),
      crawlMany: vi.fn().mockResolvedValue({ pages: [{ url: "https://shop-a.example/", title: "Shop A", markdown: "# Shop A" }] }),
    };
    const service = new WebResearchService(provider as never, { validate: async (url: string) => new URL(url) } as SafeUrlValidator, limits);
    const outcome = await service.run("online stores similar to my Next.js shop design", {}, false, undefined, { mode: "search" });
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(provider.search.mock.calls[0]?.[0]?.query).not.toMatch(/official website/);
    expect(outcome?.sources.map((source) => source.url)).toContain("https://shop-a.example/");
  });
});

describe("explicit multi-site research", () => {
  const validator = { validate: vi.fn(async (url: string) => { if (url.includes("127.0.0.1")) throw new UnsafeUrlError("Blocked target"); return new URL(url); }) } as unknown as SafeUrlValidator;
  function provider() { return { search: vi.fn(), fetch: vi.fn(), crawl: vi.fn(async ({url}: {url: string}) => ({rootUrl:url,startedAt:"",completedAt:"",pages:[{url,title:new URL(url).hostname,text:"Verified public page with navigation and products."}]})) }; }
  it("normalizes punctuation and retrieves every distinct requested site", async () => {
    const p=provider(); const service=new WebResearchService(p,validator,limits);
    const result=await service.run("Compare https://www.apple.com, https://www.samsung.com; and https://store.google.com. Also https://www.apple.com",{});
    expect(p.crawl).toHaveBeenCalledTimes(3);
    expect(result?.sources.map(s=>new URL(s.url).hostname).sort()).toEqual(["store.google.com","www.apple.com","www.samsung.com"]);
    expect(result?.degraded).toBeUndefined();
  });
  it("refuses the complete batch before provider dispatch when one target is unsafe", async () => {
    const p=provider();const service=new WebResearchService(p,validator,limits);
    await expect(service.run("Compare https://www.apple.com and http://127.0.0.1/admin",{})).rejects.toThrow("Blocked target");
    expect(p.crawl).not.toHaveBeenCalled();expect(p.fetch).not.toHaveBeenCalled();
  });
  it("reports partial retrieval instead of inventing missing sources", async () => {
    const p=provider();p.crawl.mockRejectedValueOnce(new Error("Crawler unavailable"));p.fetch.mockRejectedValueOnce(new Error("Fetch unavailable"));
    const result=await new WebResearchService(p,validator,limits).run("Compare https://www.apple.com, https://www.samsung.com",{});
    expect(result?.sources).toHaveLength(1);expect(result?.degraded).toContain("retrieval failed");expect(result?.context).toContain("Incomplete coverage");
  });
  it("preserves the configured target bound before provider calls", async () => {
    const p=provider();const service=new WebResearchService(p,validator,{...limits,maxCompetitors:1});
    await expect(service.run("Compare https://www.apple.com and https://www.samsung.com",{})).rejects.toThrow("site limit");expect(p.crawl).not.toHaveBeenCalled();
  });
});
