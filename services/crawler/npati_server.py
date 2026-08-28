from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
from urllib.parse import urlparse

from bs4 import BeautifulSoup
from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from server import app, token_dep
from utils import validate_url_destination
from egress_broker import enforce_egress
from crawler_pool import get_crawler, release_crawler

from crawl4ai import BrowserConfig, CacheMode, CrawlerRunConfig
from crawl4ai.async_dispatcher import MemoryAdaptiveDispatcher, RateLimiter, SemaphoreDispatcher
from crawl4ai.content_filter_strategy import BM25ContentFilter, PruningContentFilter
from crawl4ai.deep_crawling import BestFirstCrawlingStrategy
from crawl4ai.deep_crawling.scorers import KeywordRelevanceScorer
from crawl4ai.extraction_strategy import JsonCssExtractionStrategy, JsonXPathExtractionStrategy
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator


STATE_DIR = Path(os.getenv("NPATI_CRAWLER_STATE_DIR", "/app/npati-state"))
STATE_DIR.mkdir(parents=True, exist_ok=True)
SOCIAL_HOSTS = {
    "facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "youtube.com",
    "youtu.be", "x.com", "twitter.com", "pinterest.com", "telegram.me", "t.me",
    "threads.net", "bsky.app", "mastodon.social",
}


class ExtractionOptions(BaseModel):
    strategy: Literal["auto", "css", "xpath"] = "auto"
    schema_data: Optional[Dict[str, Any]] = Field(default=None, alias="schema")

    model_config = {"populate_by_name": True}

    @field_validator("schema_data")
    @classmethod
    def bounded_schema(cls, value):
        if value is not None and len(json.dumps(value)) > 50_000:
            raise ValueError("Extraction schema is too large")
        return value


class DynamicOptions(BaseModel):
    wait_for: Optional[str] = None
    scan_full_page: bool = False
    load_more: bool = False
    flatten_shadow_dom: bool = False
    session_id: Optional[str] = None
    max_scroll_steps: int = Field(default=8, ge=1, le=20)

    @field_validator("wait_for")
    @classmethod
    def safe_wait(cls, value):
        if value is None:
            return value
        if len(value) > 300 or not value.startswith("css:"):
            raise ValueError("Only bounded CSS wait_for selectors are allowed")
        return value

    @field_validator("session_id")
    @classmethod
    def safe_session(cls, value):
        if value is not None and not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", value):
            raise ValueError("Invalid session id")
        return value


class NpatiCrawlRequest(BaseModel):
    urls: List[str] = Field(min_length=1, max_length=10)
    query: str = Field(default="", max_length=500)
    max_depth: int = Field(default=2, ge=0, le=3)
    max_pages: int = Field(default=10, ge=1, le=20)
    deep: bool = True
    refresh: bool = False
    include_media: bool = False
    content_filter: Literal["pruning", "bm25", "auto"] = "auto"
    extraction: ExtractionOptions = Field(default_factory=ExtractionOptions)
    dynamic: DynamicOptions = Field(default_factory=DynamicOptions)
    dispatcher: Literal["memory", "semaphore"] = "memory"
    concurrency: int = Field(default=2, ge=1, le=6)
    resume: bool = True

    @field_validator("urls")
    @classmethod
    def unique_urls(cls, value):
        return list(dict.fromkeys(value))


def _state_path(url: str, query: str) -> Path:
    digest = hashlib.sha256((url + "\n" + query).encode()).hexdigest()
    return STATE_DIR / f"{digest}.json"


def _load_state(path: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(path.read_text("utf-8")) if path.exists() else None
    except Exception:
        return None


async def _save_state(path: Path, state: Dict[str, Any]):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False, default=list), "utf-8")
    temp.replace(path)


def _keywords(query: str) -> List[str]:
    values = re.findall(r"[\w-]{3,}", query.lower(), flags=re.UNICODE)
    defaults = ["product", "products", "pricing", "price", "services", "about", "blog"]
    return list(dict.fromkeys(values + defaults))[:24]


def _dispatcher(kind: str, concurrency: int):
    limiter = RateLimiter(base_delay=(0.8, 1.8), max_delay=30.0, max_retries=3, rate_limit_codes=[429, 503])
    if kind == "semaphore":
        return SemaphoreDispatcher(semaphore_count=concurrency, max_session_permit=concurrency, rate_limiter=limiter)
    return MemoryAdaptiveDispatcher(
        memory_threshold_percent=82.0,
        critical_threshold_percent=90.0,
        recovery_threshold_percent=75.0,
        max_session_permit=concurrency,
        rate_limiter=limiter,
    )


def _load_more_script() -> str:
    return """(() => {
      const labels = /load more|show more|view more|more products/i;
      const candidates = [...document.querySelectorAll('button, a[role="button"]')];
      const button = candidates.find((el) => labels.test((el.textContent || '').trim()) && !el.disabled);
      if (button) button.click();
      window.scrollTo(0, document.body.scrollHeight);
    })();"""


