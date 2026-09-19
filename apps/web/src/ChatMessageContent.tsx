import React, { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getStoredAuthToken } from "./AuthContext";
import { AttachmentFileIcon } from "./ChatAttachments";

const inlineMarkdown = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)|\*\*([^*]+)\*\*|(https?:\/\/[^\s<>()]+))/g;
const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const genericSourceLabel = /^(?:джерело|джерела|source|sources|посилання)$/iu;
const sourceHeading = /^(?:#{1,3}\s*)?(?:\*\*)?(?:джерела|sources)(?:\*\*)?(?:\s*\(?\d*\)?)?:?$/iu;
const inlineSourcePrefix = /(?:^|[\s(])(?:джерело|source)\s*:/iu;

const attachmentLine = new RegExp("^\\[\\[npati-attachment:(image|audio|document|file):([0-9a-f-]{36}):(.+)\\]\\]$", "i");
const voiceMessageRegex = /^(?:🎤\s*)?Voice message:\s*([^\n\r]+)$/i;
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
    if (label && !genericSourceLabel.test(label) && !/^https?:\/\//i.test(label)) {
      titles.set(sourceKey(url), label);
    }
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

function SourceLink({ rawUrl, href, title, label }: { rawUrl: string; href: string; title?: string; label?: string }) {
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
  try { parsedUrl = new URL(rawUrl); } catch {}
  const previewTitle = title || (!isGeneric ? cleanLbl : (parsedUrl ? fallbackSourceTitle(parsedUrl) : domain || rawUrl));
  const displayLabel = !isGeneric ? cleanLbl : (domain || rawUrl);

  return (
    <span
      ref={wrapRef}
      className={`source-link-wrap ${alignRight ? "align-right" : ""}`}
      onMouseEnter={checkAlignment}
      onFocus={checkAlignment}
    >
      <a className="source-link-chip" href={href} target="_blank" rel="noopener noreferrer" aria-label={"Open link " + (domain || displayLabel)}>
        <SourceFavicon domain={domain} />
        <span>{displayLabel}</span>
      </a>
      <span className="source-link-preview" role="tooltip">
        <span className="source-link-preview-head"><SourceFavicon domain={domain} /><span>{domain}</span></span>
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
        nodes.push(href
          ? <SourceLink key={key} rawUrl={url} href={href} title={sourceTitles.get(sourceKey(url))} label={label} />
          : label);
      }
    } else if (match[4]) {
      nodes.push(<strong key={key}>{match[4]}</strong>);
    } else if (match[5]) {
      const trailing = match[5].match(/[.,;:!?]+$/)?.[0] ?? "";
      const rawUrl = trailing ? match[5].slice(0, -trailing.length) : match[5];
      const href = toTrackedChatUrl(rawUrl);
      nodes.push(href
        ? <Fragment key={key}><SourceLink rawUrl={rawUrl} href={href} title={sourceTitles.get(sourceKey(rawUrl))} />{trailing}</Fragment>
        : match[5]);
    }
    cursor = inlineMarkdown.lastIndex;
  }
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

function AudioAttachmentPlayer({
  id,
  name,
  fallbackText,
}: {
  id: string;
  name: string;
  fallbackText?: string;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let unmounted = false;

    async function loadAudio() {
      setLoading(true);
      setError(null);
      try {
        const token = getStoredAuthToken();
        const url = `/api/attachments/${id}${token ? "?token=" + encodeURIComponent(token) : ""}`;
        const res = await fetch(url, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) {
          const blob = await res.blob();
          if (unmounted) return;
          const objectUrl = URL.createObjectURL(blob);
          audioUrlRef.current = objectUrl;
          setAudioUrl(objectUrl);
          return;
        }

        // Fallback for speech files if attachment endpoint fails
        if (name.startsWith("speech-") && fallbackText?.trim()) {
          const voiceMatch = name.match(/^speech-([a-zA-Z0-9_-]+)\.mp3$/i);
          const voice = voiceMatch ? voiceMatch[1]! : "alloy";
          const speechRes = await fetch("/api/audio/speech", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ input: fallbackText.trim(), format: "mp3", voice }),
          });
          if (speechRes.ok) {
            const blob = await speechRes.blob();
            if (unmounted) return;
            const objectUrl = URL.createObjectURL(blob);
            audioUrlRef.current = objectUrl;
            setAudioUrl(objectUrl);
            return;
          }
        }

        throw new Error(`HTTP ${res.status}`);
      } catch {
        if (!unmounted) setError("Could not load audio recording");
      } finally {
        if (!unmounted) setLoading(false);
      }
    }

    void loadAudio();

    return () => {
      unmounted = true;
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, [id, name, fallbackText]);

  return (
    <figure className="chat-message-attachment audio">
      {audioUrl ? (
        <audio controls preload="metadata" src={audioUrl} />
      ) : loading ? (
        <div className="chat-audio-loading">
          <span className="chat-audio-spinner" />
          <span>Loading voice recording…</span>
        </div>
      ) : error ? (
        <div className="chat-audio-error">
          <span>{error}</span>
        </div>
      ) : null}
      <figcaption className="chat-audio-figcaption">
        <span>{name}</span>
        {audioUrl && (
          <a
            href={audioUrl}
            download={name}
            className="chat-attachment-download-btn"
            title={"Download " + name}
            aria-label={"Download " + name}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Download</span>
          </a>
        )}
      </figcaption>
    </figure>
  );
}

