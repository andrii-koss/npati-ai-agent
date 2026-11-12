import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getStoredAuthToken } from "./AuthContext";
import { AttachmentFileIcon } from "./ChatAttachments";
import { cardLinkHtml, escapeInlineText } from "./chat-markdown-inline";
import type { ProjectCardData } from "@npati/shared";
import {
  cleanLabel,
  collectSourceTitles,
  isSourceCitationLine,
  renderInlineMarkdown,
  sourceHeading,
  toTrackedChatUrl,
} from "./chat-message-sources";
import { AudioAttachmentPlayer, SynthesizedVoiceAudioPlayer } from "./chat-message-audio";
import { RenderedCodeBlock, RenderedTableBlock } from "./chat-message-code-table";
import { codingStopCopy } from "./coding-stop-copy";
import { approvalLine, ChatApprovalCard } from "./chat-approval-card";
import { messageLanguage } from "./approval-i18n";

export { collectSourceTitles, isSourceCitationLine, toTrackedChatUrl };

export function projectChatText(content: string, card?: ProjectCardData, language?: string): string {
  const stop = codingStopCopy(content,language);
  if (stop !== content) return stop;
  if (card?.kind !== "code_project" && card?.status === "previewing" && (card.buildStatus ?? card.lastBuildStatus) === "success" && content.length > 300) {
    return `Проєкт «${card.name}» готовий. Build успішний, Live Preview працює.`;
  }
  if (card && (content === card.name || /^(?:Coding Agent session started\.|Агент готує проєкт)/u.test(content.trim()))) {
    return "";
  }
  return content;
}

const attachmentLine = new RegExp("^\\[\\[npati-attachment:(image|audio|document|file):([0-9a-f-]{36}):(.+)\\]\\]$", "i");
const voiceMessageRegex = /^(?:🎤\s*)?Voice message:\s*([^\n\r]+)$/i;
const internalActionFences = ["business-action", "business-profile", "goal-action", "goal-profile", "company-action", "workspace-action"];
export function stripInternalChatActions(content: string, streaming = false): string {
  content = content.replace(/<[^>]*DSML[^>]*calls[^>]*>[\s\S]*?(?:<[^>]*\/[^>]*DSML[^>]*calls[^>]*>|$)/gi, "");
  let visible = "";
  let cursor = 0;
  while (cursor < content.length) {
    const opening = content.indexOf("```", cursor);
    if (opening < 0) {
      visible += content.slice(cursor);
      break;
    }
    visible += content.slice(cursor, opening);
    const headerStart = opening + 3;
    const lineEnd = content.indexOf("\n", headerStart);
    const header = content.slice(headerStart, lineEnd < 0 ? undefined : lineEnd).trim().toLowerCase();
    const actionFence = lineEnd < 0
      ? internalActionFences.some((label) => label.startsWith(header))
      : internalActionFences.includes(header);
    if (!actionFence) {
      const closing = lineEnd < 0 ? -1 : content.indexOf("```", lineEnd + 1);
      if (closing < 0) {
        visible += content.slice(opening);
        break;
      }
      visible += content.slice(opening, closing + 3);
      cursor = closing + 3;
      continue;
    }
    const closing = lineEnd < 0 ? -1 : content.indexOf("```", lineEnd + 1);
    if (closing < 0) return streaming ? visible.replace(/(^|[^`])`{1,2}$/, "$1") : visible;
    cursor = closing + 3;
  }
  return streaming ? visible.replace(/(^|[^`])`{1,2}$/, "$1") : visible;
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
    // C7 security fix: escaping (including quotes) and link building moved into a pure module so the
    // gate can execute the invariant. Quotes are escaped before any markup is inserted, and the href is
    // escaped again — previously a `"` inside the URL could close the href attribute and install an
    // event handler (`[x](https://a.com/"onmouseover="location=name)`).
    let s = escapeInlineText(str);
    // Bold: **text** or __text__
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    // Italic: *text* (when not bold) or _text_
    s = s.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, "$1<em>$2</em>$3");
    // Code inline: `code`
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Links: [label](url) — the URL is validated and re-escaped by cardLinkHtml.
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g,
      (_match: string, label: string, url: string) => cardLinkHtml(label, url)
    );
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

/**
 * Sanitizes HTML before it is written with `innerHTML` or rendered with `dangerouslySetInnerHTML`.
 *
 * The card body is a `contentEditable` node, so its `innerHTML` is not necessarily the markup this component
 * produced: a paste can put arbitrary markup there, and mirroring that raw markup into another node with
 * `innerHTML` would install it as live DOM (the fullscreen copy writes whatever the inline copy holds). The
 * output of `markdownToCardHtml` is already escaped, so this is defence in depth for the edited path: only the
 * card vocabulary survives, anything else is unwrapped (script/style/iframe/object/embed are dropped with their
 * content), and a link keeps `href` only when it is http(s) or root-relative.
 *
 * This reuses the sanitizer pattern already in the repo (`EmailInboxPage`'s `sanitizeEmailHtml`: allowlist tags,
 * http(s)-only hrefs, `rel="noopener noreferrer"`) rather than adding a sanitizer dependency.
 */
const CARD_ALLOWED_TAGS = new Set([
  "A", "P", "BR", "HR", "STRONG", "EM", "B", "I", "U", "S", "CODE", "PRE", "BLOCKQUOTE",
  "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "SPAN", "DIV", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD",
]);
const CARD_DROPPED_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "FORM", "LINK", "META", "BASE"]);
const CARD_ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  A: new Set(["href", "class", "rel", "target", "title"]),
};

