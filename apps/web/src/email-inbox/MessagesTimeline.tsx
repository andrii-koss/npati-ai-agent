import type { RefObject } from "react";
import type { EmailAttachmentView, EmailMessage } from "../email-inbox-shared";
import { EmailImageAttachment, sanitizeEmailHtml } from "../email-inbox-shared";
import { useTranslation } from "../i18n";

export interface MessagesTimelineProps {
  historyMessages: EmailMessage[];
  messageScrollRef: RefObject<HTMLDivElement | null>;
  language: string;
  onOpenInspectedLink: (url: string, fromAddress: string) => void;
  onOpenAttachment: (att: EmailAttachmentView) => void;
  onPreviewImage: (source: string, filename: string) => void;
}

export function MessagesTimeline({
  historyMessages,
  messageScrollRef,
  language,
  onOpenInspectedLink,
  onOpenAttachment,
  onPreviewImage,
}: MessagesTimelineProps) {
  const { t } = useTranslation();

  return (
    <div className="email-inbox-messages-scroll" ref={messageScrollRef}>
      {historyMessages.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📬</div>
          <strong style={{ display: "block", marginBottom: 4, color: "#1e293b" }}>
            {t("emailInbox.messagesTimeline.noMessagesTitle")}
          </strong>
          <small style={{ color: "#475569" }}>
            {t("emailInbox.messagesTimeline.noMessagesDesc")}
          </small>
        </div>
      ) : (
        historyMessages.map((m) => {
          const isInbound = m.direction === "inbound";
          return (
            <div
              key={m.id}
              className={`email-inbox-message-bubble ${isInbound ? "inbound" : m.isAiGenerated ? "ai-generated" : "outbound"}`}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(0,0,0,0.06)", paddingBottom: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>
                  {isInbound ? m.fromName || m.fromAddress : m.isAiGenerated ? t("emailInbox.messagesTimeline.aiAssistant") : t("emailInbox.messagesTimeline.supportAgent")}
                </div>
                <small style={{ fontSize: 11, color: "#475569" }}>
                  {new Date(m.createdAt).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })}
                </small>
              </div>

              {m.bodyHtml ? (
                <div
                  className="email-sanitized-html"
                  style={{ fontSize: 13.5, color: "#1e293b", lineHeight: 1.55 }}
                  onClick={(event) => {
                    const anchor = (event.target as Element).closest("a[data-email-url]") as HTMLAnchorElement | null;
                    if (!anchor) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const url = anchor.dataset.emailUrl;
                    if (url) void onOpenInspectedLink(url, m.fromAddress);
                  }}
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(m.bodyHtml) }}
                />
              ) : (
                <div style={{ fontSize: 13.5, color: "#1e293b", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                  {m.bodyText.split(/(https?:\/\/[^\s<>"')]+)/gi).map((part, index) =>
                    /^https?:\/\//i.test(part) ? (
                      <button
                        key={`${m.id}-link-${index}`}
                        type="button"
                        onClick={() => void onOpenInspectedLink(part, m.fromAddress)}
                        style={{ border: 0, padding: 0, background: "none", color: "#2563eb", textDecoration: "underline", cursor: "pointer", font: "inherit" }}
                      >
                        {part}
                      </button>
                    ) : part
                  )}
                </div>
              )}

              {m.attachments && m.attachments.length > 0 && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                  {m.attachments.map((att, i) => /^image\//i.test(att.contentType) ? (
                    <EmailImageAttachment
                      key={`${m.id}-image-${i}`}
                      attachment={att}
                      onPreview={onPreviewImage}
                      onFallbackOpen={() => void onOpenAttachment(att)}
                    />
                  ) : (
                    <button
                      key={`${m.id}-file-${i}`}
                      type="button"
                      className="automation-cron-pill"
                      style={{ fontSize: 11, cursor: "pointer" }}
                      onClick={() => onOpenAttachment(att)}
                    >
                      📎 {att.filename} ({Math.round(att.sizeBytes / 1024)} KB)
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
