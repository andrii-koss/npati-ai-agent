import type { FormEvent } from "react";
import type { EmailThread } from "../email-inbox-shared";
import { useTranslation } from "../i18n";

export interface ReplyComposerProps {
  activeThread: EmailThread;
  composerMode: "reply" | "reply_all" | "forward";
  onSetComposerMode: (mode: "reply" | "reply_all" | "forward") => void;
  forwardTo: string;
  onForwardToChange: (to: string) => void;
  replyText: string;
  onReplyTextChange: (text: string) => void;
  onReplyFocus: () => void;
  replyFiles: File[];
  onSetReplyFiles: React.Dispatch<React.SetStateAction<File[]>>;
  sending: boolean;
  onSendReply: (e: FormEvent) => void;
  onShowNotice: (msg: string) => void;
}

export function ReplyComposer({
  activeThread,
  composerMode,
  onSetComposerMode,
  forwardTo,
  onForwardToChange,
  replyText,
  onReplyTextChange,
  onReplyFocus,
  replyFiles,
  onSetReplyFiles,
  sending,
  onSendReply,
  onShowNotice,
}: ReplyComposerProps) {
  const { t } = useTranslation();

  return (
    <form onSubmit={onSendReply} className="email-inbox-composer">
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        {(["reply", "reply_all", "forward"] as const).map((modeOption) => (
          <button
            key={modeOption}
            type="button"
            className={`email-composer-mode-btn ${composerMode === modeOption ? "active" : ""}`}
            onClick={() => onSetComposerMode(modeOption)}
          >
            {modeOption === "reply"
              ? t("emailInbox.composer.reply")
              : modeOption === "reply_all"
              ? t("emailInbox.composer.replyAll")
              : t("emailInbox.composer.forward")}
          </button>
        ))}
      </div>
      {composerMode === "forward" && (
        <input
          type="text"
          placeholder={t("emailInbox.composer.forwardPlaceholder")}
          value={forwardTo}
          onChange={(e) => onForwardToChange(e.target.value)}
          style={{ width: "100%", marginBottom: 6, border: "1px solid #cbd5e1", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}
        />
      )}
      <textarea
        placeholder={t("emailInbox.composer.replyPlaceholder").replace("{name}", activeThread.customerName || activeThread.customerEmail)}
        value={replyText}
        onFocus={onReplyFocus}
        onChange={(e) => onReplyTextChange(e.target.value)}
        style={{ minHeight: "65px", maxHeight: "150px", resize: "vertical" }}
      />
      {replyFiles.length > 0 && (
        <div className="email-attached-files-list">
          {replyFiles.map((file, idx) => (
            <div key={`${file.name}-${idx}-${file.size}`} className="email-attached-file-chip">
              <span className="attachment-chip-icon">{file.type.startsWith("image/") ? "🖼️" : "📎"}</span>
              <span className="attachment-chip-name" title={file.name}>{file.name}</span>
              <span className="attachment-chip-size">({(file.size / 1024).toFixed(0)} KB)</span>
              <button
                type="button"
                className="attachment-chip-remove"
                title={t("emailInbox.composer.removeFileTitle")}
                aria-label={t("emailInbox.composer.removeFileAria").replace("{filename}", file.name)}
                onClick={() => {
                  onSetReplyFiles((prev) => prev.filter((_, i) => i !== idx));
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="email-composer-footer-row" style={{ marginTop: 4 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#475569", cursor: "pointer", margin: 0 }}>
          <span style={{ fontWeight: 600 }}>{t("emailInbox.composer.attachFiles")}</span>
          <input
            type="file"
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              if (files.some((file) => file.size > 10 * 1024 * 1024)) {
                onShowNotice(t("emailInbox.notices.fileTooLarge"));
                event.target.value = "";
                return;
              }
              const combined = [...replyFiles, ...files];
              if (combined.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) {
                onShowNotice(t("emailInbox.notices.totalTooLarge"));
                event.target.value = "";
                return;
              }
              onSetReplyFiles(combined);
              event.target.value = "";
            }}
          />
          {replyFiles.length > 0 && (
            <span>{replyFiles.length} {t("emailInbox.composer.attachedCount")}</span>
          )}
        </label>
        <button
          type="submit"
          className="button-primary automations-action-primary email-composer-send-btn"
          disabled={sending || !replyText.trim()}
          style={{ fontSize: 13, padding: "7px 20px", fontWeight: 700, marginLeft: "auto" }}
        >
          {sending ? t("emailInbox.composer.sending") : t("emailInbox.composer.sendReply")}
        </button>
      </div>
    </form>
  );
}
