import React from "react";
import { Link } from "react-router-dom";
import type { WebsiteDocument } from "@npati/shared";
import {
  IconBack,
  IconChevronDown,
  IconDesktop,
  IconTablet,
  IconMobile,
  IconUndo,
  IconRedo,
  IconSave,
  IconEye,
  IconPublish,
  IconMore,
  IconSparkles,
  IconFile,
  IconGrip,
  IconClose,
} from "./website-editor-icons";
import type { DeviceMode, ActiveDrawer, InspectorTab, PreviewStatusResponse } from "./website-editor-support";

export interface WebsiteEditorTopbarProps {
  doc: WebsiteDocument | null;
  handleRenameSite: () => void;
  saveStatus: "saved" | "unsaved" | "saving";
  deviceMode: DeviceMode;
  setDeviceMode: (mode: DeviceMode) => void;
  undo: () => void;
  redo: () => void;
  historyIndex: number;
  historyLength: number;
  saveDocumentToProject: () => void;
  visualConfigUnavailable: boolean;
  staticPreviewActive: boolean;
  previewMode: "visual" | "sandbox";
  previewStatus: PreviewStatusResponse | null;
  setStaticPreviewActive: React.Dispatch<React.SetStateAction<boolean>>;
  setPreviewMode: React.Dispatch<React.SetStateAction<"visual" | "sandbox">>;
  handleStartPreview: () => void;
  handleDeploy: () => void;
  isDeploying: boolean;
  moreMenuOpen: boolean;
  setMoreMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  moreMenuRef: React.RefObject<HTMLDivElement | null>;
  setActiveDrawer: (d: ActiveDrawer) => void;
  setInspectorTab: (t: InspectorTab) => void;
  language: string;
}

