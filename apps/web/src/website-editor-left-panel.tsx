import React from "react";
import {
  COMPONENT_REGISTRY,
  type WebsiteDocument,
  type WebsitePage,
  type WebsiteBlock,
  type WebsiteBlockType,
} from "@npati/shared";
import {
  RenderPageIcon,
  IconMore,
  IconEdit,
  IconCopy,
  IconArrowUp,
  IconArrowDown,
  IconTrash,
  IconPlus,
  IconSectionSymbol,
  IconEye,
  IconEyeOff,
  IconGrip,
} from "./website-editor-icons";
import {
  type LeftPanelTab,
  type InspectorTab,
  type FileEntry,
} from "./website-editor-support";
import { alertModal } from "./ConfirmDialog";

export interface WebsiteEditorLeftPanelProps {
  leftTab: LeftPanelTab;
  setLeftTab: (tab: LeftPanelTab) => void;
  doc: WebsiteDocument | null;
  activePageId: string;
  setActivePageId: (id: string) => void;
  setSelectedBlockId: (id: string | null) => void;
  openPageMenuId: string | null;
  setOpenPageMenuId: (id: string | null) => void;
  openBlockMenuId: string | null;
  setOpenBlockMenuId: (id: string | null) => void;
  handleOpenAddPageModal: () => void;
  handleOpenEditPageModal: (page: WebsitePage) => void;
  handleDuplicatePage: (pageId: string) => void;
  handleMovePage: (pageId: string, direction: "up" | "down") => void;
  handleDeletePage: (pageId: string) => void;
  setPageModal: React.Dispatch<React.SetStateAction<any>>;
  activePage: WebsitePage | null | undefined;
  selectedBlockId: string | null;
  setInspectorTab: (tab: InspectorTab) => void;
  addSectionMenuOpen: boolean;
  setAddSectionMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleAddBlock: (type: WebsiteBlockType) => void;
  handleDuplicateBlock: (blockId: string) => void;
  handleMoveBlock: (blockId: string, direction: "up" | "down") => void;
  handleToggleHideBlock: (blockId: string) => void;
  handleDeleteBlock: (blockId: string) => void;
  uploadingAsset: boolean;
  handleUploadAsset: (e: React.ChangeEvent<HTMLInputElement>) => void;
  files: FileEntry[];
  selectedBlock: WebsiteBlock | null | undefined;
  handleUpdateBlockProp: (prop: string, val: any) => void;
  language: string;
}