def _extraction_strategy(options: ExtractionOptions):
    if options.strategy == "css" and options.schema_data:
        return JsonCssExtractionStrategy(options.schema_data)
    if options.strategy == "xpath" and options.schema_data:
        return JsonXPathExtractionStrategy(options.schema_data)
    return None


def _make_config(request: NpatiCrawlRequest, url: str):
    state_path = _state_path(url, request.query)
    resume_state = _load_state(state_path) if request.resume and request.deep else None

    async def checkpoint(state):
        await _save_state(state_path, state)

    deep_strategy = None
    if request.deep:
        deep_strategy = BestFirstCrawlingStrategy(
            max_depth=request.max_depth,
            max_pages=request.max_pages,
            include_external=False,
            url_scorer=KeywordRelevanceScorer(keywords=_keywords(request.query), weight=1.0),
            resume_state=resume_state,
            on_state_change=checkpoint if request.resume else None,
        )

    filter_name = "bm25" if request.content_filter == "bm25" or (request.content_filter == "auto" and request.query.strip()) else "pruning"
    content_filter = (
        BM25ContentFilter(user_query=request.query, bm25_threshold=0.8, language="english")
        if filter_name == "bm25"
        else PruningContentFilter(threshold=0.48, min_word_threshold=5)
    )

    config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS if request.refresh else CacheMode.ENABLED,
        deep_crawl_strategy=deep_strategy,
        markdown_generator=DefaultMarkdownGenerator(content_filter=content_filter, options={"ignore_links": False}),
        extraction_strategy=_extraction_strategy(request.extraction),
        excluded_tags=["nav", "footer", "header", "aside", "script", "style", "noscript"],
        remove_forms=True,
        remove_overlay_elements=True,
        remove_consent_popups=True,
        check_robots_txt=True,
        user_agent="NPATI-Agent-WebResearch/0.2 (+https://www.npati.com/)",
        page_timeout=int(os.getenv("NPATI_CRAWLER_PAGE_TIMEOUT_MS", "45000")),
        wait_for=request.dynamic.wait_for,
        scan_full_page=request.dynamic.scan_full_page,
        max_scroll_steps=request.dynamic.max_scroll_steps,
        js_code_before_wait=_load_more_script() if request.dynamic.load_more else None,
        flatten_shadow_dom=request.dynamic.flatten_shadow_dom,
        session_id=request.dynamic.session_id,
        exclude_all_images=not request.include_media,
        wait_for_images=request.include_media,
        score_links=True,
        preserve_https_for_internal_links=True,
        stream=False,
    )
    return config, state_path


def _as_dict(value: Any) -> Dict[str, Any]:
    if value is None:
        return {}
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return value if isinstance(value, dict) else {}


def _markdown_fields(value: Any) -> tuple[str, str]:
    data = _as_dict(value)
    if not data and isinstance(value, str):
        return value, value
    raw = data.get("raw_markdown") or data.get("markdown_with_citations") or ""
    fit = data.get("fit_markdown") or raw
    return str(raw or ""), str(fit or "")


def _links(value: Any) -> Dict[str, List[Dict[str, Any]]]:
    data = _as_dict(value)
    output = {"internal": [], "external": []}
    for group in output:
        rows = data.get(group, [])
        if isinstance(rows, list):
            output[group] = [row if isinstance(row, dict) else {"href": str(row)} for row in rows]
    return output


def _media(value: Any) -> Dict[str, List[Dict[str, Any]]]:
    data = _as_dict(value)
    return {
        key: [row for row in data.get(key, []) if isinstance(row, dict)]
        for key in ("images", "videos", "audio")
        if isinstance(data.get(key), list)
    }


def _walk_json_ld(value: Any, products: List[str], services: List[str], prices: List[str], types: set[str]):
    if isinstance(value, list):
        for item in value:
            _walk_json_ld(item, products, services, prices, types)
        return
    if not isinstance(value, dict):
        return
    raw_type = value.get("@type")
    type_values = raw_type if isinstance(raw_type, list) else [raw_type]
    for item_type in type_values:
        if isinstance(item_type, str):
            types.add(item_type)
            name = value.get("name")
            if item_type.lower() == "product" and isinstance(name, str):
                products.append(name)
            if item_type.lower() in {"service", "professionalservice"} and isinstance(name, str):
                services.append(name)
    offers = value.get("offers")
    if isinstance(offers, dict):
        price = offers.get("price") or offers.get("lowPrice")
        currency = offers.get("priceCurrency") or ""
        if price is not None:
            prices.append(f"{price} {currency}".strip())
    for nested in value.values():
        if isinstance(nested, (dict, list)):
            _walk_json_ld(nested, products, services, prices, types)


