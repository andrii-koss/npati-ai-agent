import type { SafeUrlValidator } from "./safe-url-validator";
import type {
  BusinessResearchContext, CompetitorResearchResult, CrawledPage, ResearchOutcome,
  ResearchProgressListener, ResearchSource, WebResearchLimits, WebResearchProvider,
} from "./types";

const URL_PATTERN = /https?:\/\/[^\s<>()]+/i;
const RESEARCH_PATTERN = /\b(competitor|competitors|competition|market research|web research|research online|search the web|find companies|who sells|analy[sz]e)\b|\u043a\u043e\u043d\u043a\u0443\u0440\u0435\u043d\u0442|\u0434\u043e\u0441\u043b\u0456\u0434|\u0430\u043d\u0430\u043b\u0456\u0437|\u0437\u043d\u0430\u0439\u0434\u0438/iu;
const COMPETITOR_PATTERN = /\b(competitor|competitors|competition|find companies|who sells)\b|\u043a\u043e\u043d\u043a\u0443\u0440\u0435\u043d\u0442/iu;
const LIGHT_FETCH_PATTERN = /\b(read|open|fetch|summarize this page)\b|\u043f\u0440\u043e\u0447\u0438\u0442\u0430\u0439|\u0432\u0456\u0434\u043a\u0440\u0438\u0439|\u043a\u043e\u0440\u043e\u0442\u043a\u043e/iu;

function keywords(context: BusinessResearchContext) {
  return [context.businessType, context.industry, context.niche, context.productsServicesSummary, context.description]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 3)
    .slice(0, 16);
}

function hostname(value: string) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generalSearchQuery(message: string) {
  const ignored = new Set(["analyze", "analyse", "find", "search", "research", "review", "check", "detail", "detailed"]);
  const entities = unique(
    (message.match(/\b[A-Z][A-Za-z0-9.-]{2,}\b/g) ?? []).filter((value) => !ignored.has(value.toLowerCase())),
    5,
  );
  const intent = /\bblog\b|\u0431\u043b\u043e\u0433/iu.test(message) ? "official website blog" : "official website";
  return {
    query: entities.length ? [entities.join(" "), intent].join(" ") : message.trim().slice(0, 500),
    entities: entities.map((entity) => entity.toLowerCase()),
  };
}

function source(url: string, title?: string): ResearchSource {
  return { url, title, accessedAt: new Date().toISOString() };
}

function unique(values: Array<string | undefined>, limit = 50) {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))].slice(0, limit);
}

function structuredValues(pages: CrawledPage[], key: keyof NonNullable<CrawledPage["structured"]>) {
  return unique(pages.flatMap((page) => {
    const value = page.structured?.[key];
    return Array.isArray(value) ? value.map(String) : [];
  }));
}

function researchQuery(business: BusinessResearchContext, extra = "") {
  return [
    business.productsServicesSummary, business.niche, business.industry, business.country || business.market,
    "products services pricing positioning target audience social links content topics SEO", extra,
  ].filter(Boolean).join(" ");
}

function pageEvidence(page: CrawledPage, perPage: number) {
  return [
    `SOURCE ${page.url}`,
    page.title ? `Title: ${page.title}` : "",
    page.structured ? `Structured signals: ${JSON.stringify(page.structured)}` : "",
    (page.markdown || page.text || "").slice(0, perPage),
  ].filter(Boolean).join("\n");
}

function report(listener: ResearchProgressListener | undefined, event: Parameters<ResearchProgressListener>[0]) {
  listener?.(event);
}

function pageFailure(page: CrawledPage) {
  const title = page.title?.trim() ?? "";
  if (/^(?:4\d\d|5\d\d)\b/i.test(title) || /\b(?:too many requests|access denied|forbidden|service unavailable)\b/i.test(title)) {
    return title || "The server returned an error page.";
  }
  return undefined;
}

function reportCrawledPages(pages: CrawledPage[], progress?: ResearchProgressListener) {
  const usable: CrawledPage[] = [];
  for (const page of pages) {
    const error = pageFailure(page);
    if (error) {
      report(progress, { type: "page_fetch_failed", url: page.url, domain: hostname(page.url), title: page.title, error });
    } else {
      usable.push(page);
      report(progress, { type: "page_fetch_completed", url: page.url, domain: hostname(page.url), title: page.title });
    }
  }
  return usable;
}

