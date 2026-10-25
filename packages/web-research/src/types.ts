import type { WebPageResult, WebSearchResult } from "@npati/omniroute-adapter";

export type { WebPageResult, WebSearchResult };

export interface SearchInput {
  query: string;
  maxResults?: number;
  country?: string;
  language?: string;
  refresh?: boolean;
}

export interface FetchInput {
  url: string;
  refresh?: boolean;
}

export interface CrawlExtractionInput {
  strategy?: "auto" | "css" | "xpath";
  schema?: Record<string, unknown>;
}

export interface CrawlDynamicInput {
  waitFor?: string;
  scanFullPage?: boolean;
  loadMore?: boolean;
  flattenShadowDom?: boolean;
  sessionId?: string;
  maxScrollSteps?: number;
}

export interface CrawlInput {
  url: string;
  maxPages?: number;
  maxDepth?: number;
  query?: string;
  deep?: boolean;
  refresh?: boolean;
  includeMedia?: boolean;
  contentFilter?: "auto" | "pruning" | "bm25";
  extraction?: CrawlExtractionInput;
  dynamic?: CrawlDynamicInput;
  dispatcher?: "memory" | "semaphore";
  concurrency?: number;
  resume?: boolean;
}

export interface CrawlBatchInput extends Omit<CrawlInput, "url"> {
  urls: string[];
}

export interface CrawledPage {
  url: string;
  title?: string;
  text?: string;
  markdown?: string;
  links?: string[];
  internalLinks?: string[];
  externalLinks?: string[];
  media?: {
    images?: Array<Record<string, unknown>>;
    videos?: Array<Record<string, unknown>>;
    audio?: Array<Record<string, unknown>>;
  };
  structured?: {
    products?: string[];
    prices?: string[];
    services?: string[];
    audienceSignals?: string[];
    positioning?: string[];
    contentTopics?: string[];
    socialLinks?: string[];
    contacts?: string[];
    seoSignals?: Record<string, unknown>;
  };
  extracted?: unknown;
  depth?: number;
  score?: number;
}

export interface CrawlResult {
  rootUrl: string;
  pages: CrawledPage[];
  startedAt: string;
  completedAt: string;
  dispatcher?: "memory" | "semaphore";
  cacheMode?: string;
  recovered?: boolean;
}

export interface WebResearchProvider {
  search(input: SearchInput): Promise<WebSearchResult[]>;
  fetch(input: FetchInput): Promise<WebPageResult>;
  crawl(input: CrawlInput): Promise<CrawlResult>;
  crawlMany?(input: CrawlBatchInput): Promise<CrawlResult>;
}

export interface ResearchSource {
  url: string;
  title?: string;
  accessedAt: string;
}

export interface CompetitorResearchResult {
  name?: string;
  domain: string;
  summary?: string;
  productsServices?: string[];
  pricingSignals?: string[];
  positioning?: string[];
  audienceSignals?: string[];
  contentTopics?: string[];
  seoSignals?: string[];
  socialLinks?: string[];
  strengths?: string[];
  weaknesses?: string[];
  sources: ResearchSource[];
}

export interface BusinessResearchContext {
  name?: string;
  businessType?: string;
  industry?: string;
  niche?: string;
  country?: string;
  market?: string;
  description?: string;
  audienceSummary?: string;
  productsServicesSummary?: string;
}

export type ResearchJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ResearchJob {
  id: string;
  workspaceId: string;
  businessId: string;
  userId: string;
  type: "search" | "fetch" | "crawl" | "competitor_analysis";
  status: ResearchJobStatus;
  input: Record<string, unknown>;
  resultSummary?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ResearchOutcome {
  /** Retrieved pages, distinct from discovered/search-only sources. Undefined means unavailable. */
  pageCount?: number;
  kind: "url_analysis" | "web_search" | "competitor_analysis";
  context: string;
  sources: ResearchSource[];
  degraded?: string;
}

export type ResearchProgressEvent =
  | { type: "search_started"; query: string }
  | { type: "search_results_received"; query: string; resultCount: number }
  | { type: "source_discovered"; url: string; title?: string }
  | { type: "page_fetch_started"; url: string; domain: string; title?: string }
  | { type: "page_fetch_completed"; url: string; domain: string; title?: string }
  | { type: "page_fetch_failed"; url: string; domain: string; title?: string; error?: string }
  | { type: "research_completed"; sourceCount: number; pageCount: number }
  | { type: "final_generation_started" }
  | { type: "final_generation_completed" }
  | { type: "final_generation_failed"; error?: string };

export type ResearchProgressListener = (event: ResearchProgressEvent) => void;

export interface WebResearchLimits {
  maxSearchResults: number;
  maxCompetitors: number;
  maxPagesPerSite: number;
  maxCrawlDepth: number;
  timeoutMs: number;
  maxConcurrentJobs: number;
  cacheTtlSeconds: number;
  maxContentCharacters: number;
  perDomainDelayMs: number;
}