def _auto_extract(html: str, page_url: str, links: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    soup = BeautifulSoup(html or "", "lxml")
    products: List[str] = []
    services: List[str] = []
    prices: List[str] = []
    json_ld_types: set[str] = set()
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            _walk_json_ld(json.loads(script.get_text(" ", strip=True)), products, services, prices, json_ld_types)
        except Exception:
            continue

    text = soup.get_text(" ", strip=True)
    price_pattern = r"(?:[$\u20ac\u00a3\u20b4]\s?\d[\d\s,.]*|\d[\d\s,.]*\s?(?:USD|EUR|UAH|GBP|\u0433\u0440\u043d))"
    prices.extend(re.findall(price_pattern, text, flags=re.I)[:30])
    headings = [node.get_text(" ", strip=True) for node in soup.select("h1,h2,h3") if node.get_text(" ", strip=True)]
    social_links: List[str] = []
    contacts: List[str] = []
    for group in ("internal", "external"):
        for row in links.get(group, []):
            href = str(row.get("href", ""))
            host = (urlparse(href).hostname or "").lower().removeprefix("www.")
            if any(host == social or host.endswith("." + social) for social in SOCIAL_HOSTS):
                social_links.append(href)
            if href.startswith(("mailto:", "tel:")):
                contacts.append(href)

    def meta(*selectors: str) -> Optional[str]:
        for selector in selectors:
            node = soup.select_one(selector)
            if node and node.get("content"):
                return str(node.get("content"))
        return None

    canonical = soup.select_one('link[rel="canonical"]')
    title = soup.title.get_text(" ", strip=True) if soup.title else None
    description = meta('meta[name="description"]', 'meta[property="og:description"]')
    return {
        "products": list(dict.fromkeys(products))[:50],
        "services": list(dict.fromkeys(services))[:50],
        "prices": list(dict.fromkeys(prices))[:50],
        "positioning": [value for value in [description, meta('meta[property="og:title"]')] if value],
        "audience_signals": [],
        "social_links": list(dict.fromkeys(social_links))[:30],
        "contacts": list(dict.fromkeys(contacts))[:30],
        "content_topics": list(dict.fromkeys(headings))[:40],
        "seo_signals": {
            "title": title,
            "description": description,
            "h1": [node.get_text(" ", strip=True) for node in soup.select("h1")][:10],
            "canonical": canonical.get("href") if canonical else None,
            "json_ld_types": sorted(json_ld_types),
            "word_count": len(text.split()),
            "url": page_url,
        },
    }


def _parse_extracted(value: Any):
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return value
    return str(value)


def _process_result(result: Any, include_media: bool) -> Dict[str, Any]:
    row = _as_dict(result)
    url = str(row.get("url") or "")
    validate_url_destination(url)
    raw_markdown, fit_markdown = _markdown_fields(row.get("markdown"))
    links = _links(row.get("links"))
    html = str(row.get("cleaned_html") or row.get("html") or "")
    metadata = _as_dict(row.get("metadata"))
    return {
        "url": url,
        "success": bool(row.get("success", True)),
        "status_code": row.get("status_code"),
        "title": metadata.get("title"),
        "description": metadata.get("description"),
        "raw_markdown": raw_markdown,
        "fit_markdown": fit_markdown,
        "text": BeautifulSoup(html, "lxml").get_text("\n", strip=True) if html else fit_markdown,
        "links": links,
        "media": _media(row.get("media")) if include_media else {},
        "structured": _auto_extract(html, url, links),
        "extracted": _parse_extracted(row.get("extracted_content")),
        "depth": metadata.get("depth"),
        "score": metadata.get("score"),
        "error": row.get("error_message"),
    }


def _flatten_results(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        output: List[Any] = []
        for item in value:
            output.extend(_flatten_results(item))
        return output
    return [value]


@app.post("/npati/crawl")
async def npati_crawl(request: NpatiCrawlRequest, _td: Dict = Depends(token_dep)):
    for url in request.urls:
        validate_url_destination(url)

    browser_config = BrowserConfig(
        headless=True,
        text_mode=not request.include_media,
        user_agent="NPATI-Agent-WebResearch/0.2 (+https://www.npati.com/)",
    )
    enforce_egress(browser_config)
    crawler = await get_crawler(browser_config)
    state_paths: List[Path] = []
    try:
        configs = []
        for url in request.urls:
            config, state_path = _make_config(request, url)
            configs.append(config)
            state_paths.append(state_path)
        recovered = any(_load_state(path) is not None for path in state_paths)
        dispatcher = _dispatcher(request.dispatcher, request.concurrency)
        result = await crawler.arun_many(request.urls, config=configs, dispatcher=dispatcher)
        rows = [_process_result(item, request.include_media) for item in _flatten_results(result)]
        for path in state_paths:
            path.unlink(missing_ok=True)
        return {
            "root_urls": request.urls,
            "pages": rows,
            "dispatcher": request.dispatcher,
            "cache_mode": "bypass" if request.refresh else "enabled",
            "recovered": recovered,
        }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"NPATI crawl failed: {error}")
    finally:
        await release_crawler(crawler)