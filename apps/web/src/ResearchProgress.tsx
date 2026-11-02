import React, { useEffect, useMemo, useState } from "react";
import type { DevelopmentProcessProgressItem, ProjectProgressEvent } from "@npati/shared";
import { isVisibleChatOperation, normalizeActivity } from "./chat-timeline";

/** One owner per submitted turn. Run boundaries and server locale updates cannot restart thinking. */
export function useChatThinking(options: { busy: boolean; streaming: boolean; text: string; items?: DevelopmentProcessProgressItem[]; runIds: string[]; events: ChatProgressEvent[] }) {
  const [turn, setTurn] = useState<{ text: string; baseline: Set<string>; runs: Set<string>; finished: boolean } | null>(null);
  const items = normalizeActivity(options.items);
  const start = (message: string) => {
    setTurn({ text: /[іїєґ]/iu.test(message) ? "Думаю" : options.text,
      baseline: new Set(items.map(item => item.id)), runs: new Set([...options.runIds, ...items.flatMap(item => item.runId ? [item.runId] : [])]), finished: false });
  };
  const operationStarted = Boolean(turn && items.some(item => isVisibleChatOperation(item) &&
    (item.runId ? !turn.runs.has(item.runId) : !turn.baseline.has(item.id))));
  const progressed = operationStarted || options.streaming || options.events.some(event => !event.type.startsWith("final_generation"));
  useEffect(() => {
    if (turn && !turn.finished && (progressed || !options.busy)) setTurn(current => current === turn ? { ...current, finished: true } : current);
  }, [turn, progressed, options.busy]);
  return { start, text: turn?.text ?? options.text, visible: Boolean(turn && !turn.finished && options.busy && !progressed) };
}

export function ChatThinking({ text }: { text: string }) {
  return <article className="assistant research-progress chat-thinking" role="status" aria-label={text}><div className="research-generation-row active"><span className="research-progress-state" aria-hidden="true">●</span><span className="research-active-text">{text}</span></div></article>;
}

export type ChatProgressEvent = {
  type:
    | "search_started" | "search_results_received" | "source_discovered"
    | "page_fetch_started" | "page_fetch_completed" | "page_fetch_failed"
    | "action_started" | "action_completed" | "project_progress"
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
  stage?: ProjectProgressEvent["stage"];
  status?: ProjectProgressEvent["status"];
  framework?: string;
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
  "Preparing answer with sources…",
  "Processing research results…",
  "Formulating key conclusions…",
  "Refining wording…",
  "Assembling final response…",
  "Almost ready…",
];

function GenerationStatus() {
  return <span className="generation-status-copy">
    {generationStatuses.map((status) => <span className="research-active-text generation-status-text" key={status}>{status}</span>)}
  </span>;
}

function GlobeIcon() {
  return <svg className="research-progress-globe" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21M12 3c-2.4 2.5-3.6 5.5-3.6 9s1.2 6.5 3.6 9" /></svg>;
}

