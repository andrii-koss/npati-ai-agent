import type { SafeUrlValidator } from "./safe-url-validator";
import type {
  BusinessResearchContext, CompetitorResearchResult, CrawledPage, ResearchOutcome,
  ResearchProgressListener, ResearchSource, WebResearchLimits, WebResearchProvider,
} from "./types";

const DOMAIN_TLDS = "(?:com|org|net|edu|gov|mil|int|ua|uk|us|ca|de|fr|it|es|nl|pl|cz|sk|ro|bg|gr|at|ch|se|no|fi|dk|ie|be|pt|by|kz|uz|io|ai|co|me|tv|cc|app|dev|page|tech|store|shop|online|site|pro|cloud|club|space|xyz|icu|top|live|vip|world|info|biz|mobi|name|agency|center|digital|solutions|link|click|today|group|media|news|press|blog)";

const URL_OR_DOMAIN_REGEX = new RegExp(
  "(?:https?:\\/\\/[^\\s<>()\"']+|\\b(?:www\\.)[a-z0-9.-]+\\.[a-z]{2,}(?:\\/[^\\s<>()\"']*)?|\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.(?:[a-z0-9-]+\\.)*" + DOMAIN_TLDS + "(?:\\/[^\\s<>()\"']*)?)",
  "gi"
);

const URL_PATTERN = /https?:\/\/[^\s<>()]+/i;
const RESEARCH_PATTERN = /\b(competitor|competitors|competition|market research|web research|research online|search the web|search the internet|find companies|who sells|analy[sz]e|scan|browse|google|website|internet|pesquise|pesquisa|concorrentes?|busca|buscar|competidores?|competencia|recherche|rechercher|concurrents?|suche|recherchiere|konkurrenten?|mitbewerber|cerca|ricerca|concorrenti?|szukaj|wyszukaj|konkurencj[aęi]|zoek|onderzoek|concurrenten?|ara|araştır|rakipler?)\b|\u043a\u043e\u043d\u043a\u0443\u0440\u0435\u043d\u0442|\u0434\u043e\u0441\u043b\u0456\u0434|\u0430\u043d\u0430\u043b\u0456\u0437|\u0437\u043d\u0430\u0439\u0434\u0438|\u0441\u043a\u0430\u043d\u0443|\u0456\u043d\u0442\u0435\u0440\u043d\u0435\u0442|\u0441\u0430\u0439\u0442|\u043f\u043e\u0448\u0443\u043a|\u043f\u0435\u0440\u0435\u0432\u0456\u0440|\u043f\u043e\u0434\u0438\u0432|\u0438\u0449\u0438|\u043f\u043e\u0438\u0441\u043a|搜索|调研|竞争对手|検索|調べて|競合|검색|조사|경쟁사|ابحث|بحث|منافس|खोजें|अनुसंधान|प्रतिस्पर्धी/iu;
const COMPETITOR_PATTERN = /\b(competitor|competitors|competition|find companies|who sells|concorrentes?|competidores?|competencia|concurrents?|konkurrenten?|mitbewerber|concorrenti?|konkurencj[aęi]|concurrenten?|rakipler?)\b|\u043a\u043e\u043d\u043a\u0443\u0440\u0435\u043d\u0442|竞争对手|競合|경쟁사|منافس|प्रतिस्पर्धी/iu;
const LIGHT_FETCH_PATTERN = /\b(read|open|fetch|summarize this page)\b|\u043f\u0440\u043e\u0447\u0438\u0442\u0430\u0439|\u0432\u0456\u0434\u043a\u0440\u0438\u0439|\u043a\u043e\u0440\u043e\u0442\u043a\u043e/iu;

export function extractTargetUrlsOrDomains(message: string): string[] {
  const targets: string[] = [];
  for (const match of message.match(URL_OR_DOMAIN_REGEX) ?? []) {
    let raw = match.replace(/[.,;!?)>\]]+$/u, "").trim();
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
    try {
      const parsed = new URL(raw);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !targets.includes(parsed.toString())) targets.push(parsed.toString());
    } catch {}
  }
  return targets;
}

export function extractTargetUrlOrDomain(message: string): string | null {
  return extractTargetUrlsOrDomains(message)[0] ?? null;
}

