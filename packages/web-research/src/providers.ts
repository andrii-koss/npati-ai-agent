import type { OmniRouteEngine, WebPageResult, WebSearchResult } from "@npati/omniroute-adapter";
import { MemoryResearchCache, researchCacheKey, type ResearchCache } from "./cache";
import { SafeUrlValidator } from "./safe-url-validator";
import type {
  CrawlBatchInput, CrawlInput, CrawledPage, CrawlResult, FetchInput, SearchInput, WebResearchLimits,
} from "./types";

type Json = Record<string, unknown>;

/**
 * C5b: the seam the agent API injects so every outbound web request is inspected before it leaves NPATI.
 *
 * The package cannot import the API's policy store, so the port is deliberately narrow: the implementation
 * decides and throws on a refusal (`allow` returns normally). When no guard is injected the package behaves
 * as before — the only production composition (`createWebResearch` in the API) always injects one.
 */
export interface OutboundGuardInput {
  channel: "web_search" | "web_fetch" | "web_crawl";
  parts: Array<{ kind: "text" | "url" | "code" | "query" | "metadata"; value: string; label?: string }>;
  /** The tenant/project this request belongs to, when the caller knows it. */
  context?: { companyId?: string; projectId?: string; sessionId?: string; dataClassification?: string };
}

export interface OutboundGuardPort {
  assertOutboundAllowed(input: OutboundGuardInput): void;
}

function guardOutbound(guard: OutboundGuardPort | undefined, input: OutboundGuardInput): void {
  if (!guard) return;
  guard.assertOutboundAllowed(input);
}

function contentString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Json;
    for (const key of ["fit_markdown", "markdown_with_citations", "raw_markdown", "text", "content"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return undefined;
}

function crawlLinks(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) =>
    typeof item === "string" ? [item]
      : item && typeof item === "object" && typeof (item as Json).href === "string" ? [String((item as Json).href)]
        : []);
  if (value && typeof value === "object") return Object.values(value as Json).flatMap(crawlLinks);
  return [];
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
}

export class OmniRouteSearchProvider {
  constructor(private readonly engine: OmniRouteEngine, private readonly outboundGuard?: OutboundGuardPort) {}
  async search(input: SearchInput): Promise<WebSearchResult[]> {
    const country = input.country?.trim();
    // C5b: the query itself is outbound data — it can carry a fragment of the private code an agent is
    // looking up, so it is inspected before the engine forwards it to a search provider.
    guardOutbound(this.outboundGuard, {
      channel: "web_search",
      parts: [{ kind: "query", value: input.query, label: "search_query" }],
    });
    return (await this.engine.webSearch({
      query: input.query, maxResults: input.maxResults,
      country: country && /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : undefined,
      language: input.language, bypassCache: input.refresh,
    })).results;
  }
}

export class OmniRouteFetchProvider {
  constructor(
    private readonly engine: OmniRouteEngine,
    private readonly validator: SafeUrlValidator,
    private readonly outboundGuard?: OutboundGuardPort,
  ) {}
  async fetch(input: FetchInput): Promise<WebPageResult> {
    const safe = await this.validator.validate(input.url);
    guardOutbound(this.outboundGuard, {
      channel: "web_fetch",
      parts: [{ kind: "url", value: safe.toString(), label: "fetch_url" }],
    });
    const result = await this.engine.webFetch({ url: safe.toString(), format: "markdown", includeMetadata: true });
    await this.validator.validateRedirect(safe.toString(), result.finalUrl);
    return result;
  }
}

export class Crawl4AIProvider {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly domainLastRun = new Map<string, number>();

  constructor(
    private readonly baseUrl: string,
    private readonly validator: SafeUrlValidator,
    private readonly limits: WebResearchLimits,
    private readonly apiToken?: string,
    private readonly outboundGuard?: OutboundGuardPort,
  ) {}

  private headers(extra?: Record<string, string>) {
    return { ...extra, ...(this.apiToken ? { authorization: `Bearer ${this.apiToken}` } : {}) };
  }

