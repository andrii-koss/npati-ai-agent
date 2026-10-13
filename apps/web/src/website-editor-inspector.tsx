import React from "react";
import {
  COMPONENT_REGISTRY,
  type WebsiteDocument,
  type WebsitePage,
  type WebsiteBlock,
  type BlockStyles,
  type WebsiteTheme,
} from "@npati/shared";
import {
  IconSectionSymbol,
  IconMore,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconTrash,
  IconAlignLeft,
  IconAlignCenter,
  IconAlignRight,
  IconEdit,
  IconArrowUp,
  IconArrowDown,
  IconLink,
} from "./website-editor-icons";
import {
  type InspectorTab,
  type InspectorSubTab,
  type ActiveDrawer,
} from "./website-editor-support";
import { promptModal } from "./ConfirmDialog";
import {
  WebsiteEditorInspectorDesignTab,
  WebsiteEditorInspectorAdvancedTab,
} from "./website-editor-inspector-tabs";

export interface WebsiteEditorInspectorProps {
  inspectorTab: InspectorTab;
  setInspectorTab: (tab: InspectorTab) => void;
  selectedBlock: WebsiteBlock | null | undefined;
  inspectorSubTab: InspectorSubTab;
  setInspectorSubTab: (sub: InspectorSubTab) => void;
  inspectorBlockMenuOpen: boolean;
  setInspectorBlockMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleDuplicateBlock: (blockId: string) => void;
  handleMoveBlock: (blockId: string, direction: "up" | "down") => void;
  handleToggleHideBlock: (blockId: string) => void;
  handleDeleteBlock: (blockId: string) => void;
  handleUpdateBlockProp: (prop: string, val: any) => void;
  handleUpdateBlockStyle: (prop: keyof BlockStyles, val: any) => void;
  doc: WebsiteDocument | null;
  pushDocumentChange: (doc: WebsiteDocument) => void;
  activePage: WebsitePage | null | undefined;
  setActiveDrawer: (d: ActiveDrawer) => void;
  language: string;
}