export function WebsiteEditorLeftPanel({
  leftTab,
  setLeftTab,
  doc,
  activePageId,
  setActivePageId,
  setSelectedBlockId,
  openPageMenuId,
  setOpenPageMenuId,
  openBlockMenuId,
  setOpenBlockMenuId,
  handleOpenAddPageModal,
  handleOpenEditPageModal,
  handleDuplicatePage,
  handleMovePage,
  handleDeletePage,
  setPageModal,
  activePage,
  selectedBlockId,
  setInspectorTab,
  addSectionMenuOpen,
  setAddSectionMenuOpen,
  handleAddBlock,
  handleDuplicateBlock,
  handleMoveBlock,
  handleToggleHideBlock,
  handleDeleteBlock,
  uploadingAsset,
  handleUploadAsset,
  files,
  selectedBlock,
  handleUpdateBlockProp,
  language,
}: WebsiteEditorLeftPanelProps) {
  return (
        <aside className="npati-builder-left-panel">
          {/* Top Segmented Tabs: Pages | Layers | Assets */}
          <div className="npati-builder-nav-tabs-wrapper">
            <div className="npati-builder-nav-tabs">
              <button
                type="button"
                className={`npati-builder-nav-tab ${leftTab === "pages" ? "active" : ""}`}
                onClick={() => setLeftTab("pages")}
              >
                Pages
              </button>
              <button
                type="button"
                className={`npati-builder-nav-tab ${leftTab === "layers" ? "active" : ""}`}
                onClick={() => setLeftTab("layers")}
              >
                Layers
              </button>
              <button
                type="button"
                className={`npati-builder-nav-tab ${leftTab === "assets" ? "active" : ""}`}
                onClick={() => setLeftTab("assets")}
              >
                Assets
              </button>
            </div>
          </div>

          {/* TAB: PAGES */}
          {leftTab === "pages" && (
            <div className="npati-builder-tab-content">
              {/* Pages List */}
              <div className="npati-builder-page-list">
                {(doc?.pages || []).map((page, pIdx) => {
                  const isActive = page.id === activePageId;
                  const isHome = page.slug === "/" || page.id === "page-home";
                  return (
                    <div
                      key={page.id}
                      className={`npati-builder-page-item ${isActive ? "active" : ""}`}
                      onClick={() => {
                        setActivePageId(page.id);
                        if (page.blocks[0]) setSelectedBlockId(page.blocks[0].id);
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                        <RenderPageIcon icon={page.icon} isHome={isHome} />
                        <span style={{ fontWeight: isActive ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {page.title}
                        </span>
                      </div>

                      {/* Page Settings Action Popover */}
                      <div style={{ position: "relative" }}>
                        <button
                          type="button"
                          className="npati-builder-page-settings-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenPageMenuId(openPageMenuId === page.id ? null : page.id);
                          }}
                          title="Page Settings"
                        >
                          <IconMore />
                        </button>

                        {openPageMenuId === page.id && (
                          <div className="npati-builder-action-popover" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="npati-builder-popover-item"
                              onClick={() => {
                                setOpenPageMenuId(null);
                                handleOpenEditPageModal(page);
                              }}
                            >
                              <IconEdit />
                              <span>{language === "uk" ? "Редагувати сторінку" : "Edit Page"}</span>
                            </button>
                            <button
                              type="button"
                              className="npati-builder-popover-item"
                              onClick={() => {
                                setOpenPageMenuId(null);
                                handleDuplicatePage(page.id);
                              }}
                            >
                              <IconCopy />
                              <span>{language === "uk" ? "Скопіювати" : "Duplicate"}</span>
                            </button>
                            <button
                              type="button"
                              className="npati-builder-popover-item"
                              onClick={() => {
                                setOpenPageMenuId(null);
                                handleMovePage(page.id, "up");
                              }}
                              disabled={pIdx === 0}
                            >
                              <IconArrowUp />
                              <span>{language === "uk" ? "Перемістити вище" : "Move Up"}</span>
                            </button>
                            <button
                              type="button"
                              className="npati-builder-popover-item"
                              onClick={() => {
                                setOpenPageMenuId(null);
                                handleMovePage(page.id, "down");
                              }}
                              disabled={pIdx === (doc?.pages.length || 0) - 1}
                            >
                              <IconArrowDown />
                              <span>{language === "uk" ? "Перемістити нижче" : "Move Down"}</span>
                            </button>
                            {!isHome && (
                              <button
                                type="button"
                                className="npati-builder-popover-item danger"
                                onClick={() => {
                                  setOpenPageMenuId(null);
                                  void handleDeletePage(page.id);
                                }}
                              >
                                <IconTrash />
                                <span>{language === "uk" ? "Видалити" : "Delete"}</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                <button
                  type="button"
                  className="npati-builder-add-page-btn"
                  onClick={handleOpenAddPageModal}
                >
                  <IconPlus />
                  <span>Add Page</span>
                </button>
              </div>

              {/* Sections Structure Hierarchy of current page */}
              <div className="npati-builder-sections-wrap">
                <div className="npati-builder-sections-header">
                  <span className="npati-builder-sections-title">
                    {activePage?.title || "Home"} Sections
                  </span>

                  {/* Add section plus button in same row */}
                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      className="npati-builder-add-section-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddSectionMenuOpen((prev) => !prev);
                      }}
                      title={language === "uk" ? "Додати секцію" : "Add Section"}
                    >
                      <IconPlus />
                    </button>

                    {addSectionMenuOpen && (
                      <div className="npati-builder-action-popover section-templates-popover" onClick={(e) => e.stopPropagation()}>
                        <div className="npati-builder-popover-title">
                          {language === "uk" ? "Виберіть секцію" : "Add Section"}
                        </div>
                        {Object.entries(COMPONENT_REGISTRY).map(([type, def]) => (
                          <button
                            key={type}
                            type="button"
                            className="npati-builder-popover-item"
                            onClick={() => {
                              setAddSectionMenuOpen(false);
                              handleAddBlock(type as WebsiteBlockType);
                            }}
                          >
                            <IconSectionSymbol type={type} />
                            <span>{def.title}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="npati-builder-sections-list">
                  {(activePage?.blocks || []).map((b, idx) => {
                    const isSelected = selectedBlockId === b.id;
                    const def = COMPONENT_REGISTRY[b.type] || COMPONENT_REGISTRY.custom;
                    return (
                      <div
                        key={b.id}
                        className={`npati-builder-section-row ${isSelected ? "active" : ""}`}
                        onClick={() => {
                          setSelectedBlockId(b.id);
                          setInspectorTab("properties");
                        }}
                        style={{ opacity: b.isHidden ? 0.45 : 1 }}
                      >
                        <div className="npati-builder-section-info">
                          <span className="npati-builder-drag-handle">
                            <IconGrip />
                          </span>
                          <span className="npati-builder-section-icon">
                            <IconSectionSymbol type={b.type} />
                          </span>
                          <span className="npati-builder-section-name">
                            {b.name || def.title}
                          </span>
                        </div>

                        {/* 3 Dots button on each block with popover */}
                        <div style={{ position: "relative" }}>
                          <button
                            type="button"
                            className="npati-builder-more-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenBlockMenuId(openBlockMenuId === b.id ? null : b.id);
                            }}
                            title="Actions"
                          >
                            <IconMore />
                          </button>

                          {openBlockMenuId === b.id && (
                            <div className="npati-builder-action-popover" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                className="npati-builder-popover-item"
                                onClick={() => {
                                  setOpenBlockMenuId(null);
                                  handleMoveBlock(b.id, "up");
                                }}
                                disabled={idx === 0}
                              >
                                <IconArrowUp />
                                <span>{language === "uk" ? "Підняти вгору" : "Move Up"}</span>
                              </button>
                              <button
                                type="button"
                                className="npati-builder-popover-item"
                                onClick={() => {
                                  setOpenBlockMenuId(null);
                                  handleMoveBlock(b.id, "down");
                                }}
                                disabled={idx === (activePage?.blocks.length || 0) - 1}
                              >
                                <IconArrowDown />
                                <span>{language === "uk" ? "Опустити вниз" : "Move Down"}</span>
                              </button>
                              <button
                                type="button"
                                className="npati-builder-popover-item"
                                onClick={() => {
                                  setOpenBlockMenuId(null);
                                  handleDuplicateBlock(b.id);
                                }}
                              >
                                <IconCopy />
                                <span>{language === "uk" ? "Скопіювати" : "Duplicate"}</span>
                              </button>
                              <button
                                type="button"
                                className="npati-builder-popover-item"
                                onClick={() => {
                                  setOpenBlockMenuId(null);
                                  handleToggleHideBlock(b.id);
                                }}
                              >
                                {b.isHidden ? <IconEye /> : <IconEyeOff />}
                                <span>{b.isHidden ? (language === "uk" ? "Показати" : "Show") : (language === "uk" ? "Сховати" : "Hide")}</span>
                              </button>
                              <button
                                type="button"
                                className="npati-builder-popover-item danger"
                                onClick={() => {
                                  setOpenBlockMenuId(null);
                                  void handleDeleteBlock(b.id);
                                }}
                              >
                                <IconTrash />
                                <span>{language === "uk" ? "Видалити" : "Delete"}</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB: LAYERS */}
          {leftTab === "layers" && (
            <div className="npati-builder-tab-content">
              <span className="npati-builder-sections-title">Document Structure</span>
              <div className="npati-builder-sections-list">
                {(activePage?.blocks || []).map((b) => (
                  <div
                    key={b.id}
                    className={`npati-builder-section-row ${selectedBlockId === b.id ? "active" : ""}`}
                    onClick={() => { setSelectedBlockId(b.id); setInspectorTab("properties"); }}
                  >
                    <div className="npati-builder-section-info">
                      <IconSectionSymbol type={b.type} />
                      <span className="npati-builder-section-name" style={{ color: "#0f172a", fontWeight: 600 }}>{b.name || b.type}</span>
                    </div>
                    <span style={{ fontSize: "11px", color: "#0f172a" }}>#{b.type}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB: ASSETS */}
          {leftTab === "assets" && (
            <div className="npati-builder-tab-content">
              <span className="npati-builder-sections-title">Media & Assets</span>
              <label
                className="button-primary"
                style={{ textAlign: "center", cursor: "pointer", padding: "9px 14px", fontSize: "13px" }}
              >
                {uploadingAsset ? "Uploading..." : "+ Upload Image"}
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => void handleUploadAsset(e)}
                  style={{ display: "none" }}
                  disabled={uploadingAsset}
                />
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "12px" }}>
                {files
                  .filter((f) => f.path.match(/\.(png|jpg|jpeg|svg|webp|gif)$/i))
                  .map((f) => {
                    const url = `/${f.path.replace(/^public\//, "")}`;
                    return (
                      <div
                        key={f.path}
                        onClick={() => {
                          if (selectedBlock) handleUpdateBlockProp("imageUrl", url);
                          navigator.clipboard.writeText(url);
                          void alertModal({ message: `Copied URL: ${url}` });
                        }}
                        style={{
                          border: "1px solid #cbd5e1",
                          borderRadius: "8px",
                          padding: "6px",
                          cursor: "pointer",
                          background: "#ffffff",
                          textAlign: "center",
                        }}
                      >
                        <img src={url} alt={f.name} style={{ width: "100%", height: "65px", objectFit: "cover", borderRadius: "4px" }} />
                        <span style={{ fontSize: "11px", color: "#0f172a", fontWeight: 500, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {f.name}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </aside>
  );
}
