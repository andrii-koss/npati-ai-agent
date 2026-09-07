import React, { Fragment, useState, type ReactNode } from "react";

const inlineMarkdown = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|(https?:\/\/[^\s<>()]+))/g;
const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const genericSourceLabel = /^(?:джерело|джерела|source|sources|посилання)$/iu;
const sourceHeading = /^(?:джерела|sources)(?:\s*\(\d+\))?$/iu;
const inlineSourcePrefix = /(?:^|[\s(])(?:джерело|source)\s*:/iu;

const attachmentLine = new RegExp("^\\[\\[npati-attachment:(image|audio|document|file):([0-9a-f-]{36}):(.+)\\]\\]$", "i");
const faviconUrls = new Map<string, string>();
const failedFavicons = new Set<string>();

function cleanLabel(value: string) {
  return value.replace(/\*\*/g, "").replace(/__/g, "").trim();
}

function sourceKey(value: string) {
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
    if (label && !genericSourceLabel.test(label)) titles.set(sourceKey(url), label);
  }
  return titles;
}

export function isSourceCitationLine(line: string, inSourceSection = false) {
  return inSourceSection || inlineSourcePrefix.test(line);
}

function GlobeIcon() {
  return <svg className="source-link-globe" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21M12 3c-2.4 2.5-3.6 5.5-3.6 9s1.2 6.5 3.6 9" /></svg>;
}

function SourceFavicon({ domain }: { domain: string }) {
  const [failed, setFailed] = useState(failedFavicons.has(domain));
  if (failed || !domain) return <GlobeIcon />;
  let src = faviconUrls.get(domain);
  if (!src) {
    src = "https://" + domain + "/favicon.ico";
    faviconUrls.set(domain, src);
  }
  return <img className="source-link-favicon" src={src} alt="" loading="lazy" onError={() => {
    failedFavicons.add(domain);
    setFailed(true);
  }} />;
}

function fallbackSourceTitle(url: URL) {
  const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "");
  return path ? url.hostname.replace(/^www\./, "") + " / " + path : url.hostname.replace(/^www\./, "");
}

function SourceLink({ rawUrl, href, title }: { rawUrl: string; href: string; title?: string }) {
  const url = new URL(rawUrl);
  const domain = url.hostname.toLowerCase().replace(/^www\./, "");
  const previewTitle = title || fallbackSourceTitle(url);
  return <span className="source-link-wrap">
    <a className="source-link-chip" href={href} target="_blank" rel="noopener noreferrer" aria-label={"Відкрити джерело " + domain}>
      <SourceFavicon domain={domain} />
      <span>{domain}</span>
    </a>
    <span className="source-link-preview" role="tooltip">
      <span className="source-link-preview-head"><SourceFavicon domain={domain} /><span>{domain}</span></span>
      <strong>{previewTitle}</strong>
      <small>{url.pathname + url.search}</small>
    </span>
  </span>;
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

function renderInlineMarkdown(content: string, sourceMode: boolean, sourceTitles: Map<string, string>) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  inlineMarkdown.lastIndex = 0;
  while ((match = inlineMarkdown.exec(content))) {
    if (match.index > cursor) nodes.push(content.slice(cursor, match.index));
    const key = match.index + "-" + match[0];
    if (match[2] && match[3]) {
      const label = cleanLabel(match[2]);
      const href = toTrackedChatUrl(match[3]);
      const isSource = sourceMode || genericSourceLabel.test(label);
      nodes.push(href
        ? isSource
          ? <SourceLink key={key} rawUrl={match[3]} href={href} title={sourceTitles.get(sourceKey(match[3]))} />
          : <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a>
        : label);
    } else if (match[4]) {
      nodes.push(<strong key={key}>{match[4]}</strong>);
    } else if (match[5]) {
      const trailing = match[5].match(/[.,;:!?]+$/)?.[0] ?? "";
      const rawUrl = trailing ? match[5].slice(0, -trailing.length) : match[5];
      const href = toTrackedChatUrl(rawUrl);
      nodes.push(href
        ? <Fragment key={key}><a href={href} target="_blank" rel="noopener noreferrer">{rawUrl}</a>{trailing}</Fragment>
        : match[5]);
    }
    cursor = inlineMarkdown.lastIndex;
  }
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

export function ChatMessageContent({ content }: { content: string }) {
  const safeContent = content.replace(/<[|｜]end[▁_]of[▁_]sentence[|｜]>/giu, "").trim();
  if (!safeContent) return null;
  const sourceTitles = collectSourceTitles(safeContent);
  let inSourceSection = false;
  return (
    <div className="chat-message-content">
      {safeContent.split("\n").map((line, index) => {
        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        const attachment = line.match(attachmentLine);
        if (attachment) {
          const kind = attachment[1]!;
          const id = attachment[2]!;
          let name = "attachment";
          try { name = decodeURIComponent(attachment[3]!); } catch { /* keep safe fallback */ }
          const src = "/api/attachments/" + id;
          return kind === "image"
            ? <figure className="chat-message-attachment image" key={index}><img src={src} alt={name} loading="lazy" /><figcaption>{name}</figcaption></figure>
            : kind === "audio"
              ? <figure className="chat-message-attachment audio" key={index}><audio controls preload="metadata" src={src} /><figcaption>{name}</figcaption></figure>
              : <figure className="chat-message-attachment document" key={index}><a href={src} download={name}>Download {name}</a><figcaption>{name}</figcaption></figure>;
        }
        if (heading) {
          inSourceSection = sourceHeading.test(cleanLabel(heading[2]!));
          return <h3 key={index}>{renderInlineMarkdown(heading[2]!, false, sourceTitles)}</h3>;
        }
        if (!line) return <div className="chat-message-space" key={index} aria-hidden="true" />;
        return <div className="chat-message-line" key={index}>{renderInlineMarkdown(line, isSourceCitationLine(line, inSourceSection), sourceTitles)}</div>;
      })}
    </div>
  );
}