export function WebsiteEditorInspector({
  inspectorTab,
  setInspectorTab,
  selectedBlock,
  inspectorSubTab,
  setInspectorSubTab,
  inspectorBlockMenuOpen,
  setInspectorBlockMenuOpen,
  handleDuplicateBlock,
  handleMoveBlock,
  handleToggleHideBlock,
  handleDeleteBlock,
  handleUpdateBlockProp,
  handleUpdateBlockStyle,
  doc,
  pushDocumentChange,
  activePage,
  setActiveDrawer,
  language,
}: WebsiteEditorInspectorProps) {
  return (
        <aside className="npati-builder-right-panel">
          {/* Top Segmented Tabs: Properties | Design | Advanced */}
          <div className="npati-builder-nav-tabs-wrapper">
            <div className="npati-builder-nav-tabs">
              <button
                type="button"
                className={`npati-builder-nav-tab ${inspectorTab === "properties" ? "active" : ""}`}
                onClick={() => setInspectorTab("properties")}
              >
                Properties
              </button>
              <button
                type="button"
                className={`npati-builder-nav-tab ${inspectorTab === "design" ? "active" : ""}`}
                onClick={() => setInspectorTab("design")}
              >
                Design
              </button>
              <button
                type="button"
                className={`npati-builder-nav-tab ${inspectorTab === "advanced" ? "active" : ""}`}
                onClick={() => setInspectorTab("advanced")}
              >
                Advanced
              </button>
            </div>
          </div>

          {/* TAB: PROPERTIES */}
          {inspectorTab === "properties" && selectedBlock && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
              {/* Active Section Card matching mockup */}
              <div className="npati-builder-inspector-section-card">
                <div className="npati-builder-inspector-block-title">
                  <div className="npati-builder-inspector-icon-box">
                    <IconSectionSymbol type={selectedBlock.type} />
                  </div>
                  <div>
                    <strong>{selectedBlock.name || selectedBlock.type}</strong>
                    <small>#{selectedBlock.type}</small>
                  </div>
                </div>

                <div style={{ position: "relative" }}>
                  <button
                    type="button"
                    className="npati-builder-more-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setInspectorBlockMenuOpen((prev) => !prev);
                    }}
                    title="Block Actions"
                  >
                    <IconMore />
                  </button>

                  {inspectorBlockMenuOpen && (
                    <div className="npati-builder-action-popover" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="npati-builder-popover-item"
                        onClick={async () => {
                          setInspectorBlockMenuOpen(false);
                          const newName = await promptModal({
                            message: language === "uk" ? "Введіть нову назву для секції:" : "Enter new name for section:",
                            defaultValue: selectedBlock.name || selectedBlock.type,
                          });
                          if (newName && newName.trim()) {
                            handleUpdateBlockProp("_sectionName", newName.trim());
                            if (activePage && doc) {
                              const updatedBlocks = activePage.blocks.map((blk) =>
                                blk.id === selectedBlock.id ? { ...blk, name: newName.trim() } : blk
                              );
                              const updatedPages = doc.pages.map((pg) =>
                                pg.id === activePage.id ? { ...pg, blocks: updatedBlocks } : pg
                              );
                              pushDocumentChange({ ...doc, pages: updatedPages });
                            }
                          }
                        }}
                      >
                        <IconEdit />
                        <span>{language === "uk" ? "Перейменувати" : "Rename"}</span>
                      </button>

                      <button
                        type="button"
                        className="npati-builder-popover-item"
                        onClick={() => {
                          setInspectorBlockMenuOpen(false);
                          handleMoveBlock(selectedBlock.id, "up");
                        }}
                        disabled={activePage?.blocks.findIndex((x) => x.id === selectedBlock.id) === 0}
                      >
                        <IconArrowUp />
                        <span>{language === "uk" ? "Підняти вгору" : "Move Up"}</span>
                      </button>

                      <button
                        type="button"
                        className="npati-builder-popover-item"
                        onClick={() => {
                          setInspectorBlockMenuOpen(false);
                          handleMoveBlock(selectedBlock.id, "down");
                        }}
                        disabled={
                          activePage?.blocks.findIndex((x) => x.id === selectedBlock.id) ===
                          (activePage?.blocks.length || 0) - 1
                        }
                      >
                        <IconArrowDown />
                        <span>{language === "uk" ? "Опустити вниз" : "Move Down"}</span>
                      </button>

                      <button
                        type="button"
                        className="npati-builder-popover-item"
                        onClick={() => {
                          setInspectorBlockMenuOpen(false);
                          handleDuplicateBlock(selectedBlock.id);
                        }}
                      >
                        <IconCopy />
                        <span>{language === "uk" ? "Скопіювати" : "Duplicate"}</span>
                      </button>

                      <button
                        type="button"
                        className="npati-builder-popover-item"
                        onClick={() => {
                          setInspectorBlockMenuOpen(false);
                          handleToggleHideBlock(selectedBlock.id);
                        }}
                      >
                        {selectedBlock.isHidden ? <IconEye /> : <IconEyeOff />}
                        <span>
                          {selectedBlock.isHidden
                            ? (language === "uk" ? "Показати" : "Show")
                            : (language === "uk" ? "Сховати" : "Hide")}
                        </span>
                      </button>

                      <button
                        type="button"
                        className="npati-builder-popover-item danger"
                        onClick={() => {
                          setInspectorBlockMenuOpen(false);
                          void handleDeleteBlock(selectedBlock.id);
                        }}
                      >
                        <IconTrash />
                        <span>{language === "uk" ? "Видалити" : "Delete"}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Pill Subtabs: Content vs Style */}
              <div className="npati-builder-subtab-segmented">
                <button
                  type="button"
                  className={`npati-builder-subtab-btn ${inspectorSubTab === "content" ? "active" : ""}`}
                  onClick={() => setInspectorSubTab("content")}
                >
                  Content
                </button>
                <button
                  type="button"
                  className={`npati-builder-subtab-btn ${inspectorSubTab === "style" ? "active" : ""}`}
                  onClick={() => setInspectorSubTab("style")}
                >
                  Style
                </button>
              </div>

              {/* Inspector Content */}
              <div className="npati-builder-inspector-content">
                {/* SUBTAB: CONTENT */}
                {inspectorSubTab === "content" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    {/* 1. Title */}
                    <div className="npati-builder-form-group">
                      <label className="npati-builder-form-label">Title</label>
                      <input
                        type="text"
                        className="npati-builder-input"
                        value={selectedBlock.props.title || selectedBlock.props.brandName || ""}
                        onChange={(e) => {
                          if (selectedBlock.type === "navbar") {
                            handleUpdateBlockProp("brandName", e.target.value);
                          } else {
                            handleUpdateBlockProp("title", e.target.value);
                          }
                        }}
                      />
                    </div>

                    {/* 2. Subtitle */}
                    {selectedBlock.type !== "navbar" && (
                      <div className="npati-builder-form-group">
                        <label className="npati-builder-form-label">Subtitle</label>
                        <textarea
                          rows={3}
                          className="npati-builder-textarea"
                          value={selectedBlock.props.subtitle || selectedBlock.props.description || ""}
                          onChange={(e) => handleUpdateBlockProp("subtitle", e.target.value)}
                        />
                      </div>
                    )}

                    {/* 3. Primary Button & Link (2-column layout matching photo) */}
                    <div className="npati-builder-btn-link-row">
                      <div className="npati-builder-form-group npati-builder-btn-col">
                        <label className="npati-builder-form-label">Primary Button</label>
                        <input
                          type="text"
                          className="npati-builder-input"
                          value={selectedBlock.props.primaryCtaText || selectedBlock.props.ctaText || "Get Started Free"}
                          onChange={(e) => {
                            if (selectedBlock.type === "navbar") {
                              handleUpdateBlockProp("ctaText", e.target.value);
                            } else {
                              handleUpdateBlockProp("primaryCtaText", e.target.value);
                            }
                          }}
                        />
                      </div>
                      <div className="npati-builder-form-group npati-builder-link-col">
                        <label className="npati-builder-form-label">Link</label>
                        <div className="npati-builder-link-input-wrap">
                          <input
                            type="text"
                            className="npati-builder-input"
                            value={selectedBlock.props.primaryCtaUrl || selectedBlock.props.ctaUrl || "#"}
                            onChange={(e) => {
                              if (selectedBlock.type === "navbar") {
                                handleUpdateBlockProp("ctaUrl", e.target.value);
                              } else {
                                handleUpdateBlockProp("primaryCtaUrl", e.target.value);
                              }
                            }}
                          />
                          <span className="link-icon">
                            <IconLink />
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* 4. Secondary Button & Link (2-column layout matching photo) */}
                    {selectedBlock.type === "hero" && (
                      <div className="npati-builder-btn-link-row">
                        <div className="npati-builder-form-group npati-builder-btn-col">
                          <label className="npati-builder-form-label">Secondary Button</label>
                          <input
                            type="text"
                            className="npati-builder-input"
                            value={selectedBlock.props.secondaryCtaText || "Watch Demo"}
                            onChange={(e) => handleUpdateBlockProp("secondaryCtaText", e.target.value)}
                          />
                        </div>
                        <div className="npati-builder-form-group npati-builder-link-col">
                          <label className="npati-builder-form-label">Link</label>
                          <div className="npati-builder-link-input-wrap">
                            <input
                              type="text"
                              className="npati-builder-input"
                              value={selectedBlock.props.secondaryCtaUrl || "#"}
                              onChange={(e) => handleUpdateBlockProp("secondaryCtaUrl", e.target.value)}
                            />
                            <span className="link-icon">
                              <IconLink />
                            </span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* 5. Layout Section matching photo */}
                    <div>
                      <span className="npati-builder-group-title">Layout</span>

                      {/* Alignment */}
                      <div className="npati-builder-form-group" style={{ marginBottom: "12px" }}>
                        <label className="npati-builder-form-label">Alignment</label>
                        <div className="npati-builder-align-group">
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "left" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "left")}
                            title="Align Left"
                          >
                            <IconAlignLeft />
                          </button>
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "center" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "center")}
                            title="Align Center"
                          >
                            <IconAlignCenter />
                          </button>
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "right" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "right")}
                            title="Align Right"
                          >
                            <IconAlignRight />
                          </button>
                        </div>
                      </div>

                      {/* Padding */}
                      <div className="npati-builder-form-group" style={{ marginBottom: "12px" }}>
                        <label className="npati-builder-form-label">Padding</label>
                        <select
                          className="npati-builder-select"
                          value={selectedBlock.styles?.paddingY || "large"}
                          onChange={(e) => handleUpdateBlockStyle("paddingY", e.target.value)}
                        >
                          <option value="none">None (0px)</option>
                          <option value="small">Small (20px)</option>
                          <option value="medium">Medium (40px)</option>
                          <option value="large">Large (64px)</option>
                          <option value="xlarge">X-Large (80px)</option>
                        </select>
                      </div>

                      {/* Max Width */}
                      <div className="npati-builder-form-group">
                        <label className="npati-builder-form-label">Max Width</label>
                        <select
                          className="npati-builder-select"
                          value={selectedBlock.styles?.maxWidth || "large"}
                          onChange={(e) => handleUpdateBlockStyle("maxWidth", e.target.value)}
                        >
                          <option value="large">1200px</option>
                          <option value="medium">960px</option>
                          <option value="small">640px</option>
                          <option value="full">100% Full Width</option>
                        </select>
                      </div>
                    </div>

                    {/* 6. Colors Section matching photo */}
                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "14px" }}>
                      <span className="npati-builder-group-title">Colors</span>

                      {/* Background Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Background</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.backgroundColor?.startsWith("#") ? selectedBlock.styles.backgroundColor : "#F8FAFF"}
                            onChange={(e) => handleUpdateBlockStyle("backgroundColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.backgroundColor || "#F8FAFF"}
                            onChange={(e) => handleUpdateBlockStyle("backgroundColor", e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Title Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Title</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.textColor?.startsWith("#") ? selectedBlock.styles.textColor : "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("textColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.textColor || "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("textColor", e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Subtitle Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Subtitle</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value="#64748B"
                            onChange={(e) => handleUpdateBlockStyle("accentColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value="#64748B"
                            readOnly
                          />
                        </div>
                      </div>

                      {/* Primary Button Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Primary Button</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value="#0F172A"
                            onChange={(e) => handleUpdateBlockStyle("borderColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value="#0F172A"
                            readOnly
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* SUBTAB: STYLE */}
                {inspectorSubTab === "style" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    {/* 1. Layout & Alignment */}
                    <div>
                      <span className="npati-builder-group-title">Layout & Spacing</span>

                      {/* Alignment */}
                      <div className="npati-builder-form-group" style={{ marginBottom: "12px" }}>
                        <label className="npati-builder-form-label">Alignment</label>
                        <div className="npati-builder-align-group">
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "left" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "left")}
                            title="Align Left"
                          >
                            <IconAlignLeft />
                          </button>
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "center" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "center")}
                            title="Align Center"
                          >
                            <IconAlignCenter />
                          </button>
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "right" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "right")}
                            title="Align Right"
                          >
                            <IconAlignRight />
                          </button>
                        </div>
                      </div>

                      {/* Vertical Spacing / Padding */}
                      <div className="npati-builder-form-group" style={{ marginBottom: "12px" }}>
                        <label className="npati-builder-form-label">Vertical Padding</label>
                        <select
                          className="npati-builder-select"
                          value={selectedBlock.styles?.paddingY || "large"}
                          onChange={(e) => handleUpdateBlockStyle("paddingY", e.target.value)}
                        >
                          <option value="none">None (0px)</option>
                          <option value="small">Small (24px)</option>
                          <option value="medium">Medium (48px)</option>
                          <option value="large">Large (72px)</option>
                          <option value="xlarge">Extra Large (96px)</option>
                        </select>
                      </div>

                      {/* Container Max Width */}
                      <div className="npati-builder-form-group">
                        <label className="npati-builder-form-label">Max Width</label>
                        <select
                          className="npati-builder-select"
                          value={selectedBlock.styles?.maxWidth || "large"}
                          onChange={(e) => handleUpdateBlockStyle("maxWidth", e.target.value)}
                        >
                          <option value="large">1200px (Default)</option>
                          <option value="medium">960px (Contained)</option>
                          <option value="small">640px (Narrow)</option>
                          <option value="full">100% (Full Width)</option>
                        </select>
                      </div>
                    </div>

                    {/* 2. Color Palette */}
                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "14px" }}>
                      <span className="npati-builder-group-title">Color Palette</span>

                      {/* Background Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Background</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.backgroundColor?.startsWith("#") ? selectedBlock.styles.backgroundColor : "#F8FAFF"}
                            onChange={(e) => handleUpdateBlockStyle("backgroundColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.backgroundColor || "#F8FAFF"}
                            onChange={(e) => handleUpdateBlockStyle("backgroundColor", e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Quick palette preset chips */}
                      <div className="npati-builder-palette-chips">
                        {["#ffffff", "#F8FAFF", "#F1F5F9", "#0F172A", "#e11d2e"].map((c) => (
                          <button
                            key={c}
                            type="button"
                            className="npati-builder-palette-chip"
                            style={{ background: c }}
                            onClick={() => handleUpdateBlockStyle("backgroundColor", c)}
                            title={c}
                          />
                        ))}
                      </div>

                      {/* Title Color */}
                      <div className="npati-builder-color-row" style={{ marginTop: "10px" }}>
                        <span className="npati-builder-color-label">Title Color</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.textColor?.startsWith("#") ? selectedBlock.styles.textColor : "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("textColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.textColor || "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("textColor", e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Subtitle / Body Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Body Text</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.accentColor?.startsWith("#") ? selectedBlock.styles.accentColor : "#475569"}
                            onChange={(e) => handleUpdateBlockStyle("accentColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.accentColor || "#475569"}
                            onChange={(e) => handleUpdateBlockStyle("accentColor", e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Primary Button Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Button Color</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.borderColor?.startsWith("#") ? selectedBlock.styles.borderColor : "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("borderColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.borderColor || "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("borderColor", e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    {/* 3. Typography */}
                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "14px" }}>
                      <span className="npati-builder-group-title">Typography</span>
                      <div className="npati-builder-form-group" style={{ marginBottom: "12px" }}>
                        <label className="npati-builder-form-label">Font Family</label>
                        <select
                          className="npati-builder-select"
                          value={doc?.theme?.fontFamily || "inter"}
                          onChange={(e) => {
                            if (doc) {
                              pushDocumentChange({
                                ...doc,
                                theme: { ...doc.theme, fontFamily: e.target.value as WebsiteTheme["fontFamily"] },
                              });
                            }
                          }}
                        >
                          <option value="inter">Inter (Clean Modern)</option>
                          <option value="roboto">Roboto (Geometric)</option>
                          <option value="playfair">Playfair Display (Serif)</option>
                          <option value="geist">Geist (Minimalist)</option>
                          <option value="system">System Default</option>
                        </select>
                      </div>

                      <div className="npati-builder-form-group">
                        <label className="npati-builder-form-label">Title Weight</label>
                        <select
                          className="npati-builder-select"
                          defaultValue="800"
                          onChange={(e) => handleUpdateBlockProp("_headingWeight", e.target.value)}
                        >
                          <option value="600">Semi-Bold (600)</option>
                          <option value="700">Bold (700)</option>
                          <option value="800">Extra Bold (800)</option>
                        </select>
                      </div>
                    </div>

                    {/* 4. Borders & Corners */}
                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "14px" }}>
                      <span className="npati-builder-group-title">Borders & Corners</span>
                      <div className="npati-builder-form-group">
                        <label className="npati-builder-form-label">Corner Radius</label>
                        <select
                          className="npati-builder-select"
                          defaultValue="md"
                          onChange={(e) => {
                            if (doc) {
                              pushDocumentChange({
                                ...doc,
                                theme: { ...doc.theme, borderRadius: e.target.value as WebsiteTheme["borderRadius"] },
                              });
                            }
                          }}
                        >
                          <option value="none">Sharp (0px)</option>
                          <option value="sm">Small (6px)</option>
                          <option value="md">Rounded (12px)</option>
                          <option value="lg">Large (18px)</option>
                          <option value="full">Pill / Full</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB: DESIGN (Global Website Styles) */}
          {inspectorTab === "design" && doc && (
            <WebsiteEditorInspectorDesignTab doc={doc} pushDocumentChange={pushDocumentChange} />
          )}

          {/* TAB: ADVANCED (SEO & Head scripts) */}
          {inspectorTab === "advanced" && (
            <WebsiteEditorInspectorAdvancedTab
              activePage={activePage}
              doc={doc}
              pushDocumentChange={pushDocumentChange}
              setActiveDrawer={setActiveDrawer}
            />
          )}
        </aside>
  );
}
