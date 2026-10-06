export * from "./types";
export * from "./safe-url-validator";
export * from "./cache";
export * from "./providers";
export * from "./research-service";
export * from "./jobs";

import type { OmniRouteEngine } from "@npati/omniroute-adapter";
import { Crawl4AIProvider, DefaultWebResearchProvider, OmniRouteFetchProvider, OmniRouteSearchProvider } from "./providers";
import type { OutboundGuardPort } from "./providers";
import { RedisResearchCache } from "./cache";
import { InMemoryResearchJobStore, PostgresResearchJobStore } from "./jobs";
import { SafeUrlValidator } from "./safe-url-validator";
import { WebResearchService } from "./research-service";
import type { WebResearchLimits } from "./types";

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function webResearchLimits(environment: NodeJS.ProcessEnv = process.env): WebResearchLimits {
  return {
    maxSearchResults: positiveInt(environment.WEB_RESEARCH_MAX_SEARCH_RESULTS, 10),
    maxCompetitors: positiveInt(environment.WEB_RESEARCH_MAX_COMPETITORS, 5),
    maxPagesPerSite: positiveInt(environment.WEB_RESEARCH_MAX_PAGES_PER_SITE, 10),
    maxCrawlDepth: positiveInt(environment.WEB_RESEARCH_MAX_CRAWL_DEPTH, 2),
    timeoutMs: positiveInt(environment.WEB_RESEARCH_TIMEOUT_SECONDS, 45) * 1000,
    maxConcurrentJobs: positiveInt(environment.WEB_RESEARCH_MAX_CONCURRENT_JOBS, 2),
    cacheTtlSeconds: positiveInt(environment.WEB_RESEARCH_CACHE_TTL_SECONDS, 600),
    maxContentCharacters: positiveInt(environment.WEB_RESEARCH_MAX_CONTENT_CHARACTERS, 80_000),
    perDomainDelayMs: positiveInt(environment.WEB_RESEARCH_PER_DOMAIN_DELAY_MS, 750),
  };
}

export interface WebResearchOptions {
  /**
   * Optional URL validator. The default is the package-local `SafeUrlValidator`; callers that own a
   * stronger SSRF policy (for example the agent API's `ssrf-policy`) inject it here so web fetches and
   * crawls go through exactly the same rules as every other NPATI-side outbound request.
   */
  validator?: SafeUrlValidator;
  /**
   * C5b: optional exfiltration guard. The agent API injects it so a search query, a fetched URL or a crawl
   * request carrying private repository content is refused (or sent for approval) before it leaves NPATI.
   */
  outboundGuard?: OutboundGuardPort;
}

export function createWebResearch(engine: OmniRouteEngine, crawlerBaseUrl?: string, environment: NodeJS.ProcessEnv = process.env, options: WebResearchOptions = {}) {
  const limits = webResearchLimits(environment);
  const validator = options.validator ?? new SafeUrlValidator();
  const outboundGuard = options.outboundGuard;
  const crawler = crawlerBaseUrl
    ? new Crawl4AIProvider(crawlerBaseUrl, validator, limits, environment.CRAWL4AI_API_TOKEN, outboundGuard)
    : undefined;
  const cache = environment.REDIS_URL ? new RedisResearchCache(environment.REDIS_URL) : undefined;
  const provider = new DefaultWebResearchProvider(
    new OmniRouteSearchProvider(engine, outboundGuard),
    new OmniRouteFetchProvider(engine, validator, outboundGuard),
    crawler,
    limits,
    cache,
  );
  const jobs = environment.DATABASE_URL
    ? new PostgresResearchJobStore(environment.DATABASE_URL)
    : new InMemoryResearchJobStore();
  return { service: new WebResearchService(provider, validator, limits), crawler, provider, validator, limits, jobs };
}