function FileDocIcon() {
  return (
    <svg className="research-progress-globe" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function DomainIcon({ domain }: { domain: string }) {
  if (domain === "file" || domain === "document" || domain === "attachment") {
    return <FileDocIcon />;
  }
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

function cleanLabel(text: string): string {
  const t = text.trim();
  if (/^(?:index|default|home|main)\.(?:php|html|htm|aspx|jsp)$/i.test(t)) return "";
  return t;
}

function pageLabel(page: PageState) {
  if (page.domain === "file" || page.url.startsWith("file://")) {
    return page.title || "File";
  }
  const cleanTitle = page.title ? cleanLabel(page.title) : "";
  if (cleanTitle && cleanTitle.toLowerCase() !== page.domain.toLowerCase()) {
    return cleanTitle;
  }
  try {
    const urlObj = new URL(page.url);
    const pathname = urlObj.pathname.replace(/^\/+|\/+$/g, "");
    const rp = urlObj.searchParams.get("rp") || urlObj.searchParams.get("p") || urlObj.searchParams.get("page");
    if (rp) {
      const cleanRp = rp.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).at(-1)?.replace(/[-_]+/g, " ");
      if (cleanRp) return cleanRp.charAt(0).toUpperCase() + cleanRp.slice(1);
    }
    if (!pathname || /^(?:index|default)\.(?:php|html|htm|aspx)$/i.test(pathname)) {
      return "Home page";
    }
    const lastSegment = pathname.split("/").filter(Boolean).at(-1)?.replace(/[-_]+/g, " ");
    const cleanSegment = lastSegment ? cleanLabel(lastSegment) : "";
    if (cleanSegment) return cleanSegment.charAt(0).toUpperCase() + cleanSegment.slice(1);
    return "Home page";
  } catch {
    return cleanTitle || "Page";
  }
}

export function progressModel(events: ChatProgressEvent[]) {
  let query = "";
  let searchComplete = false;
  let generationActive = false;
  let generationFailed = false;
  const actions = new Map<string, PageState>();
  const pages = new Map<string, PageState>();

  for (const event of events) {
    if (event.type === "search_started") query = event.query ?? query;
    if (event.type === "search_results_received") searchComplete = true;
    if (event.type === "action_started" && event.url && event.domain) {
      for (const [key, action] of actions) if (action.status === "active") actions.set(key, { ...action, status: "completed" });
      actions.set(event.url, { key: event.url, url: event.url, domain: event.domain, title: event.title, status: "active" });
    }
    if (event.type === "action_completed" && event.url && event.domain) {
      const previous = actions.get(event.url);
      actions.set(event.url, { key: event.url, url: event.url, domain: event.domain, title: event.title ?? previous?.title, status: "completed" });
    }
    if (event.type === "page_fetch_started" && event.url && event.domain) {
      for (const [key, page] of pages) {
        if (page.status !== "active") continue;
        if (event.domain === "file" && page.domain === "file") {
          pages.set(key, { ...page, status: "completed" });
        } else {
          pages.delete(key);
        }
      }
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
    if (event.type === "research_completed") {
      for (const [key, page] of pages) {
        if (page.status === "active") pages.set(key, { ...page, status: "completed" });
      }
    }
    if (event.type === "final_generation_started") {
      for (const [key, page] of pages) {
        // Uploaded files remain visibly active while the model analyzes their
        // extracted or visual content and writes the answer.
        if (page.domain === "file" && page.status !== "failed") {
          pages.set(key, { ...page, status: "active" });
        } else if (page.status === "active") {
          pages.set(key, { ...page, status: "completed" });
        }
      }
    }
    if (event.type === "final_generation_completed") {
      for (const [key, page] of pages) {
        if (page.domain === "file" && page.status === "active") pages.set(key, { ...page, status: "completed" });
      }
    }
    if (event.type === "final_generation_started") generationActive = true;
    if (event.type === "final_generation_completed") generationActive = false;
    if (event.type === "final_generation_failed") {
      generationActive = false;
      generationFailed = true;
      for (const [key, page] of pages) {
        if (page.domain === "file" && page.status === "active") pages.set(key, { ...page, status: "failed" });
      }
    }
  }

  return { query, searchComplete, generationActive, generationFailed, actions: [...actions.values()], pages: [...pages.values()] };
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
  const projectSteps = new Map<string, ChatProgressEvent>();
  for (const event of visible) if (event.type === "project_progress" && event.stage) {
    for (const [key, step] of projectSteps) if (step.status === "active") projectSteps.set(key, { ...step, status: "completed" });
    projectSteps.set(event.stage, event);
  }
  if (failed) for (const [key, step] of projectSteps) if (step.status === "active") projectSteps.set(key, { ...step, status: "failed" });
  const iconPaths: Record<string, string> = {
    project: "M3 7h7l2 2h9v12H3z", files: "M6 3h8l4 4v14H6z M14 3v5h4",
    database: "M4 6c0-4 16-4 16 0v12c0 4-16 4-16 0z M4 6c0 4 16 4 16 0 M4 12c0 4 16 4 16 0",
    agent: "M5 7h14v13H5z M12 3v4 M8 12h1 M15 12h1 M8 16h8",
    dependencies: "M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10",
    build: "M5 4l-3 8 3 8 M19 4l3 8-3 8 M14 6l-4 12",
    preview: "M3 4h18v13H3z M8 21h8 M12 17v4", ready: "M4 12l5 5L20 6",
  };
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
      <button className="research-history-toggle" type="button" title="Show analysis history" aria-label="Show analysis history" onClick={() => setCollapsed(false)}>✓</button>
    </article>;
  }

  return <article className="assistant research-progress" aria-live="polite">
    {projectSteps.size > 0 && <div className="research-page-list project-progress-list">{[...projectSteps.values()].map(step => <div className={`research-page-row ${step.status}`} key={step.stage}>
      <span className="research-progress-state">{step.status === "completed" ? "✓" : step.status === "failed" ? "!" : "●"}</span>
      <svg className="research-progress-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={iconPaths[step.stage ?? "project"]} /></svg>
      <span className={step.status === "active" ? "research-active-text" : undefined}><strong>{step.title}</strong>{step.framework && <small>{step.framework}</small>}</span>
    </div>)}</div>}
    {autoCollapsed && <button className="research-history-toggle expanded" type="button" title="Hide analysis history" aria-label="Hide analysis history" onClick={() => setCollapsed(true)}>✓</button>}

    {!model.searchComplete && model.query && <div className="research-search-row active">
      <span className="research-progress-state">●</span>
      <GlobeIcon />
      <span className="research-active-text">Searching web: {model.query}</span>
    </div>}

    <div className="research-page-list">{model.actions.map((action) => <div className={"research-page-row " + action.status} key={action.key}>
      <span className="research-progress-state">{action.status === "completed" ? "✓" : "●"}</span>
      <DomainIcon domain={action.domain} />
      <a className={action.status === "active" ? "research-active-text" : undefined} href={action.url}>
        <strong>{action.domain}</strong>
        <small>{pageLabel(action)}</small>
      </a>
    </div>)}</div>

    <div className="research-page-list">{model.pages.map((page) => <div className={"research-page-row " + page.status} key={page.key}>
      <span className="research-progress-state">{page.status === "completed" ? "✓" : page.status === "failed" ? "!" : "●"}</span>
      <DomainIcon domain={page.domain} />
      <span className={page.status === "active" ? "research-active-text" : undefined}>
        <strong>{page.domain}</strong>
        <small>{pageLabel(page)}{page.status === "failed" ? " — failed to open" : ""}</small>
      </span>
    </div>)}</div>

    {model.generationActive && <div className="research-generation-row active">
      <span className="research-progress-state">●</span>
      <GenerationStatus />
    </div>}
    {model.generationFailed && <div className="research-generation-row failed">
      <span className="research-progress-state">!</span><span>Failed to prepare response</span>
    </div>}
  </article>;
}
