import React from "react";
import { IconClose, PAGE_ICON_OPTIONS, RenderPageIcon } from "./website-editor-icons";

export interface PageModalState {
  isOpen: boolean;
  mode: "add" | "edit";
  pageId?: string;
  title: string;
  slug: string;
  icon: string;
}

export interface WebsiteEditorPageModalProps {
  pageModal: PageModalState;
  setPageModal: React.Dispatch<React.SetStateAction<PageModalState>>;
  iconSearch: string;
  setIconSearch: (s: string) => void;
  handleSavePageModal: () => void;
  language: string;
}

export function WebsiteEditorPageModal({
  pageModal,
  setPageModal,
  iconSearch,
  setIconSearch,
  handleSavePageModal,
  language,
}: WebsiteEditorPageModalProps) {
  if (!pageModal.isOpen) return null;

  const filteredIcons = PAGE_ICON_OPTIONS.filter(
    (ic) =>
      !iconSearch ||
      ic.label.toLowerCase().includes(iconSearch.toLowerCase()) ||
      ic.id.includes(iconSearch.toLowerCase())
  );

  return (
    <div className="npati-builder-modal-backdrop" onClick={() => setPageModal((p) => ({ ...p, isOpen: false }))}>
      <div className="npati-builder-modal" onClick={(e) => e.stopPropagation()}>
        <div className="npati-builder-modal-header">
          <span className="npati-builder-modal-title">
            {pageModal.mode === "add"
              ? language === "uk"
                ? "Додати нову сторінку"
                : "Add New Page"
              : language === "uk"
              ? "Налаштування сторінки"
              : "Page Settings"}
          </span>
          <button
            type="button"
            className="npati-builder-close-btn"
            onClick={() => setPageModal((p) => ({ ...p, isOpen: false }))}
            title={language === "uk" ? "Закрити" : "Close"}
          >
            <IconClose />
          </button>
        </div>
        <div className="npati-builder-modal-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div className="npati-builder-form-group" style={{ marginBottom: 0 }}>
              <label className="npati-builder-form-label">
                {language === "uk" ? "Назва сторінки" : "Page Title"}
              </label>
              <input
                type="text"
                className="npati-builder-input"
                placeholder="e.g. Services"
                value={pageModal.title}
                onChange={(e) => {
                  const title = e.target.value;
                  const autoSlug = "/" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                  setPageModal((p) => ({
                    ...p,
                    title,
                    slug: p.mode === "add" ? autoSlug : p.slug,
                  }));
                }}
                autoFocus
              />
            </div>

            <div className="npati-builder-form-group" style={{ marginBottom: 0 }}>
              <label className="npati-builder-form-label">
                {language === "uk" ? "URL адреса (Slug)" : "URL Slug"}
              </label>
              <input
                type="text"
                className="npati-builder-input"
                placeholder="/services"
                value={pageModal.slug}
                onChange={(e) => setPageModal((p) => ({ ...p, slug: e.target.value }))}
              />
            </div>
          </div>

          <div className="npati-builder-form-group">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
              <label className="npati-builder-form-label" style={{ marginBottom: 0 }}>
                {language === "uk" ? "Виберіть іконку" : "Select Icon"}
              </label>
              <span style={{ fontSize: "11.5px", color: "#64748b", fontWeight: 500 }}>
                {filteredIcons.length} {language === "uk" ? "доступно" : "available"}
              </span>
            </div>

            <input
              type="text"
              className="npati-builder-input"
              placeholder={
                language === "uk"
                  ? "Пошук іконки (Home, Services, Blog, FAQ...)"
                  : "Search icon (Home, Services, Blog, FAQ...)"
              }
              value={iconSearch}
              onChange={(e) => setIconSearch(e.target.value)}
              style={{ marginBottom: "6px", fontSize: "12px", padding: "7px 10px" }}
            />

            <div className="npati-builder-icon-grid">
              {filteredIcons.map((ic) => (
                <button
                  key={ic.id}
                  type="button"
                  className={`npati-builder-icon-option ${pageModal.icon === ic.id ? "active" : ""}`}
                  onClick={() => setPageModal((p) => ({ ...p, icon: ic.id }))}
                  title={ic.label}
                >
                  <RenderPageIcon icon={ic.id} size={15} />
                  <span>{ic.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="npati-builder-modal-footer">
          <button
            type="button"
            className="button-secondary"
            onClick={() => setPageModal((p) => ({ ...p, isOpen: false }))}
          >
            {language === "uk" ? "Скасувати" : "Cancel"}
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={!pageModal.title.trim()}
            onClick={handleSavePageModal}
          >
            {pageModal.mode === "add"
              ? language === "uk"
                ? "Створити сторінку"
                : "Create Page"
              : language === "uk"
              ? "Зберегти"
              : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
