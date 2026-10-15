import type { EmailAccount } from "../email-inbox-shared";
import { useTranslation } from "../i18n";

export interface ComposeModalProps {
  isOpen: boolean;
  onClose: () => void;
  sending: boolean;
  accounts: EmailAccount[];
  composeAccountId: string;
  onSetComposeAccountId: (id: string) => void;
  composeTo: string;
  onSetComposeTo: (to: string) => void;
  composeCc: string;
  onSetComposeCc: (cc: string) => void;
  composeBcc: string;
  onSetComposeBcc: (bcc: string) => void;
  composeSubject: string;
  onSetComposeSubject: (subject: string) => void;
  composeBody: string;
  onSetComposeBody: (body: string) => void;
  composeFiles: File[];
  onSetComposeFiles: React.Dispatch<React.SetStateAction<File[]>>;
  onSubmitCompose: (isDraft: boolean) => Promise<void>;
  onShowNotice: (msg: string) => void;
}

export function ComposeModal({
  isOpen,
  onClose,
  sending,
  accounts,
  composeAccountId,
  onSetComposeAccountId,
  composeTo,
  onSetComposeTo,
  composeCc,
  onSetComposeCc,
  composeBcc,
  onSetComposeBcc,
  composeSubject,
  onSetComposeSubject,
  composeBody,
  onSetComposeBody,
  composeFiles,
  onSetComposeFiles,
  onSubmitCompose,
  onShowNotice,
}: ComposeModalProps) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  const isSubmitDisabled =
    sending ||
    !composeAccountId ||
    !composeTo.trim() ||
    !composeSubject.trim() ||
    !composeBody.trim();

  return (
    <div className="company-drawer-backdrop" onMouseDown={() => !sending && onClose()}>
      <aside
        className="company-drawer automations-drawer"
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={t("emailInbox.composeModal.title")}
      >
        <header>
          <div>
            <span>{t("emailInbox.composeModal.kicker")}</span>
            <h2>{t("emailInbox.composeModal.title")}</h2>
          </div>
          <button
            type="button"
            className="company-drawer-close"
            aria-label={t("emailInbox.composeModal.closeAria")}
            onClick={onClose}
            disabled={sending}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <form onSubmit={(event) => { event.preventDefault(); void onSubmitCompose(false); }}>
          <section>
            <h3>{t("emailInbox.composeModal.senderRecipients")}</h3>
            <div className="company-form-grid">
              <label>
                <span>{t("emailInbox.composeModal.fromLabel")}</span>
                <select value={composeAccountId} onChange={(event) => onSetComposeAccountId(event.target.value)} required>
                  <option value="">{t("emailInbox.composeModal.selectAccountPlaceholder")}</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.displayName ? `${account.displayName} — ` : ""}{account.emailAddress}
                      {account.testMode
                        ? t("emailInbox.composeModal.testModeSuffix")
                        : account.status && account.status !== "connected"
                        ? ` (${account.status.replaceAll("_", " ")})`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("emailInbox.composeModal.toLabel")}</span>
                <input
                  type="text"
                  value={composeTo}
                  onChange={(event) => onSetComposeTo(event.target.value)}
                  placeholder={t("emailInbox.composeModal.toPlaceholder")}
                  required
                />
              </label>
            </div>
            <div className="company-form-grid">
              <label>
                <span>{t("emailInbox.composeModal.ccLabel")}</span>
                <input
                  type="text"
                  value={composeCc}
                  onChange={(event) => onSetComposeCc(event.target.value)}
                  placeholder={t("emailInbox.composeModal.optionalCommaSeparated")}
                />
              </label>
              <label>
                <span>{t("emailInbox.composeModal.bccLabel")}</span>
                <input
                  type="text"
                  value={composeBcc}
                  onChange={(event) => onSetComposeBcc(event.target.value)}
                  placeholder={t("emailInbox.composeModal.optionalCommaSeparated")}
                />
              </label>
            </div>
          </section>

          <section>
            <h3>{t("emailInbox.composeModal.messageHeading")}</h3>
            <label>
              <span>{t("emailInbox.composeModal.subjectLabel")}</span>
              <input
                value={composeSubject}
                onChange={(event) => onSetComposeSubject(event.target.value)}
                maxLength={998}
                required
              />
            </label>
            <label>
              <span>{t("emailInbox.composeModal.bodyLabel")}</span>
              <textarea
                value={composeBody}
                onChange={(event) => onSetComposeBody(event.target.value)}
                rows={12}
                placeholder={t("emailInbox.composeModal.bodyPlaceholder")}
                required
              />
            </label>
            <label>
              <span>{t("emailInbox.composeModal.attachmentsLabel")}</span>
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
                  const combined = [...composeFiles, ...files];
                  if (combined.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) {
                    onShowNotice(t("emailInbox.notices.totalTooLarge"));
                    event.target.value = "";
                    return;
                  }
                  onSetComposeFiles(combined);
                  event.target.value = "";
                }}
              />
            </label>
            {composeFiles.length > 0 && (
              <div className="email-attached-files-list">
                {composeFiles.map((file, idx) => (
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
                        onSetComposeFiles((prev) => prev.filter((_, i) => i !== idx));
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            {accounts.find((account) => account.id === composeAccountId)?.testMode && (
              <div className="workspace-notice">{t("emailInbox.composeModal.testModeNotice")}</div>
            )}
          </section>

          <footer style={{ justifyContent: "flex-end" }}>
            <button
              type="button"
              className="button-secondary"
              disabled={isSubmitDisabled}
              onClick={() => void onSubmitCompose(true)}
            >
              {t("emailInbox.composeModal.saveDraft")}
            </button>
            <button
              type="submit"
              className="button-primary"
              disabled={isSubmitDisabled}
            >
              {sending ? t("emailInbox.composeModal.sending") : t("emailInbox.composeModal.sendEmail")}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