  async healthCheck() {
    try {
      const response = await fetch(this.baseUrl.replace(/\/$/, "") + "/health", {
        headers: this.headers(), signal: AbortSignal.timeout(3_000),
      });
      return response.ok ? "ok" as const : "unavailable" as const;
    } catch { return "unavailable" as const; }
  }

  private async acquire() {
    if (this.active >= this.limits.maxConcurrentJobs) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release() {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  private async pace(hostnames: string[]) {
    const now = Date.now();
    const delay = Math.max(0, ...hostnames.map((hostname) =>
      this.limits.perDomainDelayMs - (now - (this.domainLastRun.get(hostname) ?? 0))));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    for (const hostname of hostnames) this.domainLastRun.set(hostname, Date.now());
  }

  private async crawlPage(url: string): Promise<CrawledPage> {
    const safe = await this.validator.validate(url);
    // C5b: the crawler is a separate service, so this request is outbound data even though it is "ours".
    guardOutbound(this.outboundGuard, {
      channel: "web_crawl",
      parts: [{ kind: "url", value: safe.toString(), label: "crawl_url" }],
    });
    await this.pace([safe.hostname]);
    await this.acquire();
    try {
      const response = await fetch(this.baseUrl.replace(/\/$/, "") + "/crawl", {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          urls: [safe.toString()],
          browser_config: { type: "BrowserConfig", params: { headless: true, text_mode: true, user_agent: "NPATI-Agent-WebResearch/0.2 (+https://www.npati.com/)" } },
          crawler_config: {
            type: "CrawlerRunConfig",
            params: {
              check_robots_txt: true,
              page_timeout: this.limits.timeoutMs,
              cache_mode: "enabled",
              exclude_all_images: true,
              remove_overlay_elements: true,
              remove_consent_popups: true,
            },
          },
        }),
        signal: AbortSignal.timeout(this.limits.timeoutMs),
      });
      if (!response.ok) throw new Error("Crawl4AI failed with HTTP " + response.status);
      const payload = await response.json() as unknown;
      const root = payload && typeof payload === "object" ? payload as Json : {};
      const rows = Array.isArray(root.results) ? root.results : Array.isArray(payload) ? payload : root.result ? [root.result] : [root];
      const row = (rows[0] ?? {}) as Json;
      const finalUrl = typeof row.url === "string" ? row.url : safe.toString();
      await this.validator.validateRedirect(safe.toString(), finalUrl);
      const markdown = contentString(row.markdown) ?? contentString(row.raw_markdown) ?? contentString(row.fit_markdown);
      const text = contentString(row.cleaned_html) ?? contentString(row.text) ?? contentString(row.description) ?? markdown;
      const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Json : {};
      return {
        url: finalUrl,
        title: typeof metadata.title === "string" ? metadata.title : (typeof row.title === "string" ? row.title : undefined),
        markdown: markdown?.slice(0, this.limits.maxContentCharacters),
        text: text?.slice(0, this.limits.maxContentCharacters),
        links: [...new Set(crawlLinks(row.links))],
      };
    } finally { this.release(); }
  }

  async fetch(input: FetchInput): Promise<WebPageResult> {
    const page = await this.crawlPage(input.url);
    return { ...page, finalUrl: page.url, fetchedAt: new Date().toISOString(), provider: "crawl4ai" };
  }