export class WebResearchService {
  constructor(
    private readonly provider: WebResearchProvider,
    private readonly validator: SafeUrlValidator,
    private readonly limits: WebResearchLimits,
  ) {}

  shouldResearch(message: string) {
    return URL_PATTERN.test(message) || RESEARCH_PATTERN.test(message);
  }

  async run(message: string, business: BusinessResearchContext, refresh = false, progress?: ResearchProgressListener): Promise<ResearchOutcome | null> {
    const url = message.match(URL_PATTERN)?.[0]?.replace(/[.,;!?]+$/, "");
    if (url) {
      const explicitlyLight = LIGHT_FETCH_PATTERN.test(message) && !RESEARCH_PATTERN.test(message);
      return this.analyzeUrl(url, business, refresh, !explicitlyLight, progress);
    }
    if (!RESEARCH_PATTERN.test(message)) return null;
    return COMPETITOR_PATTERN.test(message)
      ? this.analyzeCompetitors(business, refresh, progress)
      : this.analyzeSearch(message, business, refresh, progress);
  }

  private async analyzeUrl(url: string, business: BusinessResearchContext, refresh: boolean, deep: boolean, progress?: ResearchProgressListener): Promise<ResearchOutcome> {
    const safe = await this.validator.validate(url);
    report(progress, { type: "source_discovered", url: safe.toString(), title: safe.hostname });
    report(progress, { type: "page_fetch_started", url: safe.toString(), domain: safe.hostname });
    let pages: CrawledPage[];
    let degraded: string | undefined;
    if (!deep) {
      const page = await this.provider.fetch({ url: safe.toString(), refresh });
      pages = [{ url: page.finalUrl ?? page.url, title: page.title, text: page.text, markdown: page.markdown, links: page.links }];
    } else {
      try {
        const crawl = await this.provider.crawl({
          url: safe.toString(),
          query: researchQuery(business, safe.hostname),
          maxPages: this.limits.maxPagesPerSite,
          maxDepth: this.limits.maxCrawlDepth,
          refresh,
          deep: true,
          contentFilter: "auto",
          extraction: { strategy: "auto" },
          dynamic: { scanFullPage: true, flattenShadowDom: true, maxScrollSteps: 8 },
          dispatcher: "memory",
          concurrency: this.limits.maxConcurrentJobs,
          resume: true,
          includeMedia: false,
        });
        pages = crawl.pages;
      } catch {
        const page = await this.provider.fetch({ url: safe.toString(), refresh });
        pages = [{ url: page.finalUrl ?? page.url, title: page.title, text: page.text, markdown: page.markdown, links: page.links }];
        degraded = "Deep crawling was unavailable, so this analysis uses a single fetched page.";
      }
    }
    pages = reportCrawledPages(pages, progress);
    const sources = pages.map((page) => source(page.url, page.title));
    const contextBudget = Math.min(this.limits.maxContentCharacters, 36_000);
    const perPage = Math.max(1_000, Math.floor(contextBudget / Math.max(1, pages.length)));
    const context = [
      "Research target: " + safe.hostname,
      "Current business for comparison: " + JSON.stringify(business),
      "Crawl coverage: " + pages.length + " public pages.",
      ...pages.map((page) => pageEvidence(page, perPage)),
    ].join("\n\n");
    report(progress, { type: "research_completed", sourceCount: sources.length, pageCount: pages.length });
    return { kind: "url_analysis", context, sources, degraded };
  }

