import { useTranslation } from "../i18n";

export interface ImagePreviewModalProps {
  imagePreview: { source: string; filename: string } | null;
  onClose: () => void;
}

export function ImagePreviewModal({ imagePreview, onClose }: ImagePreviewModalProps) {
  const { t } = useTranslation();

  if (!imagePreview) return null;

  return (
    <div
      className="email-image-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={imagePreview.filename}
      onClick={onClose}
    >
      <button
        type="button"
        className="email-image-preview-close"
        aria-label={t("emailInbox.notices.closeImagePreview")}
        onClick={onClose}
      >
        ×
      </button>
      <figure onClick={(event) => event.stopPropagation()}>
        <img src={imagePreview.source} alt={imagePreview.filename} />
        <figcaption>{imagePreview.filename}</figcaption>
      </figure>
    </div>
  );
}
