import { ReactNode, useState } from "react";
import { ChatMessageContent } from "./ChatMessageContent";
import { useTranslation } from "./i18n";

const COMPACT_LENGTH = 500;
const PREVIEW_LENGTH = 280;

export function UserPromptMessage({
  content,
  onEdit,
  children,
}: {
  content: string;
  onEdit?: (content: string) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const compact = content.length > COMPACT_LENGTH || content.split("\n").length > 8;
  const preview = content.slice(0, PREVIEW_LENGTH).trimEnd();

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = content;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copiedWithFallback = document.execCommand("copy");
      textarea.remove();
      if (copiedWithFallback) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }
    }
  }

  return (
    <>
      <div className="user-message-bubble">
        {children}
        {compact && !expanded ? (
          <p className="user-prompt-preview">
            {preview}{content.length > PREVIEW_LENGTH ? "…" : ""}
          </p>
        ) : (
          <ChatMessageContent content={content} />
        )}
        {compact && (
          <button
            type="button"
            className="user-prompt-expand-btn"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            {t(expanded ? "chat.collapsePrompt" : "chat.showFullPrompt")}
          </button>
        )}
      </div>
      <div className="assistant-message-toolbar user-message-toolbar" aria-label="Message actions">
        <button
          type="button"
          className={`assistant-toolbar-btn ${copied ? "copied" : ""}`}
          onClick={() => void copyPrompt()}
          title={t(copied ? "chat.copiedPrompt" : "chat.copyPrompt")}
          aria-label={t(copied ? "chat.copiedPrompt" : "chat.copyPrompt")}
        >
          {copied ? (
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        {onEdit && (
          <button
            type="button"
            className="assistant-toolbar-btn"
            onClick={() => onEdit(content)}
            title={t("chat.editPrompt")}
            aria-label={t("chat.editPrompt")}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
        )}
      </div>
    </>
  );
}
