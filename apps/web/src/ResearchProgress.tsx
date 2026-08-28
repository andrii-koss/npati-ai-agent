import { useEffect, useMemo, useState } from "react";

export type ChatProgressEvent = {
  type:
    | "search_started" | "search_results_received" | "source_discovered"
    | "page_fetch_started" | "page_fetch_completed" | "page_fetch_failed"
    | "research_completed" | "final_generation_started" | "final_generation_completed" | "final_generation_failed";
  timestamp: string;
  query?: string;
  resultCount?: number;
  url?: string;
  domain?: string;
  title?: string;
  error?: string;
  sourceCount?: number;
  pageCount?: number;
};

type PageState = {
  key: string;
  url: string;
  domain: string;
  title?: string;
  status: "active" | "completed" | "failed";
};

const faviconUrls = new Map<string, string>();
const failedFavicons = new Set<string>();
const generationStatuses = [
  "Готую відповідь із джерелами…",
  "Опрацьовую результати…",
  "Формую основні висновки…",
  "Уточнюю формулювання…",
  "Збираю все у зрозумілу відповідь…",
  "Майже все готово…",
];

function GenerationStatus() {
  return <span className="generation-status-copy">
    {generationStatuses.map((status) => <span className="research-active-text generation-status-text" key={status}>{status}</span>)}
  </span>;
}

function GlobeIcon() {
  return <svg className="research-progress-globe" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21M12 3c-2.4 2.5-3.6 5.5-3.6 9s1.2 6.5 3.6 9" /></svg>;
}

function DomainIcon({ domain }: { domain: string }) {
  const [failed, setFailed] = useState(failedFavicons.has(domain));
  if (failed || !domain) return <GlobeIcon />;
  let src = faviconUrls.get(domain);
  if (!src) {
    src = "https://" + domain + "/favicon.ico";
    faviconUrls.set(domain, src);
  }
  return <img className="research-progress-favicon" src={src} alt="" loading="lazy" onError={() => {
    failedFavicons.add(domain);
    setFailed(true);
  }} />;
}

function pageLabel(page: PageState) {
  if (page.title && page.title.toLowerCase() !== page.domain.toLowerCase()) return page.title;
  try {
    const path = new URL(page.url).pathname.replace(/^\/+|\/+$/g, "");
    if (!path) return "Головна сторінка";
    return path.split("/").filter(Boolean).at(-1)?.replace(/[-_]+/g, " ") || "Сторінка";
  } catch {
    return page.title || "Сторінка";
  }
}

function progressModel(events: ChatProgressEvent[]) {
  let query = "";
  let searchComplete = false;
  let generationActive = false;
  let generationFailed = false;
  const pages = new Map<string, PageState>();

  for (const event of events) {
    if (event.type === "search_started") query = event.query ?? query;
    if (event.type === "search_results_received") searchComplete = true;
    if (event.type === "page_fetch_started" && event.url && event.domain) {
      for (const [key, page] of pages) if (page.status === "active") pages.delete(key);
      pages.set(event.url, { key: event.url, url: event.url, domain: event.domain, title: event.title, status: "active" });
    }
    if ((event.type === "page_fetch_completed" || event.type === "page_fetch_failed") && event.url && event.domain) {
      const direct = pages.get(event.url);
      const activeForDomain = [...pages.values()].find((page) => page.domain === event.domain && page.status === "active");
      const previous = direct ?? activeForDomain;
      if (previous && previous.key !== event.url) pages.delete(previous.key);
      pages.set(event.url, {
        key: event.url,
        url: event.url,
        domain: event.domain,
        title: event.title ?? previous?.title,
        status: event.type === "page_fetch_completed" ? "completed" : "failed",
      });
    }
    if (event.type === "research_completed" || event.type === "final_generation_started") {
      for (const [key, page] of pages) if (page.status === "active") pages.delete(key);
    }
    if (event.type === "final_generation_started") generationActive = true;
    if (event.type === "final_generation_completed") generationActive = false;
    if (event.type === "final_generation_failed") {
      generationActive = false;
      generationFailed = true;
    }
  }

  return { query, searchComplete, generationActive, generationFailed, pages: [...pages.values()] };
}

export function ResearchProgressPanel({
  events,
  visibleCount,
  presentingEvent,
  completed,
  failed = false,
}: {
  events: ChatProgressEvent[];
  visibleCount: number;
  presentingEvent?: ChatProgressEvent | null;
  completed: boolean;
  failed?: boolean;
}) {
  const visible = events.slice(0, visibleCount);
  const presentationEvent = presentingEvent?.url && presentingEvent.domain
    ? { ...presentingEvent, type: "page_fetch_started" as const }
    : undefined;
  const model = useMemo(
    () => progressModel(presentationEvent ? [...visible, presentationEvent] : visible),
    [visible, presentationEvent],
  );
  const fullyPresented = (completed || failed) && visibleCount >= events.length && !presentingEvent;
  const [collapsed, setCollapsed] = useState(false);
  const [autoCollapsed, setAutoCollapsed] = useState(false);

  useEffect(() => {
    if (!fullyPresented || autoCollapsed) return;
    const timer = window.setTimeout(() => {
      setCollapsed(true);
      setAutoCollapsed(true);
    }, 550);
    return () => window.clearTimeout(timer);
  }, [fullyPresented, autoCollapsed]);

  if (collapsed) {
    return <article className="assistant research-progress collapsed">
      <button className="research-history-toggle" type="button" title="Показати історію аналізу" aria-label="Показати історію аналізу" onClick={() => setCollapsed(false)}>✓</button>
    </article>;
  }

  return <article className="assistant research-progress" aria-live="polite">
    {autoCollapsed && <button className="research-history-toggle expanded" type="button" title="Приховати історію аналізу" aria-label="Приховати історію аналізу" onClick={() => setCollapsed(true)}>✓</button>}

    {!model.searchComplete && model.query && <div className="research-search-row active">
      <span className="research-progress-state">●</span>
      <GlobeIcon />
      <span className="research-active-text">Шукаю інформацію: {model.query}</span>
    </div>}

    <div className="research-page-list">{model.pages.map((page) => <div className={"research-page-row " + page.status} key={page.key}>
      <span className="research-progress-state">{page.status === "completed" ? "✓" : page.status === "failed" ? "!" : "●"}</span>
      <DomainIcon domain={page.domain} />
      <span className={page.status === "active" ? "research-active-text" : undefined}>
        <strong>{page.domain}</strong>
        <small>{pageLabel(page)}{page.status === "failed" ? " — не вдалося відкрити" : ""}</small>
      </span>
    </div>)}</div>

    {model.generationActive && <div className="research-generation-row active">
      <span className="research-progress-state">●</span>
      <GenerationStatus />
    </div>}
    {model.generationFailed && <div className="research-generation-row failed">
      <span className="research-progress-state">!</span><span>Не вдалося підготувати відповідь</span>
    </div>}
  </article>;
}
