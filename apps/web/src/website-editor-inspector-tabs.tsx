import React from "react";
import { type WebsiteDocument, type WebsitePage } from "@npati/shared";
import { IconFile, IconGrip, IconSparkles } from "./website-editor-icons";
import { type ActiveDrawer } from "./website-editor-support";

export function WebsiteEditorInspectorDesignTab({
  doc,
  pushDocumentChange,
}: {
  doc: WebsiteDocument;
  pushDocumentChange: (doc: WebsiteDocument) => void;
}) {
  return (
    <div className="npati-builder-inspector-content">
      <span className="npati-builder-sections-title">Global Website Styles</span>

      <div className="npati-builder-color-row">
        <span className="npati-builder-color-label">Primary Brand Color</span>
        <div className="npati-builder-color-picker-wrap">
          <input
            type="color"
            className="npati-builder-color-swatch"
            value={doc.theme.primaryColor || "#e11d2e"}
            onChange={(e) => {
              pushDocumentChange({
                ...doc,
                theme: { ...doc.theme, primaryColor: e.target.value },
                updatedAt: new Date().toISOString(),
              });
            }}
          />
          <input
            type="text"
            className="npati-builder-color-code-input"
            value={doc.theme.primaryColor || "#E11D2E"}
            onChange={(e) => {
              pushDocumentChange({
                ...doc,
                theme: { ...doc.theme, primaryColor: e.target.value },
                updatedAt: new Date().toISOString(),
              });
            }}
          />
        </div>
      </div>

      <div className="npati-builder-color-row">
        <span className="npati-builder-color-label">Background Color</span>
        <div className="npati-builder-color-picker-wrap">
          <input
            type="color"
            className="npati-builder-color-swatch"
            value={doc.theme.backgroundColor || "#ffffff"}
            onChange={(e) => {
              pushDocumentChange({
                ...doc,
                theme: { ...doc.theme, backgroundColor: e.target.value },
                updatedAt: new Date().toISOString(),
              });
            }}
          />
          <input
            type="text"
            className="npati-builder-color-code-input"
            value={doc.theme.backgroundColor || "#FFFFFF"}
            onChange={(e) => {
              pushDocumentChange({
                ...doc,
                theme: { ...doc.theme, backgroundColor: e.target.value },
                updatedAt: new Date().toISOString(),
              });
            }}
          />
        </div>
      </div>

      <div className="npati-builder-color-row">
        <span className="npati-builder-color-label">Accent / Text Color</span>
        <div className="npati-builder-color-picker-wrap">
          <input
            type="color"
            className="npati-builder-color-swatch"
            value={doc.theme.textColor || "#0f172a"}
            onChange={(e) => {
              pushDocumentChange({
                ...doc,
                theme: { ...doc.theme, textColor: e.target.value },
                updatedAt: new Date().toISOString(),
              });
            }}
          />
          <input
            type="text"
            className="npati-builder-color-code-input"
            value={doc.theme.textColor || "#0F172A"}
            onChange={(e) => {
              pushDocumentChange({
                ...doc,
                theme: { ...doc.theme, textColor: e.target.value },
                updatedAt: new Date().toISOString(),
              });
            }}
          />
        </div>
      </div>

      <div style={{ marginTop: "16px" }}>
        <span className="npati-builder-group-title">Typography</span>
        <div className="npati-builder-form-group" style={{ marginBottom: "12px" }}>
          <label className="npati-builder-form-label">Font Family</label>
          <select
            className="npati-builder-select"
            value={doc?.theme?.fontFamily || "inter"}
            onChange={(e) => {
              pushDocumentChange({
                ...doc,
                theme: { ...doc.theme, fontFamily: e.target.value as any },
              });
            }}
          >
            <option value="inter">Inter (Clean Modern)</option>
            <option value="roboto">Roboto (Geometric)</option>
            <option value="playfair">Playfair Display (Serif)</option>
            <option value="geist">Geist (Minimalist)</option>
            <option value="system">System Default</option>
          </select>
        </div>
      </div>

      <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "14px" }}>
        <span className="npati-builder-group-title">Borders & Corners</span>
        <div className="npati-builder-form-group">
          <label className="npati-builder-form-label">Corner Radius</label>
          <select
            className="npati-builder-select"
            defaultValue="md"
            onChange={(e) => {
              pushDocumentChange({
                ...doc,
                theme: { ...doc.theme, borderRadius: e.target.value as any },
              });
            }}
          >
            <option value="none">Sharp (0px)</option>
            <option value="sm">Small (6px)</option>
            <option value="md">Rounded (12px)</option>
            <option value="lg">Soft Pill (20px)</option>
          </select>
        </div>
      </div>
    </div>
  );
}

export function WebsiteEditorInspectorAdvancedTab({
  activePage,
  doc,
  pushDocumentChange,
  setActiveDrawer,
}: {
  activePage: WebsitePage | null | undefined;
  doc: WebsiteDocument | null;
  pushDocumentChange: (doc: WebsiteDocument) => void;
  setActiveDrawer: (d: ActiveDrawer) => void;
}) {
  return (
    <div className="npati-builder-inspector-content">
      <span className="npati-builder-sections-title">SEO & Metadata</span>

      {activePage && doc && (
        <>
          <div className="npati-builder-form-group">
            <label className="npati-builder-form-label">Page Slug (URL)</label>
            <input
              type="text"
              className="npati-builder-input"
              value={activePage.slug}
              onChange={(e) => {
                const updatedPages = doc.pages.map((p) =>
                  p.id === activePage.id ? { ...p, slug: e.target.value } : p
                );
                pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
              }}
            />
          </div>

          <div className="npati-builder-form-group">
            <label className="npati-builder-form-label">Page Meta Title</label>
            <input
              type="text"
              className="npati-builder-input"
              value={activePage.seo?.title || ""}
              onChange={(e) => {
                const updatedPages = doc.pages.map((p) =>
                  p.id === activePage.id ? { ...p, seo: { ...(p.seo || {}), title: e.target.value } } : p
                );
                pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
              }}
            />
          </div>

          <div className="npati-builder-form-group">
            <label className="npati-builder-form-label">Meta Description</label>
            <textarea
              rows={3}
              className="npati-builder-textarea"
              value={activePage.seo?.description || ""}
              onChange={(e) => {
                const updatedPages = doc.pages.map((p) =>
                  p.id === activePage.id ? { ...p, seo: { ...(p.seo || {}), description: e.target.value } } : p
                );
                pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
              }}
            />
          </div>
        </>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" }}>
        <button
          type="button"
          className="button-secondary"
          onClick={() => setActiveDrawer("files")}
          style={{ textAlign: "left", display: "flex", alignItems: "center", gap: "8px" }}
        >
          <IconFile />
          <span>Inspect Code & Files</span>
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={() => setActiveDrawer("history")}
          style={{ textAlign: "left", display: "flex", alignItems: "center", gap: "8px" }}
        >
          <IconGrip />
          <span>View Checkpoints</span>
        </button>
        <button
          type="button"
          className="button-primary"
          onClick={() => setActiveDrawer("ai")}
          style={{ textAlign: "left", display: "flex", alignItems: "center", gap: "8px" }}
        >
          <IconSparkles />
          <span>Ask AI Assistant</span>
        </button>
      </div>
    </div>
  );
}
