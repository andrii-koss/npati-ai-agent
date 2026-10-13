import React from "react";
import { ChatMessageContent } from "./ChatMessageContent";
import type { ContentItem } from "./content-page-types";

export interface DocumentMetrics {
  words: number;
  characters: number;
  readingTimeMinutes: number;
}

export interface ContentPageViewerProps {
  selectedItem: ContentItem | null;
  isExpanded: boolean;
  setIsExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  isEditing: boolean;
  setIsEditing: (editing: boolean) => void;
  editTitle: string;
  setEditTitle: (val: string) => void;
  editType: ContentItem["type"];
  setEditType: (val: ContentItem["type"]) => void;
  editContent: string;
  setEditContent: (val: string) => void;
  viewMode: "preview" | "raw";
  setViewMode: (mode: "preview" | "raw") => void;
  copied: boolean;
  copyDocument: () => void;
  downloadDocument: () => void;
  handleDeleteItem: (id?: string) => void;
  handleSaveEdit: () => void;
  getBadgeLabel: (type: ContentItem["type"]) => string;
  documentMetrics: DocumentMetrics | null;
  language: string;
  t: (key: string, options?: Record<string, string | number>) => string;
}

export function ContentPageViewer({
  selectedItem,
  isExpanded,
  setIsExpanded,
  isEditing,
  setIsEditing,
  editTitle,
  setEditTitle,
  editType,
  setEditType,
  editContent,
  setEditContent,
  viewMode,
  setViewMode,
  copied,
  copyDocument,
  downloadDocument,
  handleDeleteItem,
  handleSaveEdit,
  getBadgeLabel,
  documentMetrics,
  language,
  t,
}: ContentPageViewerProps) {
  return (
    <section className="content-main-viewer" aria-label="Document reader">
      {selectedItem ? (
        <div className={`content-viewer-card ${isExpanded ? "expanded" : ""}`}>
          {/* Document Reader Header */}
          <header className="document-reader-header">
            {/* Top Row: Category Badge on left, Expand/Collapse toggle in top-right corner */}
            <div className="document-header-top-row">
              <span className={`content-badge badge-${isEditing ? editType : selectedItem.type}`}>
                {getBadgeLabel(isEditing ? editType : selectedItem.type)}
              </span>
              {!isEditing && (
                <button
                  type="button"
                  className={`content-action-btn expand-btn ${isExpanded ? "expanded" : ""}`}
                  onClick={() => setIsExpanded((prev) => !prev)}
                  title={isExpanded ? t("contentPage.viewer.collapseTitle") : t("contentPage.viewer.expandTitle")}
                >
                  {isExpanded ? (
                    <>
                      <span aria-hidden="true">⤡</span> {t("contentPage.viewer.collapse")}
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true">⤢</span> {t("contentPage.viewer.expand")}
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Main Row: Document Title and Actions toolbar */}
            <div className="document-header-main-row">
              <h2>{isEditing ? t("contentPage.viewer.editDocument") : selectedItem.title}</h2>

              {/* Actions toolbar */}
              <div className="document-header-actions">
                {!isEditing ? (
                  <>
                    <div className="document-view-toggle">
                      <button
                        type="button"
                        className={`view-toggle-btn ${viewMode === "preview" ? "active" : ""}`}
                        onClick={() => setViewMode("preview")}
                        title={t("contentPage.viewer.views.previewTitle")}
                      >
                        {t("contentPage.viewer.views.preview")}
                      </button>
                      <button
                        type="button"
                        className={`view-toggle-btn ${viewMode === "raw" ? "active" : ""}`}
                        onClick={() => setViewMode("raw")}
                        title={t("contentPage.viewer.views.rawTitle")}
                      >
                        {t("contentPage.viewer.views.raw")}
                      </button>
                    </div>

                    <button
                      type="button"
                      className="content-action-btn edit-btn"
                      onClick={() => setIsEditing(true)}
                      title={t("contentPage.viewer.actions.editTitle")}
                    >
                      {t("contentPage.viewer.actions.edit")}
                    </button>

                    <button
                      type="button"
                      className="content-action-btn delete-btn"
                      onClick={() => handleDeleteItem()}
                      title={t("contentPage.viewer.actions.deleteTitle")}
                    >
                      {t("contentPage.viewer.actions.delete")}
                    </button>

                    <button
                      type="button"
                      className={`content-action-btn copy-btn ${copied ? "copied" : ""}`}
                      onClick={copyDocument}
                      title={t("contentPage.viewer.actions.copyTitle")}
                    >
                      {copied ? t("contentPage.viewer.actions.copied") : t("contentPage.viewer.actions.copy")}
                    </button>

                    <button
                      type="button"
                      className="content-action-btn download-btn"
                      onClick={downloadDocument}
                      title={t("contentPage.viewer.actions.downloadTitle")}
                    >
                      {t("contentPage.viewer.actions.download")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="button-primary automations-action-primary content-save-btn"
                      onClick={handleSaveEdit}
                      title={t("contentPage.viewer.actions.saveChangesTitle")}
                    >
                      {t("contentPage.viewer.actions.saveChanges")}
                    </button>
                    <button
                      type="button"
                      className="button-secondary content-cancel-btn"
                      onClick={() => {
                        if (selectedItem) {
                          setEditTitle(selectedItem.title);
                          setEditType(selectedItem.type);
                          setEditContent(selectedItem.content);
                        }
                        setIsEditing(false);
                      }}
                      title={t("contentPage.viewer.actions.cancelTitle")}
                    >
                      {t("contentPage.viewer.actions.cancel")}
                    </button>
                  </>
                )}
              </div>
            </div>
          </header>

          {/* Document Reading Metrics Ribbon */}
          {documentMetrics && (
            <div className="document-metrics-ribbon">
              <div className="metric-chip">
                <strong>{documentMetrics.words.toLocaleString()}</strong>
                <span>{t("contentPage.viewer.metrics.words")}</span>
              </div>
              <div className="metric-chip">
                <strong>{documentMetrics.characters.toLocaleString()}</strong>
                <span>{t("contentPage.viewer.metrics.characters")}</span>
              </div>
              <div className="metric-chip">
                <strong>~{documentMetrics.readingTimeMinutes} min</strong>
                <span>{t("contentPage.viewer.metrics.readTime")}</span>
              </div>
              <div className="metric-chip">
                <strong>{new Date(selectedItem.createdAt).toLocaleDateString(language, { month: "short", day: "numeric", year: "numeric" })}</strong>
                <span>{t("contentPage.viewer.metrics.generatedDate")}</span>
              </div>
            </div>
          )}

          {/* Document Content View / Editor */}
          <div className={`document-content-area ${isExpanded ? "expanded" : ""}`}>
            {isEditing ? (
              <div className="document-edit-form">
                <div className="document-edit-meta-row">
                  <div className="document-edit-field flex-1">
                    <label htmlFor="content-edit-title">{t("contentPage.viewer.editor.titleLabel")}</label>
                    <input
                      id="content-edit-title"
                      type="text"
                      className="document-edit-input"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      placeholder={t("contentPage.viewer.editor.titlePlaceholder")}
                    />
                  </div>
                  <div className="document-edit-field">
                    <label htmlFor="content-edit-type">{t("contentPage.viewer.editor.typeLabel")}</label>
                    <select
                      id="content-edit-type"
                      className="document-edit-select"
                      value={editType}
                      onChange={(e) => setEditType(e.target.value as ContentItem["type"])}
                    >
                      <option value="article">{t("contentPage.types.article")}</option>
                      <option value="seo_structure">{t("contentPage.types.seoBlueprint")}</option>
                      <option value="social_post">{t("contentPage.types.socialMedia")}</option>
                      <option value="brief">{t("contentPage.types.briefPlan")}</option>
                    </select>
                  </div>
                </div>

                <div className="document-edit-field full-height">
                  <div className="document-edit-label-row">
                    <label htmlFor="content-edit-body">{t("contentPage.viewer.editor.bodyLabel")}</label>
                    <span className="document-edit-hint">{t("contentPage.viewer.editor.saveHint")}</span>
                  </div>
                  <textarea
                    id="content-edit-body"
                    className="document-edit-textarea"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                        e.preventDefault();
                        handleSaveEdit();
                      }
                    }}
                    rows={14}
                    placeholder={t("contentPage.viewer.editor.bodyPlaceholder")}
                  />
                </div>
              </div>
            ) : viewMode === "preview" ? (
              <div className="document-preview-body">
                <ChatMessageContent content={selectedItem.content} />
              </div>
            ) : (
              <div className="document-raw-body">
                <pre><code>{selectedItem.content}</code></pre>
              </div>
            )}

            {!isEditing && !isExpanded && (
              <div className="document-expand-overlay">
                <button
                  type="button"
                  className="document-expand-banner-btn"
                  onClick={() => setIsExpanded(true)}
                  title={t("contentPage.viewer.expandTitle")}
                >
                  <span className="expand-icon" aria-hidden="true">⤢</span>
                  <span>{t("contentPage.viewer.overlay.expand")}</span>
                </button>
              </div>
            )}

            {!isEditing && isExpanded && (
              <div className="document-collapse-footer">
                <button
                  type="button"
                  className="document-collapse-banner-btn"
                  onClick={() => {
                    setIsExpanded(false);
                    window.scrollTo({ top: 180, behavior: "smooth" });
                  }}
                  title={t("contentPage.viewer.collapseTitle")}
                >
                  <span className="collapse-icon" aria-hidden="true">⤡</span>
                  <span>{t("contentPage.viewer.overlay.collapse")}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="content-viewer-card empty-selection">
          <p>{t("contentPage.empty.selectDoc")}</p>
        </div>
      )}
    </section>
  );
}