export function WebsiteEditorTopbar({
  doc,
  handleRenameSite,
  saveStatus,
  deviceMode,
  setDeviceMode,
  undo,
  redo,
  historyIndex,
  historyLength,
  saveDocumentToProject,
  visualConfigUnavailable,
  staticPreviewActive,
  previewMode,
  previewStatus,
  setStaticPreviewActive,
  setPreviewMode,
  handleStartPreview,
  handleDeploy,
  isDeploying,
  moreMenuOpen,
  setMoreMenuOpen,
  moreMenuRef,
  setActiveDrawer,
  setInspectorTab,
  language,
}: WebsiteEditorTopbarProps) {
  return (
    <header className="npati-builder-topbar">
      {/* Left: Back button, Website name, Framework badge, Saved status */}
      <div className="npati-builder-topbar-left">
        <Link to="/settings/projects" className="npati-builder-back-btn" title="Back to Projects">
          <IconBack />
        </Link>

        <div
          className="npati-builder-site-title"
          onClick={() => void handleRenameSite()}
          title="Click to rename website"
        >
          <span>{doc?.name || "My Business Website"}</span>
          <IconChevronDown />
        </div>

        <span className="npati-builder-framework-badge">
          <span style={{ fontSize: "10px", opacity: 0.7, marginRight: "2px" }}>
            {doc?.framework === "static" ? "HTM" : "NEX"}
          </span>
          {doc?.framework === "static" ? "HTML/CSS" : doc?.framework === "vite" ? "VITE" : "NEXT.JS"}
        </span>

        <div className={`npati-builder-save-status ${saveStatus}`}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: saveStatus === "saved" ? "#10b981" : saveStatus === "saving" ? "#f59e0b" : "#94a3b8",
            }}
          />
          <span>
            {saveStatus === "saved" ? "Saved 2 minutes ago" : saveStatus === "saving" ? "Saving..." : "Unsaved"}
          </span>
        </div>
      </div>

      {/* Center: Device Mode Switcher (Desktop / Tablet / Mobile) */}
      <div className="npati-builder-topbar-center">
        <div className="npati-builder-device-segmented">
          <button
            type="button"
            className={`npati-builder-device-btn ${deviceMode === "desktop" ? "active" : ""}`}
            onClick={() => setDeviceMode("desktop")}
            title="Desktop viewport"
          >
            <IconDesktop />
            <span>Desktop</span>
          </button>
          <button
            type="button"
            className={`npati-builder-device-btn ${deviceMode === "tablet" ? "active" : ""}`}
            onClick={() => setDeviceMode("tablet")}
            title="Tablet viewport"
          >
            <IconTablet />
            <span>Tablet</span>
          </button>
          <button
            type="button"
            className={`npati-builder-device-btn ${deviceMode === "mobile" ? "active" : ""}`}
            onClick={() => setDeviceMode("mobile")}
            title="Mobile viewport"
          >
            <IconMobile />
            <span>Mobile</span>
          </button>
        </div>
      </div>

      {/* Right: Actions (Undo, Redo, Save, Preview, Publish, More Menu, Close) */}
      <div className="npati-builder-topbar-right">
        <button
          type="button"
          className="npati-builder-icon-btn"
          onClick={undo}
          disabled={historyIndex <= 0}
          title={language === "uk" ? "Скасувати (Ctrl+Z)" : "Undo"}
        >
          <IconUndo />
        </button>
        <button
          type="button"
          className="npati-builder-icon-btn"
          onClick={redo}
          disabled={historyIndex >= historyLength - 1}
          title={language === "uk" ? "Повторити (Ctrl+Y)" : "Redo"}
        >
          <IconRedo />
        </button>

        {/* SAVE BUTTON */}
        <button
          type="button"
          className="npati-builder-save-btn"
          onClick={() => void saveDocumentToProject()}
          disabled={saveStatus === "saving" || visualConfigUnavailable || (doc?.framework === "static" && staticPreviewActive)}
          title={language === "uk" ? "Зберегти зміни" : "Save changes"}
        >
          <IconSave />
          <span>
            {saveStatus === "saving"
              ? language === "uk"
                ? "Збереження..."
                : "Saving..."
              : language === "uk"
              ? "Зберегти"
              : "Save"}
          </span>
        </button>

        {/* PREVIEW BUTTON */}
        <button
          type="button"
          className={`npati-builder-preview-btn ${previewMode === "sandbox" ? "active" : ""}`}
          onClick={() => {
            if (doc?.framework === "static") {
              setStaticPreviewActive((active) => !active);
              return;
            }
            if (previewStatus?.isRunning) {
              setPreviewMode((m) => (m === "visual" ? "sandbox" : "visual"));
            } else {
              void handleStartPreview();
            }
          }}
          title="Toggle Live Preview"
        >
          <IconEye />
          <span>
            {doc?.framework === "static"
              ? staticPreviewActive
                ? language === "uk"
                  ? "Конструктор"
                  : "Visual editor"
                : language === "uk"
                ? "Перегляд сайту"
                : "Site preview"
              : previewMode === "sandbox"
              ? language === "uk"
                ? "Конструктор"
                : "Visual View"
              : language === "uk"
              ? "Перегляд"
              : "Preview"}
          </span>
        </button>

        {/* PUBLISH BUTTON */}
        <button
          type="button"
          className="npati-builder-publish-btn"
          onClick={() => void handleDeploy()}
          disabled={isDeploying}
        >
          <IconPublish />
          <span>
            {isDeploying
              ? language === "uk"
                ? "Публікація..."
                : "Publishing..."
              : language === "uk"
              ? "Опублікувати"
              : "Publish"}
          </span>
        </button>

        {/* More options menu */}
        <div style={{ position: "relative" }} ref={moreMenuRef}>
          <button
            type="button"
            className="npati-builder-icon-btn"
            onClick={() => setMoreMenuOpen((o) => !o)}
            title="More Options"
          >
            <IconMore />
          </button>

          {moreMenuOpen && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: "6px",
                width: "210px",
                background: "#ffffff",
                borderRadius: "10px",
                boxShadow: "0 10px 30px rgba(0, 0, 0, 0.12)",
                border: "1px solid #e2e8f0",
                padding: "6px",
                zIndex: 100,
                display: "flex",
                flexDirection: "column",
                gap: "2px",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setMoreMenuOpen(false);
                  setActiveDrawer("ai");
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  width: "100%",
                  padding: "8px 10px",
                  background: "transparent",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  color: "#0f172a",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <IconSparkles />
                <span>AI Developer Agent</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoreMenuOpen(false);
                  setActiveDrawer("files");
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  width: "100%",
                  padding: "8px 10px",
                  background: "transparent",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  color: "#0f172a",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <IconFile />
                <span>Project Files & Code</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoreMenuOpen(false);
                  setActiveDrawer("history");
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  width: "100%",
                  padding: "8px 10px",
                  background: "transparent",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  color: "#0f172a",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <IconGrip />
                <span>Checkpoints & Git</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoreMenuOpen(false);
                  setInspectorTab("advanced");
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  width: "100%",
                  padding: "8px 10px",
                  background: "transparent",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  color: "#0f172a",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <IconPublish />
                <span>SEO & Meta Tags</span>
              </button>
            </div>
          )}
        </div>

        {/* Close button matching project style */}
        <Link
          to="/settings/projects"
          className="npati-builder-close-btn"
          title={language === "uk" ? "Закрити" : "Close"}
          aria-label="Close"
        >
          <IconClose />
        </Link>
      </div>
    </header>
  );
}
