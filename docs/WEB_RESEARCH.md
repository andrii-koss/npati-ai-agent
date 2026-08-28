# NPATI Web Research

## Runtime boundary

Chat calls the Agent API. The Agent API evaluates research intent, supplies the Current Business, and calls @npati/web-research. That package is the only NPATI layer that coordinates OmniRoute search/fetch and Crawl4AI. Business Brain receives normalized evidence, structured findings, and source URLs, never vendor response objects.

Pinned runtime versions:

- OmniRoute v3.8.50, commit 5458026c216f77a3da68ea49152dc33470cfe2cb
- Crawl4AI 0.9.2

Actual OmniRoute endpoints used:

- POST /api/v1/search, implemented upstream as POST /v1/search
- POST /api/v1/web/fetch, implemented upstream as POST /v1/web/fetch

Search-provider credentials remain managed by OmniRoute. NPATI does not duplicate Serper, Brave, Tavily, Firecrawl, Jina, or TinyFish secrets.

## Crawl4AI integration

The official Crawl4AI HTTP API intentionally rejects untrusted deep_crawl_strategy objects. NPATI therefore builds a small derived image from the pinned official image and adds the authenticated internal endpoint POST /npati/crawl. It constructs only bounded, server-owned Crawl4AI SDK strategies. Crawl4AI core is not patched.

The endpoint supports:

- BestFirstCrawlingStrategy with keyword relevance scoring, max_depth <= 3, and max_pages <= 20.
- PruningContentFilter and query-aware BM25ContentFilter.
- deterministic JSON-LD/HTML extraction for products, services, prices, positioning, topics, contacts, social links, and SEO signals.
- optional JsonCssExtractionStrategy and JsonXPathExtractionStrategy; no second paid LLM is invoked inside Crawl4AI.
- arun_many() for single and batch crawl requests.
- MemoryAdaptiveDispatcher or bounded SemaphoreDispatcher.
- native RateLimiter backoff for HTTP 429 and 503.
- check_robots_txt=true and user-agent NPATI-Agent-WebResearch/0.2 (+https://www.npati.com/).
- Crawl4AI CacheMode.ENABLED by default and BYPASS for refresh.
- bounded CSS wait_for, full-page scanning, generic Load More handling, Shadow DOM flattening, and session reuse.
- normalized internal/external links and optional image/video/audio metadata. Images are disabled by default to reduce RAM.
- persistent BestFirst state checkpoints on the npati-agent-crawler-state volume and resume after an interrupted crawl.

## Routing

- Search: competitor discovery and explicit market/web search requests.
- Fetch: a lightweight read of one supplied URL or one selected result.
- Crawl: deep website or competitor analysis. It examines relevant same-domain pages and does not crawl an entire site.
- Batch crawl: selected competitor domains use arun_many() with low concurrency.
- Crawl is not launched for ordinary business advice.

## Cache and jobs

Search, fetch, and normalized crawl results use Redis TTL caching when REDIS_URL is configured. refresh=true bypasses both the NPATI cache and Crawl4AI cache.

Longer work has a persisted research_jobs record scoped by workspace, business, and user. Chat returns researchJobId. Status is available from GET /businesses/:businessId/research-jobs/:jobId; cross-business and cross-workspace reads return no job.

Raw HTML is not stored in PostgreSQL. Only the compact job summary and normalized findings/source URLs are retained.

## Safety and limits

SafeUrlValidator permits only HTTP/HTTPS on ports 80/443, resolves DNS before requests, and blocks loopback, link-local, private, reserved, metadata, single-label, .local, .internal, and known Docker service destinations. Redirect/final URLs are validated again.

Defaults:

- 10 search results
- 5 competitors
- 10 pages per site
- depth 2
- 2 concurrent research jobs/sessions
- 45-second page timeout
- 600-second Redis/NPATI cache TTL
- 750 ms per-domain pacing
- 80,000 normalized content characters per page

Browser login, forms, autonomous clicking, paywall/CAPTCHA bypass, and authenticated sessions remain outside this milestone.