  private async advancedCrawl(input: CrawlBatchInput): Promise<CrawlResult> {
    const startedAt = new Date().toISOString();
    const safeUrls = await Promise.all(input.urls.map((url) => this.validator.validate(url)));
    // C5b: the advanced crawl ships the URLs **and the user's query** to the crawler service.
    guardOutbound(this.outboundGuard, {
      channel: "web_crawl",
      parts: [
        ...safeUrls.map((url, index) => ({ kind: "url" as const, value: url.toString(), label: `crawl_url_${index}` })),
        { kind: "query", value: input.query ?? "", label: "crawl_query" },
      ],
    });
    await this.pace(safeUrls.map((url) => url.hostname));
    await this.acquire();
    try {
      const response = await fetch(this.baseUrl.replace(/\/$/, "") + "/npati/crawl", {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          urls: safeUrls.map((url) => url.toString()),
          query: input.query ?? "",
          max_pages: Math.max(1, Math.min(input.maxPages ?? this.limits.maxPagesPerSite, this.limits.maxPagesPerSite)),
          max_depth: Math.max(0, Math.min(input.maxDepth ?? this.limits.maxCrawlDepth, this.limits.maxCrawlDepth)),
          deep: input.deep !== false,
          refresh: input.refresh === true,
          include_media: input.includeMedia === true,
          content_filter: input.contentFilter ?? "auto",
          extraction: input.extraction ? { strategy: input.extraction.strategy ?? "auto", schema: input.extraction.schema } : { strategy: "auto" },
          dynamic: input.dynamic ? {
            wait_for: input.dynamic.waitFor,
            scan_full_page: input.dynamic.scanFullPage,
            load_more: input.dynamic.loadMore,
            flatten_shadow_dom: input.dynamic.flattenShadowDom,
            session_id: input.dynamic.sessionId,
            max_scroll_steps: input.dynamic.maxScrollSteps,
          } : {},
          dispatcher: input.dispatcher ?? "memory",
          concurrency: Math.max(1, Math.min(input.concurrency ?? this.limits.maxConcurrentJobs, this.limits.maxConcurrentJobs)),
          resume: input.resume !== false,
        }),
        signal: AbortSignal.timeout(Math.max(this.limits.timeoutMs, this.limits.timeoutMs * safeUrls.length)),
      });
      const payload = await response.json().catch(() => ({})) as Json;
      if (!response.ok) {
        const detail = typeof payload.detail === "string" ? payload.detail : "Crawl4AI failed with HTTP " + response.status;
        throw new Error(detail);
      }
      const rows = Array.isArray(payload.pages) ? payload.pages as Json[] : [];
      const pages: CrawledPage[] = [];
      for (const row of rows) {
        const finalUrl = String(row.url ?? "");
        await this.validator.validate(finalUrl);
        const links = row.links && typeof row.links === "object" ? row.links as Json : {};
        const structured = row.structured && typeof row.structured === "object" ? row.structured as Json : {};
        const rawMd = typeof row.fit_markdown === "string" ? row.fit_markdown
          : typeof row.raw_markdown === "string" ? row.raw_markdown
          : typeof row.markdown === "string" ? row.markdown
          : undefined;
        const rawTxt = typeof row.text === "string" ? row.text
          : typeof row.description === "string" ? row.description
          : rawMd;
        pages.push({
          url: finalUrl,
          title: typeof row.title === "string" ? row.title : undefined,
          text: rawTxt ? rawTxt.slice(0, this.limits.maxContentCharacters) : undefined,
          markdown: rawMd ? rawMd.slice(0, this.limits.maxContentCharacters) : undefined,
          links: [...new Set(crawlLinks(links))],
          internalLinks: [...new Set(crawlLinks(links.internal))],
          externalLinks: [...new Set(crawlLinks(links.external))],
          media: row.media && typeof row.media === "object" ? {
            images: objectArray((row.media as Json).images),
            videos: objectArray((row.media as Json).videos),
            audio: objectArray((row.media as Json).audio),
          } : undefined,
          structured: {
            products: Array.isArray(structured.products) ? structured.products.map(String) : [],
            services: Array.isArray(structured.services) ? structured.services.map(String) : [],
            prices: Array.isArray(structured.prices) ? structured.prices.map(String) : [],
            positioning: Array.isArray(structured.positioning) ? structured.positioning.map(String) : [],
            audienceSignals: Array.isArray(structured.audience_signals) ? structured.audience_signals.map(String) : [],
            socialLinks: Array.isArray(structured.social_links) ? structured.social_links.map(String) : [],
            contacts: Array.isArray(structured.contacts) ? structured.contacts.map(String) : [],
            contentTopics: Array.isArray(structured.content_topics) ? structured.content_topics.map(String) : [],
            seoSignals: structured.seo_signals && typeof structured.seo_signals === "object" ? structured.seo_signals as Json : {},
          },
          extracted: row.extracted,
          depth: typeof row.depth === "number" ? row.depth : undefined,
          score: typeof row.score === "number" ? row.score : undefined,
        });
      }
      return {
        rootUrl: safeUrls[0]!.toString(),
        pages,
        startedAt,
        completedAt: new Date().toISOString(),
        dispatcher: payload.dispatcher === "semaphore" ? "semaphore" : "memory",
        cacheMode: payload.cache_mode === "bypass" ? "bypass" : "enabled",
        recovered: payload.recovered === true,
      };
    } finally { this.release(); }
  }

  async crawl(input: CrawlInput): Promise<CrawlResult> {
    return this.advancedCrawl({ ...input, urls: [input.url] });
  }

  async crawlMany(input: CrawlBatchInput): Promise<CrawlResult> {
    return this.advancedCrawl(input);
  }
}

