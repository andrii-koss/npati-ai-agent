import { OmniRouteEngine } from "../packages/omniroute-adapter/src/index";
import { createWebResearch } from "../packages/web-research/src/index";
import { webResearchUrlValidator } from "../apps/agent-api/src/ssrf-url-validator";
const env = { ...process.env, REDIS_URL: "", DATABASE_URL: "",
  NPATI_WEB_FETCH_ALLOWED_HOSTS: "www.apple.com,store.google.com,www.samsung.com",
};
const engine = new OmniRouteEngine({ baseUrl: env.OMNIROUTE_BASE_URL, apiKey: env.OMNIROUTE_API_KEY, timeoutMs: 30000 });
const bundle = createWebResearch(engine, env.CRAWL4AI_BASE_URL, env, { validator: webResearchUrlValidator(env) });
const urls = ["https://www.apple.com/shop", "https://store.google.com/us/?hl=en-US", "https://www.samsung.com/us/shop/"];
const results = await Promise.all(urls.map(async url => {
  const start = Date.now();
  try { const page = await bundle.provider.fetch({ url, refresh: true });
    return { url, status: "PASS", ms: Date.now() - start, provider: page.provider, title: page.title, textCharacters: (page.text ?? page.markdown ?? "").length };
  } catch (error) { return { url, status: "FAIL", ms: Date.now() - start, code: (error as { code?: string }).code ?? "fetch_failed" }; }
}));
const started = Date.now();
let search;
try { const rows = await bundle.provider.search({ query: "Apple Store Google Store Samsung shop electronics", maxResults: 5, refresh: true });
  search = { status: rows.length ? "PASS" : "FAIL", ms: Date.now() - started, results: rows.map(row => ({ title: row.title, url: row.url })) };
} catch { search = { status: "FAIL", ms: Date.now() - started }; }
console.log(JSON.stringify({ modelCalls: 0, tokens: 0, pages: results, search }, null, 2));