  private async analyzeCompetitors(business: BusinessResearchContext, refresh: boolean, progress?: ResearchProgressListener): Promise<ResearchOutcome> {
    const subject = business.productsServicesSummary || business.niche || business.industry || business.businessType || business.description;
    if (!subject) throw new Error("Add a product, service, niche, or industry to the current Business before competitor discovery.");
    const query = [subject, business.country || business.market, "competitors companies"].filter(Boolean).join(" ");
    report(progress, { type: "search_started", query });
    const results = await this.provider.search({ query, maxResults: this.limits.maxSearchResults, country: business.country, refresh });
    report(progress, { type: "search_results_received", query, resultCount: results.length });
    const terms = keywords(business);
    const ranked = results
      .map((item) => ({
        domain: hostname(item.url),
        item,
        score: terms.reduce((score, term) =>
          score + ((item.title + " " + (item.snippet ?? "")).toLowerCase().includes(term) ? 1 : 0), 0),
      }))
      .filter((item) => Boolean(item.domain))
      .sort((left, right) => right.score - left.score || (left.item.position ?? 99) - (right.item.position ?? 99));
    const candidates = ranked
      .filter((item, index) => ranked.findIndex((candidate) => candidate.domain === item.domain) === index)
      .filter((item) => item.score > 0 || terms.length === 0)
      .slice(0, this.limits.maxCompetitors);
    for (const candidate of candidates) report(progress, { type: "source_discovered", url: candidate.item.url, title: candidate.item.title });

    const pagesByDomain = new Map<string, CrawledPage[]>();
    let degraded: string | undefined;
    if (candidates.length && this.provider.crawlMany) {
      try {
        for (const candidate of candidates) report(progress, { type: "page_fetch_started", url: candidate.item.url, domain: candidate.domain, title: candidate.item.title });
        const crawl = await this.provider.crawlMany({
          urls: candidates.map((candidate) => candidate.item.url),
          query: researchQuery(business, query),
          maxPages: this.limits.maxPagesPerSite,
          maxDepth: this.limits.maxCrawlDepth,
          refresh,
          deep: true,
          contentFilter: "auto",
          extraction: { strategy: "auto" },
          dynamic: { scanFullPage: true, flattenShadowDom: true, maxScrollSteps: 6 },
          dispatcher: "memory",
          concurrency: this.limits.maxConcurrentJobs,
          resume: true,
          includeMedia: false,
        });
        for (const page of reportCrawledPages(crawl.pages, progress)) {
          const domain = hostname(page.url);
          pagesByDomain.set(domain, [...(pagesByDomain.get(domain) ?? []), page]);
        }
      } catch {
        degraded = "Batch deep crawl was unavailable; competitor summaries use lighter page fetches.";
      }
    }

    const competitors: CompetitorResearchResult[] = [];
    for (const candidate of candidates) {
      let pages = pagesByDomain.get(candidate.domain) ?? [];
      if (!pages.length) {
        try {
          report(progress, { type: "page_fetch_started", url: candidate.item.url, domain: candidate.domain, title: candidate.item.title });
          const page = await this.provider.fetch({ url: candidate.item.url, refresh });
          pages = reportCrawledPages([{ url: page.finalUrl ?? page.url, title: page.title, text: page.text, markdown: page.markdown, links: page.links }], progress);
        } catch (error) {
          pages = [];
          report(progress, { type: "page_fetch_failed", url: candidate.item.url, domain: candidate.domain, title: candidate.item.title, error: error instanceof Error ? error.message : undefined });
        }
      }
      const first = pages[0];
      const seoSignals = pages.flatMap((page) => page.structured?.seoSignals ? [JSON.stringify(page.structured.seoSignals)] : []);
      competitors.push({
        name: first?.title ?? candidate.item.title,
        domain: candidate.domain,
        summary: (first?.markdown || first?.text || candidate.item.snippet || "").slice(0, 1_800),
        productsServices: unique([...structuredValues(pages, "products"), ...structuredValues(pages, "services")]),
        pricingSignals: structuredValues(pages, "prices"),
        positioning: structuredValues(pages, "positioning"),
        audienceSignals: structuredValues(pages, "audienceSignals"),
        contentTopics: structuredValues(pages, "contentTopics"),
        seoSignals: unique(seoSignals),
        socialLinks: structuredValues(pages, "socialLinks"),
        sources: pages.length ? pages.map((page) => source(page.url, page.title)) : [source(candidate.item.url, candidate.item.title)],
      });
    }

    const sources = competitors.flatMap((item) => item.sources);
    const context = [
      "Current business: " + JSON.stringify(business),
      "Discovery query: " + query,
      "Validated competitor candidates with filtered page evidence and deterministic structured signals:",
      JSON.stringify(competitors, null, 2).slice(0, 36_000),
    ].join("\n\n");
    report(progress, { type: "research_completed", sourceCount: sources.length, pageCount: [...pagesByDomain.values()].reduce((count, pages) => count + pages.length, 0) });
    return {
      kind: "competitor_analysis",
      context,
      sources,
      degraded: candidates.length === 0 ? "No sufficiently relevant competitor candidates were validated." : degraded,
    };
  }