function SynthesizedVoiceAudioPlayer({
  filename,
  inputText,
  voice,
}: {
  filename: string;
  inputText: string;
  voice: string;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let unmounted = false;
    async function loadAudio() {
      if (audioUrlRef.current || !inputText.trim()) return;
      setLoading(true);
      setError(null);
      try {
        const token = getStoredAuthToken();
        const res = await fetch("/api/audio/speech", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ input: inputText.trim(), format: "mp3", voice }),
        });
        if (!res.ok) throw new Error("TTS generation failed");
        const blob = await res.blob();
        if (unmounted) return;
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        setAudioUrl(url);
      } catch {
        if (!unmounted) setError("Could not load audio recording");
      } finally {
        if (!unmounted) setLoading(false);
      }
    }

    void loadAudio();

    return () => {
      unmounted = true;
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, [inputText, voice]);

  return (
    <figure className="chat-message-attachment audio">
      {audioUrl ? (
        <audio controls preload="metadata" src={audioUrl} />
      ) : loading ? (
        <div className="chat-audio-loading">
          <span className="chat-audio-spinner" />
          <span>Generating voice recording…</span>
        </div>
      ) : error ? (
        <div className="chat-audio-error">
          <span>{error}</span>
        </div>
      ) : null}
      <figcaption className="chat-audio-figcaption">
        <span>{filename}</span>
        {audioUrl && (
          <a
            href={audioUrl}
            download={filename}
            className="chat-attachment-download-btn"
            title={"Download " + filename}
            aria-label={"Download " + filename}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Download</span>
          </a>
        )}
      </figcaption>
    </figure>
  );
}

