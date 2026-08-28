export * from "./types";
export * from "./safe-url-validator";
export * from "./cache";
export * from "./providers";
export * from "./research-service";
export * from "./jobs";

import type { OmniRouteEngine } from "@npati/omniroute-adapter";
import { Crawl4AIProvider, DefaultWebResearchProvider, OmniRouteFetchProvider, OmniRouteSearchProvider } from "./providers";
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

export function createWebResearch(engine: OmniRouteEngine, crawlerBaseUrl: string, environment: NodeJS.ProcessEnv = process.env) {
  const limits = webResearchLimits(environment);
  const validator = new SafeUrlValidator();
  const crawler = new Crawl4AIProvider(crawlerBaseUrl, validator, limits, environment.CRAWL4AI_API_TOKEN);
  const cache = environment.REDIS_URL ? new RedisResearchCache(environment.REDIS_URL) : undefined;
  const provider = new DefaultWebResearchProvider(
    new OmniRouteSearchProvider(engine),
    new OmniRouteFetchProvider(engine, validator),
    crawler,
    limits,
    cache,
  );
  const jobs = environment.DATABASE_URL
    ? new PostgresResearchJobStore(environment.DATABASE_URL)
    : new InMemoryResearchJobStore();
  return { service: new WebResearchService(provider, validator, limits), crawler, provider, validator, limits, jobs };
}
