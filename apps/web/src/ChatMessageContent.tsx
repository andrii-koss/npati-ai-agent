import React, { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { getStoredAuthToken } from "./AuthContext";
import { AttachmentFileIcon } from "./ChatAttachments";

const inlineMarkdown = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|(https?:\/\/[^\s<>()]+))/g;
const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const genericSourceLabel = /^(?:джерело|джерела|source|sources|посилання)$/iu;
const sourceHeading = /^(?:джерела|sources)(?:\s*\(\d+\))?$/iu;
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

  return (
    <div className="chat-table-wrapper">
      <div className="chat-table-header">
        <div className="chat-table-title">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <rect x="8" y="12" width="8" height="8" rx="1" strokeWidth="1.5" />
          </svg>
          <span>Таблиця ({rows.length} {rows.length === 1 ? "рядок" : rows.length < 5 ? "рядки" : "рядків"})</span>
        </div>
        <div className="chat-table-actions">
          <button type="button" className="chat-action-btn" onClick={copyCsv} title="Скопіювати CSV">
            {copied ? "Скопійовано!" : "Копіювати CSV"}
          </button>
          <button type="button" className="chat-action-btn download" onClick={exportCsv} title="Завантажити таблицю як Excel / CSV">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Завантажити Excel / CSV</span>
          </button>
        </div>
      </div>
      <div className="chat-table-scroll">
        <table className="chat-rendered-table">
          <thead>
            <tr>
              {headers.map((h, idx) => (
                <th key={idx}>{renderInlineMarkdown(h, false, sourceTitles)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rIdx) => {
              const rowKey = row[0] ? `row-${row[0]}-${rIdx}` : `row-${rIdx}`;
              return (
                <tr key={rowKey}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx}>
                      {cell ? renderInlineMarkdown(cell, false, sourceTitles) : "\u00A0"}
                    </td>
                  ))}
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
          <button type="button" className="chat-action-btn" onClick={copyText} title="Скопіювати код">
            {copied ? "Скопійовано!" : "Копіювати"}
          </button>
          <button type="button" className="chat-action-btn download" onClick={downloadFile} title="Завантажити файл">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Завантажити {lang === "csv" ? "CSV / Excel" : "файл"}</span>
          </button>
        </div>
      </div>
      <pre className="chat-code-pre"><code>{code}</code></pre>
    </div>
  );
}

export function ChatMessageContent({ content }: { content: string }) {
  const safeContent = content.replace(/<[|｜]end[▁_]of[▁_]sentence[|｜]>/giu, "").trim();
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
      if (lang === "spreadsheet-edit" || lang === "table-edit" || lang === "excel-edit") {
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