  private async analyzeSearch(message: string, business: BusinessResearchContext, refresh: boolean, progress?: ResearchProgressListener): Promise<ResearchOutcome> {
    const normalized = generalSearchQuery(message);
    const query = normalized.query;
    report(progress, { type: "search_started", query });
    const results = await this.provider.search({
      query,
      maxResults: this.limits.maxSearchResults,
      country: business.country,
      refresh,
    });
    report(progress, { type: "search_results_received", query, resultCount: results.length });
    const entityDomains = normalized.entities.length
      ? results.filter((item) => normalized.entities.some((entity) =>
          new RegExp(`(^|[^a-z0-9])${escapeRegex(entity)}([^a-z0-9]|$)`, "i").test(hostname(item.url))))
      : [];
    const relevantResults = entityDomains.length ? entityDomains : results;
    const candidates = relevantResults
      .filter((item, index) => {
        const domain = hostname(item.url);
        return Boolean(domain) && relevantResults.findIndex((candidate) => hostname(candidate.url) === domain) === index;
      })
      .slice(0, this.limits.maxCompetitors);
    for (const candidate of candidates) report(progress, { type: "source_discovered", url: candidate.url, title: candidate.title });
    let pages: CrawledPage[] = [];
    let degraded: string | undefined;
    if (candidates.length && this.provider.crawlMany) {
      try {
        for (const candidate of candidates) report(progress, { type: "page_fetch_started", url: candidate.url, domain: hostname(candidate.url), title: candidate.title });
        pages = reportCrawledPages((await this.provider.crawlMany({
          urls: candidates.map((candidate) => candidate.url),
          query,
          maxPages: this.limits.maxPagesPerSite,
          maxDepth: this.limits.maxCrawlDepth,
          refresh,
          deep: true,
          contentFilter: "auto",
          extraction: { strategy: "auto" },
          dynamic: { scanFullPage: true, flattenShadowDom: true, maxScrollSteps: 6 },
          dispatcher: "memory",
          concurrency: this.limits.maxConcurrentJobs,
          resume: true,
          includeMedia: false,
        })).pages, progress);
      } catch (error) {
        degraded = "Deep crawling was unavailable; the analysis uses lighter page fetches.";
        for (const candidate of candidates) report(progress, { type: "page_fetch_failed", url: candidate.url, domain: hostname(candidate.url), title: candidate.title, error: error instanceof Error ? error.message : undefined });
      }
    }
    if (!pages.length) {
      for (const candidate of candidates) {
        try {
          report(progress, { type: "page_fetch_started", url: candidate.url, domain: hostname(candidate.url), title: candidate.title });
          const page = await this.provider.fetch({ url: candidate.url, refresh });
          pages.push(...reportCrawledPages([{ url: page.finalUrl ?? page.url, title: page.title, text: page.text, markdown: page.markdown, links: page.links }], progress));
        } catch (error) {
          report(progress, { type: "page_fetch_failed", url: candidate.url, domain: hostname(candidate.url), title: candidate.title, error: error instanceof Error ? error.message : undefined });
        }
      }
    }
    const sources = pages.length
      ? pages.map((page) => source(page.url, page.title))
      : candidates.map((candidate) => source(candidate.url, candidate.title));
    const contextBudget = Math.min(this.limits.maxContentCharacters, 36_000);
    const perPage = Math.max(1_000, Math.floor(contextBudget / Math.max(1, pages.length)));
    const context = [
      "User web research request: " + query,
      "Search results: " + JSON.stringify(candidates, null, 2),
      pages.length ? "Fetched public page evidence:" : "No page content could be fetched; use search snippets only and state this limitation.",
      ...pages.map((page) => pageEvidence(page, perPage)),
    ].join("\n\n");
    report(progress, { type: "research_completed", sourceCount: sources.length, pageCount: pages.length });
    return {
      kind: "web_search",
      context,
      sources,
      degraded: candidates.length === 0 ? "No relevant public search results were found." : degraded,
    };
  }
}