export class DefaultWebResearchProvider {
  private readonly cache: ResearchCache;
  constructor(
    private readonly searchProvider: OmniRouteSearchProvider,
    private readonly fetchProvider: OmniRouteFetchProvider,
    private readonly crawler: Crawl4AIProvider | undefined,
    private readonly limits: WebResearchLimits,
    cache?: ResearchCache,
  ) { this.cache = cache ?? new MemoryResearchCache(); }

  async search(input: SearchInput) {
    const key = researchCacheKey("search", input);
    if (!input.refresh) { const cached = await this.cache.get<WebSearchResult[]>(key); if (cached) return cached; }
    const value = await this.searchProvider.search({ ...input, maxResults: Math.min(input.maxResults ?? this.limits.maxSearchResults, this.limits.maxSearchResults) });
    await this.cache.set(key, value, this.limits.cacheTtlSeconds);
    return value;
  }

  async fetch(input: FetchInput) {
    const key = researchCacheKey("fetch", input.url);
    if (!input.refresh) { const cached = await this.cache.get<WebPageResult>(key); if (cached) return cached; }
    let value: WebPageResult;
    try { value = await this.fetchProvider.fetch(input); }
    catch (error) {
      if (!this.crawler || await this.crawler.healthCheck() !== "ok") throw error;
      value = await this.crawler.fetch(input);
    }
    value.text = value.text?.slice(0, this.limits.maxContentCharacters);
    value.markdown = value.markdown?.slice(0, this.limits.maxContentCharacters);
    await this.cache.set(key, value, this.limits.cacheTtlSeconds);
    return value;
  }

  async crawl(input: CrawlInput) {
    const key = researchCacheKey("crawl", input);
    if (!input.refresh) { const cached = await this.cache.get<CrawlResult>(key); if (cached) return cached; }
    const value = this.crawler
      ? await this.crawler.crawl(input)
      : await this.fetchOnlyCrawl(input);
    await this.cache.set(key, value, this.limits.cacheTtlSeconds);
    return value;
  }

  async crawlMany(input: CrawlBatchInput) {
    const key = researchCacheKey("crawl-many", input);
    if (!input.refresh) { const cached = await this.cache.get<CrawlResult>(key); if (cached) return cached; }
    const value = this.crawler
      ? await this.crawler.crawlMany(input)
      : await this.fetchOnlyCrawl({ ...input, url: input.urls[0] ?? "" });
    await this.cache.set(key, value, this.limits.cacheTtlSeconds);
    return value;
  }

  private async fetchOnlyCrawl(input: CrawlInput): Promise<CrawlResult> {
    const startedAt = new Date().toISOString();
    const page = await this.fetchProvider.fetch({ url: input.url, refresh: input.refresh });
    return {
      rootUrl: page.finalUrl ?? page.url,
      pages: [{
        url: page.finalUrl ?? page.url,
        title: page.title,
        text: page.text?.slice(0, this.limits.maxContentCharacters),
        markdown: page.markdown?.slice(0, this.limits.maxContentCharacters),
        links: page.links,
        depth: 0,
      }],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}
