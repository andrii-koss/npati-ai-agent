import type { EmailAuditEntry } from "../email-inbox-shared";
import { useTranslation } from "../i18n";

export interface ThreadHistorySectionProps {
  auditHistory: EmailAuditEntry[];
  historyOpen: boolean;
  onToggleHistoryOpen: () => void;
  historyHeight: number;
  onSetHistoryHeight: (height: number) => void;
  language: string;
}

export function ThreadHistorySection({
  auditHistory,
  historyOpen,
  onToggleHistoryOpen,
  historyHeight,
  onSetHistoryHeight,
  language,
}: ThreadHistorySectionProps) {
  const { t } = useTranslation();

  if (auditHistory.length === 0) return null;

  return (
    <div className="email-thread-history-section">
      <div
        className="email-history-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 14px",
          background: "#f8fafc",
          borderTop: "1px solid #e2e8f0",
          borderBottom: historyOpen ? "1px solid #e2e8f0" : "none",
          userSelect: "none",
        }}
      >
        <div
          onClick={onToggleHistoryOpen}
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flex: 1 }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>
            {t("emailInbox.auditHistory.heading")} ({auditHistory.length})
          </span>
          <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>
            {historyOpen ? t("emailInbox.auditHistory.hide") : t("emailInbox.auditHistory.show")}
          </span>
        </div>

        {historyOpen && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "#94a3b8" }}>{t("emailInbox.auditHistory.sizeLabel")}</span>
            <button
              type="button"
              className={`history-size-btn ${historyHeight === 90 ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onSetHistoryHeight(90);
              }}
              title={t("emailInbox.auditHistory.sizeCompact")}
            >
              S
            </button>
            <button
              type="button"
              className={`history-size-btn ${historyHeight === 160 ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onSetHistoryHeight(160);
              }}
              title={t("emailInbox.auditHistory.sizeMedium")}
            >
              M
            </button>
            <button
              type="button"
              className={`history-size-btn ${historyHeight === 260 ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onSetHistoryHeight(260);
              }}
              title={t("emailInbox.auditHistory.sizeLarge")}
            >
              L
            </button>
          </div>
        )}
      </div>

      {historyOpen && (
        <div
          className="email-history-scroll"
          style={{
            height: `${historyHeight}px`,
            minHeight: "70px",
            maxHeight: "360px",
            resize: "vertical",
            overflowY: "auto",
            padding: "8px 14px",
            background: "#ffffff",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {auditHistory.map((entry) => (
            <div key={entry.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11.5, color: "#475569" }}>
              <span>
                <strong>{entry.action.replace(/^email\./, "").replaceAll("_", " ")}</strong> · {entry.userId}
              </span>
              <time>{new Date(entry.createdAt).toLocaleString(language)}</time>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
