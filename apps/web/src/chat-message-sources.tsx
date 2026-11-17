import { Fragment, useRef, useState, type ReactNode } from "react";

// A bare URL ends at a quote or backtick: `src="https://x/p.js"` and `https://x/` in inline code linked to "p.js%22" and
// "x/%60" (V6 step 17). Neither character is valid unencoded in a URL.
export const inlineMarkdown = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)|\*\*([^*]+)\*\*|(https?:\/\/[^\s<>()"`]+))/g;
export const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
export const genericSourceLabel = /^(?:джерело|джерела|source|sources|посилання)$/iu;
export const sourceHeading = /^(?:#{1,3}\s*)?(?:\*\*)?(?:джерела|sources)(?:\*\*)?(?:\s*\(?\d*\)?)?:?$/iu;
export const inlineSourcePrefix = /(?:^|[\s(])(?:джерело|source)\s*:/iu;

const faviconUrls = new Map<string, string>();
const failedFavicons = new Set<string>();

export function cleanLabel(value: string) {
  return value.replace(/\*\*/g, "").replace(/__/g, "").trim();
}

export function sourceKey(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.searchParams.delete("utm_source");
    return url.toString();
  } catch {
    return value;
  }
}

export function collectSourceTitles(content: string) {
  const titles = new Map<string, string>();
  markdownLink.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = markdownLink.exec(content))) {
    const label = cleanLabel(match[1] ?? "");
    const url = match[2] ?? "";
    if (label && !genericSourceLabel.test(label) && !/^https?:\/\//i.test(label)) {
      titles.set(sourceKey(url), label);
    }
  }
  return titles;
}

export function isSourceCitationLine(line: string, inSourceSection = false) {
  return inSourceSection || inlineSourcePrefix.test(line);
}

export function GlobeIcon() {
  return (
    <svg className="source-link-globe" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21M12 3c-2.4 2.5-3.6 5.5-3.6 9s1.2 6.5 3.6 9" />
    </svg>
  );
}

export function SourceFavicon({ domain }: { domain: string }) {
  const [failed, setFailed] = useState(failedFavicons.has(domain));
  if (failed || !domain) return <GlobeIcon />;
  let src = faviconUrls.get(domain);
  if (!src) {
    src = "https://" + domain + "/favicon.ico";
    faviconUrls.set(domain, src);
  }
  return (
    <img
      className="source-link-favicon"
      src={src}
      alt=""
      loading="lazy"
      onError={() => {
        failedFavicons.add(domain);
        setFailed(true);
      }}
    />
  );
}

export function fallbackSourceTitle(url: URL) {
  const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "");
  return path ? url.hostname.replace(/^www\./, "") + " / " + path : url.hostname.replace(/^www\./, "");
}

export function SourceLink({
  rawUrl,
  href,
  title,
  label,
}: {
  rawUrl: string;
  href: string;
  title?: string;
  label?: string;
}) {
  const [alignRight, setAlignRight] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  const checkAlignment = () => {
    if (wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      const distFromRight = window.innerWidth - rect.right;
      if (distFromRight < 350 || rect.left > window.innerWidth * 0.55) {
        setAlignRight(true);
      } else {
        setAlignRight(false);
      }
    }
  };

  let domain = "";
  let path = "";
  try {
    const url = new URL(rawUrl);
    domain = url.hostname.toLowerCase().replace(/^www\./, "");
    path = decodeURIComponent(url.pathname + url.search);
  } catch {
    domain = rawUrl.replace(/^https?:\/\//i, "").replace(/^www\./, "").split("/")[0] || "";
  }
  const cleanLbl = label ? cleanLabel(label) : "";
  const isGeneric = !cleanLbl || genericSourceLabel.test(cleanLbl) || /^https?:\/\//i.test(cleanLbl);
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {}
  const previewTitle =
    title || (!isGeneric ? cleanLbl : parsedUrl ? fallbackSourceTitle(parsedUrl) : domain || rawUrl);
  const displayLabel = !isGeneric ? cleanLbl : domain || rawUrl;

  return (
    <span
      ref={wrapRef}
      className={`source-link-wrap ${alignRight ? "align-right" : ""}`}
      onMouseEnter={checkAlignment}
      onFocus={checkAlignment}
    >
      <a
        className="source-link-chip"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={"Open link " + (domain || displayLabel)}
      >
        <SourceFavicon domain={domain} />
        <span>{displayLabel}</span>
      </a>
      <span className="source-link-preview" role="tooltip">
        <span className="source-link-preview-head">
          <SourceFavicon domain={domain} />
          <span>{domain}</span>
        </span>
        <strong>{previewTitle}</strong>
        {path && <small>{path}</small>}
      </span>
    </span>
  );
}

export function toTrackedChatUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "npati.com" && /^\/hub\/?$/i.test(url.pathname)) {
      url.hostname = "www.npati.com";
      url.pathname = "/hub/";
    }
    url.searchParams.set("utm_source", "NPATI_Agent");
    return url.toString();
  } catch {
    return "";
  }
}

export function renderInlineMarkdown(
  content: string,
  _sourceMode: boolean,
  sourceTitles: Map<string, string>
) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  inlineMarkdown.lastIndex = 0;
  while ((match = inlineMarkdown.exec(content))) {
    if (match.index > cursor) nodes.push(unescapeMarkdown(content.slice(cursor, match.index)));
    const key = match.index + "-" + match[0];
    if (match[2] && match[3]) {
      const label = cleanLabel(match[2]);
      const url = match[3];
      if (url.startsWith("/")) {
        nodes.push(
          <a
            key={key}
            href={url}
            className="chat-internal-link"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              color: "var(--brand-500, #3b82f6)",
              fontWeight: 600,
              textDecoration: "underline",
            }}
          >
            {label}
          </a>
        );
      } else {
        const href = toTrackedChatUrl(url);
        nodes.push(
          href ? (
            <SourceLink
              key={key}
              rawUrl={url}
              href={href}
              title={sourceTitles.get(sourceKey(url))}
              label={label}
            />
          ) : (
            label
          )
        );
      }
    } else if (match[4]) {
      nodes.push(<strong key={key}>{unescapeMarkdown(match[4])}</strong>);
    } else if (match[5]) {
      const trailing = match[5].match(/[.,;:!?]+$/)?.[0] ?? "";
      const rawUrl = trailing ? match[5].slice(0, -trailing.length) : match[5];
      const href = toTrackedChatUrl(rawUrl);
      nodes.push(
        href ? (
          <Fragment key={key}>
            <SourceLink
              rawUrl={rawUrl}
              href={href}
              title={sourceTitles.get(sourceKey(rawUrl))}
            />
            {trailing}
          </Fragment>
        ) : (
          match[5]
        )
      );
    }
    cursor = inlineMarkdown.lastIndex;
  }
  if (cursor < content.length) nodes.push(unescapeMarkdown(content.slice(cursor)));
  return nodes;
}

/** Markdown backslash escapes are syntax, not text: an email card showed "agent@npati\.test" (V6 step 12). */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+.!|<>~-])/g, "$1");
}
