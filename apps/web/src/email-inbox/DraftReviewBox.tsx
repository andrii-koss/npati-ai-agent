import { useTranslation } from "../i18n";

export interface DraftReviewBoxProps {
  draftMessageId: string | null;
  draftExpanded: boolean;
  onToggleDraftExpanded: () => void;
  draftIsAiGenerated: boolean;
  aiConfidenceScore?: number | null;
  sending: boolean;
  onApproveDraft: () => void;
  draftEditing: boolean;
  onToggleDraftEditing: () => void;
  onDiscardDraft: () => void;
  draftText: string;
  onDraftTextChange: (text: string) => void;
}

export function DraftReviewBox({
  draftMessageId,
  draftExpanded,
  onToggleDraftExpanded,
  draftIsAiGenerated,
  aiConfidenceScore,
  sending,
  onApproveDraft,
  draftEditing,
  onToggleDraftEditing,
  onDiscardDraft,
  draftText,
  onDraftTextChange,
}: DraftReviewBoxProps) {
  const { t } = useTranslation();

  if (!draftMessageId) return null;

  return (
    <div className={`email-inbox-draft-box ${!draftExpanded ? "collapsed" : ""}`}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}
          onClick={onToggleDraftExpanded}
          title={draftExpanded ? t("emailInbox.draftReview.collapseDraft") : t("emailInbox.draftReview.expandDraft")}
        >
          <button
            type="button"
            className="email-draft-toggle-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggleDraftExpanded();
            }}
            aria-label={draftExpanded ? t("emailInbox.draftReview.collapseDraft") : t("emailInbox.draftReview.expandDraft")}
          >
            {draftExpanded ? "▲" : "▼"}
          </button>
          <span style={{ fontWeight: 700, fontSize: 13, color: "#92400e" }}>
            {draftIsAiGenerated ? t("emailInbox.draftReview.aiDraftHeading") : t("emailInbox.draftReview.savedDraftHeading")}
          </span>
          {draftIsAiGenerated && aiConfidenceScore != null && (
            <span style={{ fontSize: 10.5, fontWeight: 600, background: "#fde68a", color: "#78350f", padding: "1px 6px", borderRadius: 4 }}>
              {Math.round(aiConfidenceScore * 100)}% {t("emailInbox.draftReview.confidenceBadge")}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            className="button-primary automations-action-primary"
            style={{ fontSize: 11.5, padding: "4px 10px", lineHeight: 1.2 }}
            disabled={sending}
            onClick={onApproveDraft}
          >
            {sending ? t("emailInbox.draftReview.sending") : draftIsAiGenerated ? t("emailInbox.draftReview.sendAiDraft") : t("emailInbox.draftReview.sendDraft")}
          </button>
          <button
            type="button"
            className="button-secondary"
            style={{ fontSize: 11.5, padding: "4px 8px", lineHeight: 1.2 }}
            onClick={onToggleDraftEditing}
          >
            {draftEditing ? t("emailInbox.draftReview.done") : t("emailInbox.draftReview.edit")}
          </button>
          <button
            type="button"
            className="button-secondary"
            style={{ fontSize: 11.5, padding: "4px 8px", lineHeight: 1.2 }}
            onClick={onDiscardDraft}
          >
            {t("emailInbox.draftReview.discard")}
          </button>
        </div>
      </div>

      {draftExpanded && (
        draftEditing ? (
          <textarea
            rows={4}
            value={draftText}
            onChange={(e) => onDraftTextChange(e.target.value)}
            style={{ width: "100%", borderRadius: 6, border: "1px solid #cbd5e1", padding: 8, fontFamily: "inherit", fontSize: 13 }}
          />
        ) : (
          <div className="email-draft-text-scroll" style={{ fontSize: 13, color: "#451a03", whiteSpace: "pre-wrap", lineHeight: 1.5, maxHeight: "200px", overflowY: "auto" }}>
            {draftText}
          </div>
        )
      )}
    </div>
  );
}
