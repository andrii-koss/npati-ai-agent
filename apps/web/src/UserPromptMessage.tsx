import { useState } from "react";
import { ChatMessageContent } from "./ChatMessageContent";
import { useTranslation } from "./i18n";

const COMPACT_LENGTH = 500;
const PREVIEW_LENGTH = 280;

export function UserPromptMessage({ content, onEdit }: { content: string; onEdit: (content: string) => void }) {
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
      {compact && !expanded
        ? <p className="user-prompt-preview">{preview}{content.length > PREVIEW_LENGTH ? "…" : ""}</p>
        : <ChatMessageContent content={content} />}
      <div className="user-prompt-actions">
        {compact && <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          {t(expanded ? "chat.collapsePrompt" : "chat.showFullPrompt")}
        </button>}
        <button type="button" onClick={() => void copyPrompt()}>{t(copied ? "chat.copiedPrompt" : "chat.copyPrompt")}</button>
        <button type="button" onClick={() => onEdit(content)}>{t("chat.editPrompt")}</button>
      </div>
    </>
  );
}