function escapeCsvValue(val: string): string {
  const str = String(val ?? "").trim();
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const RenderedTableBlock = React.memo(function RenderedTableBlock({
  headers,
  rows,
  sourceTitles,
}: {
  headers: string[];
  rows: string[][];
  sourceTitles: Map<string, string>;
}) {
  const [copied, setCopied] = useState(false);

  function exportCsv() {
    const csvContent = "\uFEFF" + [
      headers.map(escapeCsvValue).join(","),
      ...rows.map(r => r.map(escapeCsvValue).join(","))
    ].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "edited_table.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function copyCsv() {
    const csvContent = [
      headers.map(escapeCsvValue).join(","),
      ...rows.map(r => r.map(escapeCsvValue).join(","))
    ].join("\n");
    navigator.clipboard.writeText(csvContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const isIndexHeader = (h?: string) => Boolean(h && /^([#№]|no\.?|id)$/i.test(h.trim()));

  return (
    <div className="chat-table-wrapper">
      <div className="chat-table-header">
        <div className="chat-table-title">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="3" y1="15" x2="21" y2="15" />
            <line x1="9" y1="9" x2="9" y2="21" />
            <line x1="15" y1="9" x2="15" y2="21" />
          </svg>
          <span>Table ({rows.length} {rows.length === 1 ? "row" : "rows"})</span>
        </div>
        <div className="chat-table-actions">
          <button type="button" className={`chat-action-btn ${copied ? "copied" : ""}`} onClick={copyCsv} title="Copy CSV">
            {copied ? (
              <>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Copied!</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>Copy CSV</span>
              </>
            )}
          </button>
          <button type="button" className="chat-action-btn download" onClick={exportCsv} title="Download table as Excel / CSV">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Download Excel / CSV</span>
          </button>
        </div>
      </div>
      <div className="chat-table-scroll">
        <table className="chat-rendered-table">
          <thead>
            <tr>
              {headers.map((h, idx) => (
                <th key={idx} className={isIndexHeader(h) ? "th-index" : ""}>
                  {renderInlineMarkdown(h, false, sourceTitles)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rIdx) => {
              const rowKey = row[0] ? `row-${row[0]}-${rIdx}` : `row-${rIdx}`;
              return (
                <tr key={rowKey}>
                  {row.map((cell, cIdx) => {
                    const isIndex = isIndexHeader(headers[cIdx]);
                    const isPrimary = cIdx === 0 && !isIndex;
                    return (
                      <td
                        key={cIdx}
                        className={isIndex ? "td-index" : isPrimary ? "td-primary-cell" : ""}
                      >
                        {cell ? renderInlineMarkdown(cell, false, sourceTitles) : "\u00A0"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
});

function RenderedCodeBlock({ code, lang, filename }: { code: string; lang: string; filename?: string }) {
  const [copied, setCopied] = useState(false);

  function copyText() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function downloadFile() {
    const ext = filename
      ? filename.split(".").pop() || "txt"
      : lang === "csv" ? "csv"
      : lang === "tsv" ? "tsv"
      : lang === "json" ? "json"
      : lang === "python" || lang === "py" ? "py"
      : lang === "typescript" || lang === "ts" ? "ts"
      : lang === "javascript" || lang === "js" ? "js"
      : lang === "html" ? "html"
      : lang === "css" ? "css"
      : lang === "sql" ? "sql"
      : lang === "yaml" || lang === "yml" ? "yaml"
      : "txt";

    const name = filename || `export.${ext}`;
    const isCsvOrTsv = ext === "csv" || ext === "tsv";
    const content = isCsvOrTsv ? "\uFEFF" + code : code;
    const blob = new Blob([content], { type: isCsvOrTsv ? "text/csv;charset=utf-8;" : "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="chat-code-block-wrapper">
      <div className="chat-code-header">
        <span className="chat-code-lang">{filename || lang || "code"}</span>
        <div className="chat-code-actions">
          <button type="button" className="chat-action-btn" onClick={copyText} title="Copy code">
            {copied ? "Copied!" : "Copy"}
          </button>
          <button type="button" className="chat-action-btn download" onClick={downloadFile} title="Download file">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Download {lang === "csv" ? "CSV / Excel" : "file"}</span>
          </button>
        </div>
      </div>
      <pre className="chat-code-pre"><code>{code}</code></pre>
    </div>
  );
}

function markdownToCardHtml(md: string): string {
  if (!md) return "";
  // Normalize em-dashes and en-dashes to standard hyphen
  const cleanMd = md.replace(/[\u2014\u2013]/g, " - ");
  const lines = cleanMd.split("\n");
  const htmlParts: string[] = [];
  let inList = false;
  let listType: "ul" | "ol" = "ul";

  const formatInline = (str: string): string => {
    let s = str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    // Bold: **text** or __text__
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    // Italic: *text* (when not bold) or _text_
    s = s.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, "$1<em>$2</em>$3");
    // Code inline: `code`
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Links: [label](url)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '<a href="$2" class="chat-card-link" style="color:var(--brand-500, #3b82f6);text-decoration:underline;font-weight:600;display:inline-flex;margin-top:4px;">$1</a>');
    return s;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    // Check headings
    const h1 = trimmed.match(/^#\s+(.+)$/);
    const h2 = trimmed.match(/^##\s+(.+)$/);
    const h3 = trimmed.match(/^###\s+(.+)$/);
    const h4 = trimmed.match(/^####\s+(.+)$/);

    // Check list items
    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    const numMatch = trimmed.match(/^\d+\.\s+(.+)$/);

    if (bulletMatch || numMatch) {
      const isNum = !bulletMatch;
      const targetType = isNum ? "ol" : "ul";
      if (!inList) {
        inList = true;
        listType = targetType;
        htmlParts.push(`<${listType}>`);
      } else if (listType !== targetType) {
        htmlParts.push(`</${listType}>`);
        listType = targetType;
        htmlParts.push(`<${listType}>`);
      }
      const itemContent = formatInline(bulletMatch ? bulletMatch[1]! : numMatch![1]!);
      htmlParts.push(`<li>${itemContent}</li>`);
      continue;
    }

    if (inList) {
      htmlParts.push(`</${listType}>`);
      inList = false;
    }

    if (!trimmed) {
      continue;
    }

    if (h1) {
      htmlParts.push(`<h1>${formatInline(h1[1]!)}</h1>`);
    } else if (h2) {
      htmlParts.push(`<h2>${formatInline(h2[1]!)}</h2>`);
    } else if (h3) {
      htmlParts.push(`<h3>${formatInline(h3[1]!)}</h3>`);
    } else if (h4) {
      htmlParts.push(`<h4>${formatInline(h4[1]!)}</h4>`);
    } else {
      htmlParts.push(`<p>${formatInline(trimmed)}</p>`);
    }
  }

  if (inList) {
    htmlParts.push(`</${listType}>`);
  }

  return htmlParts.join("");
}

function EditableContentCard({
  initialContent,
  title,
}: {
  initialContent: string;
  title: string;
}) {
  const initialHtml = useMemo(() => markdownToCardHtml(initialContent), [initialContent]);
  const [copied, setCopied] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isUserEditedRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const modalBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isUserEditedRef.current) {
      const html = markdownToCardHtml(initialContent);
      if (bodyRef.current && document.activeElement !== bodyRef.current) {
        bodyRef.current.innerHTML = html;
      }
      if (modalBodyRef.current && document.activeElement !== modalBodyRef.current) {
        modalBodyRef.current.innerHTML = html;
      }
    }
  }, [initialContent]);

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    isUserEditedRef.current = true;
    const html = e.currentTarget.innerHTML;
    if (bodyRef.current && e.currentTarget !== bodyRef.current) {
      bodyRef.current.innerHTML = html;
    }
    if (modalBodyRef.current && e.currentTarget !== modalBodyRef.current) {
      modalBodyRef.current.innerHTML = html;
    }
  };

  const handleCopy = async () => {
    const textToCopy = (bodyRef.current?.innerText ?? initialContent).replace(/[\u2014\u2013]/g, " - ");
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = textToCopy;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    const textToDownload = (bodyRef.current?.innerText ?? initialContent).replace(/[\u2014\u2013]/g, " - ");
    const cleanTitle = (title || "dokument").replace(/[\s/\\?%*:|"<>]+/g, "_").trim();
    const blob = new Blob([textToDownload], { type: "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${cleanTitle}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const toggleFullscreen = () => {
    setIsFullscreen((prev) => {
      const next = !prev;
      if (next) {
        requestAnimationFrame(() => {
          if (modalBodyRef.current && bodyRef.current) {
            modalBodyRef.current.innerHTML = bodyRef.current.innerHTML;
          }
        });
      }
      return next;
    });
  };

  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  return (
    <>
      <div className="editable-content-card">
        <div className="editable-card-header">
          <span className="editable-card-title">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <span>{title}</span>
          </span>
          <div className="editable-card-actions">
            <button
              type="button"
              className={`editable-card-action-btn ${copied ? "copied" : ""}`}
              onClick={handleCopy}
              title={copied ? "Copied!" : "Copy entire text"}
              aria-label="Copy entire text"
            >
              {copied ? (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="editable-card-action-btn"
              onClick={handleDownload}
              title="Download file"
              aria-label="Download file"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            <button
              type="button"
              className="editable-card-action-btn"
              onClick={toggleFullscreen}
              title="Expand to fullscreen"
              aria-label="Expand to fullscreen"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          </div>
        </div>
        <div
          ref={bodyRef}
          className="editable-card-body"
          contentEditable={true}
          suppressContentEditableWarning={true}
          spellCheck={true}
          onInput={handleInput}
          dangerouslySetInnerHTML={{ __html: initialHtml }}
        />
      </div>

      {isFullscreen && (
        <div className="editable-card-modal-backdrop" onClick={toggleFullscreen}>
          <div className="editable-card-modal" onClick={(e) => e.stopPropagation()}>
            <div className="editable-card-header">
              <span className="editable-card-title">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
                <span>{title}</span>
              </span>
              <div className="editable-card-actions">
                <button
                  type="button"
                  className={`editable-card-action-btn ${copied ? "copied" : ""}`}
                  onClick={handleCopy}
                  title={copied ? "Copied!" : "Copy entire text"}
                  aria-label="Copy entire text"
                >
                  {copied ? (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  className="editable-card-action-btn"
                  onClick={handleDownload}
                  title="Download file"
                  aria-label="Download file"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="editable-card-action-btn"
                  onClick={toggleFullscreen}
                  title="Collapse"
                  aria-label="Collapse"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 14 10 14 10 20" />
                    <polyline points="20 10 14 10 14 4" />
                    <line x1="14" y1="10" x2="21" y2="3" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </button>
              </div>
            </div>
            <div
              ref={modalBodyRef}
              className="editable-card-body"
              contentEditable={true}
              suppressContentEditableWarning={true}
              spellCheck={true}
              onInput={handleInput}
              dangerouslySetInnerHTML={{ __html: bodyRef.current ? bodyRef.current.innerHTML : initialHtml }}
            />
          </div>
        </div>
      )}
    </>
  );
}

export function ChatMessageContent({ content }: { content: string }) {
  const safeContent = content
    .replace(/[\u2014\u2013]/g, " - ")
    .replace(/<[|｜]end[▁_]of[▁_]sentence[|｜]>/giu, "")
    .replace(/\[([\s\S]*?)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g, (_full, label: string, url: string) => {
      return "[" + label.replace(/\r?\n\s*/g, " ").trim() + "](" + url.trim() + ")";
    })
    .trim();
  if (!safeContent) return null;
  const sourceTitles = collectSourceTitles(safeContent);

  const lines = safeContent.split("\n");
  const elements: ReactNode[] = [];
  let inSourceSection = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 1. Code blocks: ```lang
    if (line.trim().startsWith("```")) {
      const langHeader = line.trim().slice(3).trim();
      let lang = langHeader;
      let filename: string | undefined;
      if (langHeader.includes(":")) {
        const parts = langHeader.split(":");
        lang = parts[0]!.trim();
        filename = parts.slice(1).join(":").trim();
      } else if (langHeader.includes(" ") && /\.[a-z0-9]+$/i.test(langHeader)) {
        const parts = langHeader.split(/\s+/);
        lang = parts[0]!.trim();
        filename = parts[1]!.trim();
      }
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      if (lang === "spreadsheet-edit" || lang === "table-edit" || lang === "excel-edit" || lang === "business-action" || lang === "business-profile" || lang === "goal-action" || lang === "goal-profile") {
        continue;
      }
      const isCardBlock = /^(?:card|artifact|document|idea|draft|canvas|box|post|text-block|goal)$/i.test(lang);
      if (isCardBlock) {
        elements.push(
          <EditableContentCard
            key={`card-${elements.length}`}
            initialContent={codeLines.join("\n")}
            title={filename || (lang === "idea" ? "Business Idea" : lang === "goal" ? "Business Goal" : "Business Document")}
          />
        );
        continue;
      }
      elements.push(
        <RenderedCodeBlock
          key={`code-${elements.length}`}
          code={codeLines.join("\n")}
          lang={lang}
          filename={filename}
        />
      );
      continue;
    }

    // 2. Markdown tables: line starts with | and delimiter is next
    const isTableStart = line.trim().startsWith("|") && line.trim().replace(/[\s|]/g, "").length > 0;
    const isDelimiter = i + 1 < lines.length && /^\|?(\s*:?-+:?\s*\|?)+$/.test(lines[i + 1]!.trim());
    if (isTableStart && isDelimiter) {
      const tableStartIdx = i;
      const parseCells = (row: string) => {
        const trimmed = row.trim();
        const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
        return stripped.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
      };
      const headers = parseCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const rawLine = lines[i]!.trim();
        if (/^\|?(\s*:?-+:?\s*\|?)+$/.test(rawLine)) {
          i++;
          continue;
        }
        const cells = parseCells(rawLine);
        while (cells.length < headers.length) {
          cells.push("");
        }
        if (cells.length > headers.length) {
          cells.length = headers.length;
        }
        rows.push(cells);
        i++;
      }
      elements.push(
        <RenderedTableBlock
          key={`table-block-${tableStartIdx}`}
          headers={headers}
          rows={rows}
          sourceTitles={sourceTitles}
        />
      );
      continue;
    }

    // 3. Attachments
    const attachment = line.match(attachmentLine);
    if (attachment) {
      const kind = attachment[1]!;
      const id = attachment[2]!;
      let name = "attachment";
      try { name = decodeURIComponent(attachment[3]!); } catch {}
      const token = getStoredAuthToken();
      const src = "/api/attachments/" + id + (token ? "?token=" + encodeURIComponent(token) : "");
      const nonAttachmentLines = safeContent
        .split("\n")
        .filter((l) => !attachmentLine.test(l) && !voiceMessageRegex.test(l) && !/^Transcript:\s*/i.test(l))
        .map((l) => l.trim())
        .filter(Boolean);
      const textContext = nonAttachmentLines.join(" ");

      elements.push(
        kind === "image" ? (
          <figure className="chat-message-attachment image" key={`att-${elements.length}`}>
            <img src={src} alt={name} loading="eager" onLoad={() => window.dispatchEvent(new CustomEvent("npati:chat-image-loaded"))} />
            <figcaption>{name}</figcaption>
          </figure>
        ) : kind === "audio" ? (
          <AudioAttachmentPlayer key={`att-${elements.length}`} id={id} name={name} fallbackText={textContext} />
        ) : (
          <figure className="chat-message-attachment document" key={`att-${elements.length}`}>
            <AttachmentFileIcon item={{ name, kind }} />
            <div className="chat-document-info">
              <span className="chat-document-name" title={name}>{name}</span>
              <a href={src} download={name} className="chat-attachment-download-btn" title={"Download " + name} aria-label={"Download " + name}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>Download</span>
              </a>
            </div>
          </figure>
        )
      );
      i++;
      continue;
    }

    // 4. Voice synthesized messages
    const voiceMatch = line.match(voiceMessageRegex);
    if (voiceMatch) {
      const filename = voiceMatch[1]!.trim();
      const voiceNameMatch = filename.match(/^speech-([a-zA-Z0-9_-]+)\.mp3$/i);
      const voice = voiceNameMatch ? voiceNameMatch[1]! : "alloy";
      const nonVoiceLines = safeContent
        .split("\n")
        .filter((l) => !voiceMessageRegex.test(l) && !/^Transcript:\s*/i.test(l) && !attachmentLine.test(l))
        .map((l) => l.trim())
        .filter(Boolean);
      const textToSpeak = nonVoiceLines.join(" ") || "Speech recording";
      elements.push(
        <SynthesizedVoiceAudioPlayer
          key={`voice-${elements.length}`}
          filename={filename}
          inputText={textToSpeak}
          voice={voice}
        />
      );
      i++;
      continue;
    }

    // 5. Transcript
    if (/^Transcript:\s*/i.test(line)) {
      elements.push(
        <div className="chat-audio-transcript" key={`tr-${elements.length}`}>
          <small>{line}</small>
        </div>
      );
      i++;
      continue;
    }

    // 6. Heading
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      inSourceSection = sourceHeading.test(cleanLabel(heading[2]!));
      elements.push(
        <h3 key={`h-${elements.length}`}>
          {renderInlineMarkdown(heading[2]!, false, sourceTitles)}
        </h3>
      );
      i++;
      continue;
    }
    if (sourceHeading.test(cleanLabel(line))) {
      inSourceSection = true;
      elements.push(
        <h3 key={`src-head-${elements.length}`}>
          {renderInlineMarkdown(line, false, sourceTitles)}
        </h3>
      );
      i++;
      continue;
    }

    // 7. Space
    if (!line.trim()) {
      elements.push(<div className="chat-message-space" key={`sp-${elements.length}`} aria-hidden="true" />);
      i++;
      continue;
    }

    // 8. Normal line
    elements.push(
      <div className="chat-message-line" key={`line-${elements.length}`}>
        {renderInlineMarkdown(line, isSourceCitationLine(line, inSourceSection), sourceTitles)}
      </div>
    );
    i++;
  }

  return <div className="chat-message-content">{elements}</div>;
}