const GENERIC_WORDS = new Set([
  "блог", "blog", "сайт", "сатй", "site", "website", "сторінку", "сторінка", "page", "webpage",
  "статтю", "новини", "news", "відгуки", "reviews", "ціни", "тарифи", "pricing", "prices",
  "контакти", "contact", "послуги", "services", "товари", "products", "компанію", "компанія", "company",
  "посилання", "link", "links", "інформацію", "дані", "info", "data", "ринок", "market", "конкурентів", "конкуренти", "competitors",
  "це", "цей", "ця", "все", "this", "the", "a", "an", "який", "яка", "яке", "онлайн", "online", "мене", "себе", "me", "it", "all",
  "help", "hello", "привіт", "почати", "start", "stop", "test", "офіційний", "official"
]);

export function extractSiteEntity(message: string): string | null {
  if (extractTargetUrlOrDomain(message)) return null;

  const trimmed = message.trim();

  // If the query is an internal company creation / management command without explicit web browsing/search verbs,
  // do not treat the company name as a site to crawl or search.
  const isInternalCreation = /(?:створ|созда|create|cr[eé]e|erstelle|crea|utwórz|stwórz|crie|maak|oluştur|创建|作成|만들|أنشئ|बना)\p{L}*\s+(?:(?:a|an|the|my|new|нову|новий|нові|uma|una|ein|een|bir|一家|ひとつ)?\s+)?(?:компан|compan|entreprise|unternehmen|empresa|azienda|firm|bedrijf|şirket|公司|会社|회사|شركة|कंपनी)/iu.test(trimmed);
  const explicitlyWeb = /(?:site|website|веб[- ]?сайт|сайт|інтернет|internet|google|crawl|scan|проскануй|скануй|online|url|http)/iu.test(trimmed);
  if (isInternalCreation && !explicitlyWeb) {
    return null;
  }

  // Pattern 1: Site/website/brand keyword followed by target name:
  // e.g., "Analyze site hostkoss", "проаналізуй сайт hostkoss", "Проаналізуй бренд Hostkoss і сайти, які до нього належать"
  // Note: 'компанія' and 'company' are intentionally excluded because creating or managing companies is an internal action.
  const sitePrefixRegex = /(?:analyze|analyse|scan|check|review|audit|inspect|test|проаналізуй|аналізуй|аналіз|проскануй|скануй|перевір|досліди|подивись|оглянь|знайди|пошукай)\s*(?:site|website|web\s*site|webpage|page|веб[- ]?сайт|сайт|сатй|сторінку|домен|бренд|brand|сервіс|platform|платформа)\s*[:\-–—]?\s*([a-zA-Z0-9\u0400-\u04FF_-]{2,50})/iu;
  const matchSite = trimmed.match(sitePrefixRegex);
  if (matchSite && matchSite[1]) {
    const candidate = matchSite[1].trim();
    if (!GENERIC_WORDS.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  // Pattern 2: Action keyword directly followed by target name:
  // e.g., "Analyze hostkoss", "проаналізуй hostkoss", "скануй hostkoss"
  const actionRegex = /(?:analyze|analyse|scan|audit|inspect|проаналізуй|аналізуй|проскануй|скануй|перевір|досліди|подивись|оглянь)\s+([a-zA-Z0-9\u0400-\u04FF_-]{2,50})/iu;
  const matchAction = trimmed.match(actionRegex);
  if (matchAction && matchAction[1]) {
    const candidate = matchAction[1].trim();
    if (!GENERIC_WORDS.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  // Pattern 3: Standalone single word (e.g. user just enters "hostkoss")
  if (/^[a-zA-Z0-9\u0400-\u04FF_-]{3,40}$/u.test(trimmed)) {
    if (!GENERIC_WORDS.has(trimmed.toLowerCase())) {
      return trimmed;
    }
  }

  return null;
}

const SOCIAL_OR_AGGREGATOR = new Set([
  "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
  "youtube.com", "wikipedia.org", "github.com", "reddit.com", "t.me", "telegram.org",
  "pinterest.com", "tiktok.com"
]);

export function findTargetUrlFromSearchResults(results: Array<{ url: string; title?: string; snippet?: string }>, target: string): string | null {
  const cleanTarget = target.toLowerCase().replace(/[^a-z0-9]/g, "");

  const scored = results.map((item, index) => {
    const domain = hostname(item.url);
    if (!domain) return { item, domain: "", score: -1000 };

    const domainParts = domain.split(".");
    const domainName = domainParts[0] || "";
    const cleanDomain = domain.replace(/[^a-z0-9]/g, "");

    let score = 0;
    score -= index * 2;

    if (cleanTarget.length >= 3 && (domainName === cleanTarget || cleanDomain.startsWith(cleanTarget))) {
      score += 100;
    } else if (cleanTarget.length >= 3 && cleanDomain.includes(cleanTarget)) {
      score += 50;
    }

    const titleLower = (item.title || "").toLowerCase();
    if (titleLower.includes(target.toLowerCase())) {
      score += 20;
    }

    const snippetLower = (item.snippet || "").toLowerCase();
    if (snippetLower.includes(target.toLowerCase())) {
      score += 10;
    }

    const primaryDomain = domainParts[0] ?? "";
    if (SOCIAL_OR_AGGREGATOR.has(domain) && (primaryDomain ? !cleanTarget.includes(primaryDomain) : true)) {
      score -= 80;
    }

    return { item, domain, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best && best.score > 0 ? best.item.url : null;
}

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
  const ignored = new Set([
    "analyze", "analyse", "find", "search", "research", "review", "check", "detail", "detailed",
    ...GENERIC_WORDS
  ]);
  const siteEntity = extractSiteEntity(message);
  const entities = unique(
    (message.match(/\b[\p{Lu}][\p{L}\p{N}.-]{2,}\b/gu) ?? []).filter((value) => !ignored.has(value.toLowerCase())),
    5
  );
  if (!entities.length && siteEntity) {
    entities.push(siteEntity);
  }
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

function isSiteRoot(url: URL) {
  return url.pathname === "/" || url.pathname === "";
}

function pageFailure(page: CrawledPage) {
  if (page.error) return page.error;
  const title = page.title?.trim() ?? "";
  if (/^(?:4\d\d|5\d\d)\b/i.test(title) || /\b(?:too many requests|access denied|forbidden|service unavailable)\b/i.test(title)) {
    return title || "The server returned an error page.";
  }
  return undefined;
}

function normalizePageUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    const dropParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "fbclid", "gclid", "session", "phpsessid", "token", "aff",
    ];
    for (const p of dropParams) parsed.searchParams.delete(p);
    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (pathname === "/index.php" || pathname === "/index.html") {
      if ([...parsed.searchParams.keys()].length === 0) {
        pathname = "";
      }
    }
    parsed.pathname = pathname || "/";
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function cleanExtractedTitle(page: CrawledPage): string | undefined {
  let title = page.title?.trim();
  if (title && !/^(?:index|default|home|main)\.(?:php|html|htm|aspx|jsp)$/i.test(title)) {
    return title;
  }
  const content = page.markdown || page.text || "";
  const h1Match = content.match(/^#\s+([^\n\r]+)/m) || content.match(/^##\s+([^\n\r]+)/m);
  if (h1Match && h1Match[1]) {
    const candidate = h1Match[1].trim();
    if (candidate.length > 2 && candidate.length < 120 && !candidate.startsWith("http")) {
      return candidate;
    }
  }
  return undefined;
}

export function deduplicateAndFilterPages(pages: CrawledPage[], maxPages: number): CrawledPage[] {
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const result: CrawledPage[] = [];

  for (const page of pages) {
    const normUrl = normalizePageUrl(page.url);
    if (seenUrls.has(normUrl)) continue;
    seenUrls.add(normUrl);

    const lowerUrl = normUrl.toLowerCase();
    if (
      lowerUrl.includes("/clientarea") ||
      lowerUrl.includes("/login") ||
      lowerUrl.includes("/logout") ||
      lowerUrl.includes("/cart.php?a=add") ||
      lowerUrl.includes("/pwreset") ||
      lowerUrl.includes("action=logout")
    ) {
      continue;
    }

    const title = cleanExtractedTitle(page);
    const cleanedPage: CrawledPage = {
      ...page,
      url: normUrl,
      title: title || page.title,
    };

    if (title) {
      const lowerTitle = title.toLowerCase();
      if (seenTitles.has(lowerTitle)) {
        continue;
      }
      seenTitles.add(lowerTitle);
    }

    result.push(cleanedPage);
    if (result.length >= maxPages) break;
  }

  return result.length > 0 ? result : pages.slice(0, maxPages);
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
    return Boolean(extractTargetUrlOrDomain(message) || extractSiteEntity(message) || RESEARCH_PATTERN.test(message));
  }

  async run(message: string, business: BusinessResearchContext, refresh = false, progress?: ResearchProgressListener, options: { mode?: "search" } = {}): Promise<ResearchOutcome | null> {
    const directUrls = extractTargetUrlsOrDomains(message);
    const directUrl = directUrls[0];
    if (directUrls.length > 1) return this.analyzeUrls(directUrls, business, refresh, progress);
    // An explicit search request (a model's web_search call) is a search: a product or framework name in the query
    // must not turn it into "find this brand's official site".
    if (options.mode === "search" && !directUrl) return this.analyzeSearch(message, business, refresh, progress, true);
    if (directUrl) {
      const explicitlyLight = LIGHT_FETCH_PATTERN.test(message) && !RESEARCH_PATTERN.test(message);
      // The rest of the request ("current LTS version") steers which part of the page is kept (V6 step 11).
      return this.analyzeUrl(directUrl, business, refresh, !explicitlyLight, progress, message.replace(directUrl, " ").replace(/\s+/g, " ").trim());
    }
    const siteEntity = extractSiteEntity(message);
    if (siteEntity) {
      return this.analyzeSiteByName(siteEntity, business, refresh, progress);
    }
    if (!RESEARCH_PATTERN.test(message)) return null;
    return COMPETITOR_PATTERN.test(message)
      ? this.analyzeCompetitors(business, refresh, progress)
      : this.analyzeSearch(message, business, refresh, progress);
  }

  private async analyzeUrls(urls: string[], business: BusinessResearchContext, refresh: boolean, progress?: ResearchProgressListener): Promise<ResearchOutcome> {
    if (urls.length > this.limits.maxCompetitors) throw new Error("Explicit research targets exceed the configured site limit.");
    // Validate every target before any provider call; each existing analyzeUrl path validates again at execution.
    for (const url of urls) await this.validator.validate(url);
    const outcomes: Array<ResearchOutcome | undefined> = new Array(urls.length);
    const failures: string[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.limits.maxConcurrentJobs, urls.length)) }, async () => {
      while (next < urls.length) {
        const index = next++;
        const url = urls[index]!;
        try {
          outcomes[index] = await this.analyzeUrl(url, business, refresh, true, progress);
          if (!outcomes[index]!.sources.length) failures.push(new URL(url).hostname + ": no usable page retrieved");
        } catch (error) {
          failures.push(new URL(url).hostname + ": retrieval failed");
          report(progress, { type: "page_fetch_failed", url, domain: hostname(url), error: "Retrieval failed" });
        }
      }
    }));
    const available = outcomes.filter((value): value is ResearchOutcome => Boolean(value));
    const budget = Math.floor(this.limits.maxContentCharacters / urls.length);
    const degraded = [...failures, ...available.flatMap(value => value.degraded ? [value.degraded] : [])];
    return {
      kind: "url_analysis",
      ...(available.every(value => value.pageCount !== undefined) ? { pageCount: available.reduce((sum, value) => sum + value.pageCount!, 0) } : {}),
      sources: available.flatMap(value => value.sources).filter((source, index, sources) => sources.findIndex(item => item.url === source.url) === index),
      context: ["Explicit research targets: " + urls.join(", "), "Use retrieved evidence only. Missing targets cannot be presented as analyzed.", ...available.map(value => value.context.slice(0, budget)), ...(failures.length ? ["Incomplete coverage: " + failures.join("; ")] : [])].join("\n\n").slice(0, this.limits.maxContentCharacters),
      degraded: degraded.length ? degraded.join("; ") : undefined,
    };
  }

  private async analyzeSiteByName(
    targetName: string,
    business: BusinessResearchContext,
    refresh: boolean,
    progress?: ResearchProgressListener
  ): Promise<ResearchOutcome> {
    const isBlog = /\bblog\b|\u0431\u043b\u043e\u0433/iu.test(targetName);
    const query = `${targetName} official website${isBlog ? " blog" : ""}`;
    report(progress, { type: "search_started", query });
    const results = await this.provider.search({
      query,
      maxResults: Math.max(10, this.limits.maxSearchResults),
      country: business.country,
      refresh,
    });
    report(progress, { type: "search_results_received", query, resultCount: results.length });

    const targetUrl = findTargetUrlFromSearchResults(results, targetName);
    if (targetUrl) {
      return this.analyzeUrl(targetUrl, business, refresh, true, progress);
    }

    return this.analyzeSearch(targetName, business, refresh, progress);
  }

  private async analyzeUrl(url: string, business: BusinessResearchContext, refresh: boolean, deep: boolean, progress?: ResearchProgressListener, focus?: string): Promise<ResearchOutcome> {
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
        // A site is crawled; a named page is read as that page. Following a release page's links stored GitHub topics,
        // profiles and "report content" as ten sources of a Node.js answer (V6 step 11).
        const site = isSiteRoot(safe);
        const crawl = await this.provider.crawl({
          url: safe.toString(),
          query: focus || researchQuery(business, safe.hostname),
          maxPages: site ? this.limits.maxPagesPerSite : 1,
          maxDepth: site ? this.limits.maxCrawlDepth : 0,
          refresh,
          deep: site,
          contentFilter: "auto",
          extraction: { strategy: "auto" },
          dynamic: { scanFullPage: true, flattenShadowDom: true, maxScrollSteps: 8 },
          dispatcher: "memory",
          concurrency: this.limits.maxConcurrentJobs,
          resume: true,
          includeMedia: false,
        });
        pages = deduplicateAndFilterPages(crawl.pages, this.limits.maxPagesPerSite);
      } catch {
        const page = await this.provider.fetch({ url: safe.toString(), refresh });
        pages = [{ url: page.finalUrl ?? page.url, title: page.title, text: page.text, markdown: page.markdown, links: page.links }];
        degraded = "Deep crawling was unavailable, so this analysis uses a single fetched page.";
      }
    }
    // A refused page (robots.txt, HTTP error) is named with its reason; the model said "it opened without text".
    const notRetrieved = pages.flatMap((page) => { const error = pageFailure(page); return error ? [`NOT RETRIEVED ${page.url}: ${error}`] : []; });
    pages = reportCrawledPages(pages, progress);
    const sources = pages.map((page) => source(page.url, page.title));
    const contextBudget = Math.min(this.limits.maxContentCharacters, 36_000);
    const perPage = Math.max(1_000, Math.floor(contextBudget / Math.max(1, pages.length)));
    const context = [
      "Research target: " + safe.hostname,
      "Current business for comparison: " + JSON.stringify(business),
      "Crawl coverage: " + pages.length + " public pages.",
      ...pages.map((page) => pageEvidence(page, perPage)),
      ...notRetrieved,
    ].join("\n\n");
    report(progress, { type: "research_completed", sourceCount: sources.length, pageCount: pages.length });
    return { kind: "url_analysis", context, sources, degraded, pageCount: pages.length };
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
        for (const page of reportCrawledPages(deduplicateAndFilterPages(crawl.pages, this.limits.maxPagesPerSite * candidates.length), progress)) {
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
      pageCount: [...pagesByDomain.values()].reduce((count, pages) => count + pages.length, 0),
      context,
      sources,
      degraded: candidates.length === 0 ? "No sufficiently relevant competitor candidates were validated." : degraded,
    };
  }

  private async analyzeSearch(message: string, business: BusinessResearchContext, refresh: boolean, progress?: ResearchProgressListener, literal = false): Promise<ResearchOutcome> {
    // A query written for search is used as is; the heuristic rewrite ("<Capitalized word> official website") is
    // only for free-form chat messages.
    const normalized = literal ? { query: message.trim().slice(0, 500), entities: [] as string[] } : generalSearchQuery(message);
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
        pages = reportCrawledPages(deduplicateAndFilterPages((await this.provider.crawlMany({
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
        })).pages, this.limits.maxPagesPerSite * candidates.length), progress);
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
      pageCount: pages.length,
      context,
      sources,
      degraded: candidates.length === 0 ? "No relevant public search results were found." : degraded,
    };
  }
}