export function sanitizeCardHtml(html: string): string {
  if (!html) return "";
  // Outside a browser (static/server render) there is no parser and no contentEditable, so fall back to text:
  // showing escaped markup is worse-looking but can never become live DOM.
  if (typeof DOMParser === "undefined") {
    return html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const visit = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      const tag = child.tagName.toUpperCase();
      if (CARD_DROPPED_TAGS.has(tag)) {
        child.remove();
        continue;
      }
      if (!CARD_ALLOWED_TAGS.has(tag)) {
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      const allowed = CARD_ALLOWED_ATTRIBUTES[tag] ?? new Set<string>();
      for (const attribute of Array.from(child.attributes)) {
        if (!allowed.has(attribute.name.toLowerCase())) child.removeAttribute(attribute.name);
      }
      if (tag === "A") {
        const href = child.getAttribute("href") ?? "";
        if (!(/^https?:\/\//i.test(href) || href.startsWith("/"))) child.removeAttribute("href");
        child.setAttribute("rel", "noopener noreferrer");
      }
      visit(child);
    }
  };
  visit(parsed.body);
  return parsed.body.innerHTML;
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
      const html = sanitizeCardHtml(markdownToCardHtml(initialContent));
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
    // Read through the sanitizer: this node is contentEditable, so its innerHTML may hold pasted markup, and
    // the very next lines copy it into the other card (the fullscreen mirror).
    const html = sanitizeCardHtml(e.currentTarget.innerHTML);
    if (bodyRef.current && e.currentTarget !== bodyRef.current) {
      bodyRef.current.innerHTML = html;
    }
    if (modalBodyRef.current && e.currentTarget !== modalBodyRef.current) {
      modalBodyRef.current.innerHTML = html;
    }
  };

  const handleCardLinkClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a.chat-card-link");
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    const href = anchor.getAttribute("href");
    if (!href) return;
    if (href.startsWith("/")) window.location.assign(href);
    else window.open(href, "_blank", "noopener,noreferrer");
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
            modalBodyRef.current.innerHTML = sanitizeCardHtml(bodyRef.current.innerHTML);
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
          onClick={handleCardLinkClick}
          dangerouslySetInnerHTML={{ __html: sanitizeCardHtml(initialHtml) }}
        />
      </div>

      {isFullscreen && createPortal(
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
              onClick={handleCardLinkClick}
              dangerouslySetInnerHTML={{ __html: sanitizeCardHtml(bodyRef.current ? bodyRef.current.innerHTML : initialHtml) }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export function ChatMessageContent({ content }: { content: string }) {
  // A confirmation card inside a reply speaks the reply's language: the agent answers in the language the person writes in.
  // The interface language as the app stores it; read directly, since this component also renders without a provider.
  let interfaceLanguage = "en";
  try { interfaceLanguage = localStorage.getItem("npati_language") || "en"; } catch { /* storage unavailable */ }
  const replyLanguage = messageLanguage(content.replace(/\[\[npati-approval:[^\]]*\]\]/g, ""), interfaceLanguage);
  const safeContent = stripInternalChatActions(content)
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
    const approval = approvalLine.exec(line.trim());
    if (approval) {
      elements.push(<ChatApprovalCard key={`approval-${i}`} companyId={approval[1]!} runId={approval[2]!} approvalId={approval[3]!} toolName={approval[4]!} language={replyLanguage} />);
      i++;
      continue;
    }

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
      if (lang === "spreadsheet-edit" || lang === "table-edit" || lang === "excel-edit" || internalActionFences.includes(lang)) {
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
            <img src={src} alt={name} loading="lazy" decoding="async" onLoad={() => window.dispatchEvent(new CustomEvent("npati:chat-image-loaded"))} />
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
