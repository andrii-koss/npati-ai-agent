import { isolatedPreviewUrl } from "./preview-origin";
import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  ExternalLink,
  RefreshCw,
  Monitor,
  Tablet,
  Smartphone,
  ChevronDown,
  Code2,
  SquareTerminal,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  X,
  MoreHorizontal,
} from "lucide-react";
import type { PreviewRuntimeStatus } from "./ChatProjectPreviewCard";
import { PreviewSideButton } from "./PreviewSideButton";

export type DeviceMode = "desktop" | "tablet" | "mobile";

export interface LivePreviewHeaderProps {
  projectName: string;
  runtimeStatus: PreviewRuntimeStatus;
  statusLabel?: string;
  previewUrl: string | null;
  isUk: boolean;
  codeWorkspaceUrl: string | null;
  terminalUrl: string | null;
  deviceMode: DeviceMode;
  setDeviceMode: (mode: DeviceMode) => void;
  isFullscreen: boolean;
  setIsFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
  onRefresh: () => void;
  onClose: () => void;
}

export function LivePreviewHeader({
  projectName,
  runtimeStatus,
  statusLabel,
  previewUrl,
  isUk,
  codeWorkspaceUrl,
  terminalUrl,
  deviceMode,
  setDeviceMode,
  isFullscreen,
  setIsFullscreen,
  onRefresh,
  onClose,
}: LivePreviewHeaderProps) {
  const navigate = useNavigate();
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const deviceMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  // Close menus when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (deviceMenuRef.current && !deviceMenuRef.current.contains(event.target as Node)) {
        setDeviceMenuOpen(false);
      }
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) {
        setMoreMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleOpenInNewTab() {
    if (previewUrl) {
      window.open(isolatedPreviewUrl(previewUrl), "_blank", "noopener,noreferrer");
    }
  }

  function handleRefresh() {
    setIsRefreshing(true);
    onRefresh();
    setTimeout(() => setIsRefreshing(false), 600);
  }

  async function handleCopy() {
    if (!previewUrl) return;
    try {
      await navigator.clipboard.writeText(previewUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Fallback if clipboard API is restricted
      const textarea = document.createElement("textarea");
      textarea.value = previewUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    }
  }

  function handleOpenCode() {
    if (codeWorkspaceUrl) {
      navigate(codeWorkspaceUrl);
    }
  }

  function handleOpenTerminal() {
    if (terminalUrl) {
      navigate(terminalUrl);
    }
  }

  const defaultStatusLabels: Record<PreviewRuntimeStatus, string> = {
    running: isUk ? "Запущено" : "Running",
    starting: isUk ? "Запуск..." : "Starting...",
    stopped: isUk ? "Зупинено" : "Stopped",
    failed: isUk ? "Помилка" : "Failed",
    unavailable: isUk ? "Недоступно" : "Preview unavailable",
  };

  const statusText = statusLabel || defaultStatusLabels[runtimeStatus];

  return (
    <header className="project-chat-preview-header" role="toolbar" aria-label={isUk ? "Панель керування Live Preview" : "Live Preview Toolbar"}>
      {/* Left: Indicator, Project Name, ExternalLink */}
      <div className="preview-header-left">
        <span
          className={`preview-header-status-dot status-${runtimeStatus}`}
          title={statusText}
          aria-label={statusText}
          role="status"
        />
        <h3 className="preview-header-project-name" title={projectName}>
          {projectName}
        </h3>
        <button
          type="button"
          className="preview-header-icon-btn preview-header-ext-btn"
          onClick={handleOpenInNewTab}
          disabled={!previewUrl}
          aria-label={isUk ? "Відкрити у новій вкладці" : "Open in new tab"}
          title={isUk ? "Відкрити у новій вкладці" : "Open in new tab"}
        >
          <ExternalLink size={18} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </div>

      {/* Right: Actions */}
      <div className="preview-header-right">
        <PreviewSideButton isUk={isUk} />

        {/* Full Desktop Actions */}
        <div className="preview-header-actions-desktop">
          {/* 1. RefreshCw */}
          <button
            type="button"
            className={`preview-header-icon-btn ${isRefreshing ? "is-spinning" : ""}`}
            onClick={handleRefresh}
            aria-label={isUk ? "Оновити Live Preview" : "Reload Live Preview"}
            title={isUk ? "Оновити Live Preview" : "Reload Live Preview"}
          >
            <RefreshCw size={19} strokeWidth={1.9} aria-hidden="true" />
          </button>

          {/* 2. Screen Size Switcher (Monitor + ChevronDown) */}
          <div className="preview-header-dropdown-wrap" ref={deviceMenuRef}>
            <button
              type="button"
              className="preview-header-icon-btn preview-header-device-btn"
              onClick={() => setDeviceMenuOpen((v) => !v)}
              aria-label={isUk ? "Розмір екрана" : "Screen size"}
              title={isUk ? "Розмір екрана" : "Screen size"}
              aria-haspopup="true"
              aria-expanded={deviceMenuOpen}
            >
              {deviceMode === "mobile" ? (
                <Smartphone size={19} strokeWidth={1.9} aria-hidden="true" />
              ) : deviceMode === "tablet" ? (
                <Tablet size={19} strokeWidth={1.9} aria-hidden="true" />
              ) : (
                <Monitor size={19} strokeWidth={1.9} aria-hidden="true" />
              )}
              <ChevronDown size={14} strokeWidth={2.2} className="preview-header-chevron" aria-hidden="true" />
            </button>

            {deviceMenuOpen && (
              <div className="preview-header-dropdown-menu" role="menu">
                <button
                  type="button"
                  className={`preview-header-menu-item ${deviceMode === "desktop" ? "active" : ""}`}
                  role="menuitem"
                  onClick={() => {
                    setDeviceMode("desktop");
                    setDeviceMenuOpen(false);
                  }}
                >
                  <Monitor size={16} aria-hidden="true" />
                  <span>Desktop (100%)</span>
                </button>
                <button
                  type="button"
                  className={`preview-header-menu-item ${deviceMode === "tablet" ? "active" : ""}`}
                  role="menuitem"
                  onClick={() => {
                    setDeviceMode("tablet");
                    setDeviceMenuOpen(false);
                  }}
                >
                  <Tablet size={16} aria-hidden="true" />
                  <span>Tablet (768px)</span>
                </button>
                <button
                  type="button"
                  className={`preview-header-menu-item ${deviceMode === "mobile" ? "active" : ""}`}
                  role="menuitem"
                  onClick={() => {
                    setDeviceMode("mobile");
                    setDeviceMenuOpen(false);
                  }}
                >
                  <Smartphone size={16} aria-hidden="true" />
                  <span>Mobile (375px)</span>
                </button>
              </div>
            )}
          </div>

          <div className="preview-header-divider" aria-hidden="true" />

          {/* 3. Code2 */}
          <button
            type="button"
            className="preview-header-icon-btn"
            onClick={handleOpenCode}
            disabled={!codeWorkspaceUrl}
            aria-label={isUk ? "Відкрити код проєкту" : "Open project code"}
            title={isUk ? "Відкрити код проєкту" : "Open project code"}
          >
            <Code2 size={20} strokeWidth={1.9} aria-hidden="true" />
          </button>

          {/* 4. SquareTerminal */}
          <button
            type="button"
            className="preview-header-icon-btn"
            onClick={handleOpenTerminal}
            disabled={!terminalUrl}
            aria-label={isUk ? "Відкрити термінал проєкту" : "Open project terminal"}
            title={isUk ? "Відкрити термінал проєкту" : "Open project terminal"}
          >
            <SquareTerminal size={19} strokeWidth={1.9} aria-hidden="true" />
          </button>

          <div className="preview-header-divider" aria-hidden="true" />

          {/* 5. Copy */}
          <button
            type="button"
            className="preview-header-icon-btn"
            onClick={() => void handleCopy()}
            disabled={!previewUrl}
            aria-label={copiedUrl ? (isUk ? "Скопійовано!" : "Copied!") : (isUk ? "Скопіювати посилання" : "Copy preview link")}
            title={copiedUrl ? (isUk ? "Скопійовано!" : "Copied!") : (isUk ? "Скопіювати посилання" : "Copy preview link")}
          >
            {copiedUrl ? (
              <Check size={19} strokeWidth={2.2} className="preview-icon-success" aria-hidden="true" />
            ) : (
              <Copy size={19} strokeWidth={1.9} aria-hidden="true" />
            )}
          </button>

          {/* 6. Maximize / Restore */}
          <button
            type="button"
            className="preview-header-icon-btn"
            onClick={() => setIsFullscreen((f) => !f)}
            aria-label={isFullscreen ? (isUk ? "Згорнути" : "Restore size") : (isUk ? "На весь екран" : "Maximize")}
            title={isFullscreen ? (isUk ? "Згорнути" : "Restore size") : (isUk ? "На весь екран" : "Maximize")}
            aria-pressed={isFullscreen}
          >
            {isFullscreen ? (
              <Minimize2 size={19} strokeWidth={1.9} aria-hidden="true" />
            ) : (
              <Maximize2 size={19} strokeWidth={1.9} aria-hidden="true" />
            )}
          </button>

          <div className="preview-header-divider" aria-hidden="true" />
        </div>

        {/* Compact More Menu for Narrow Screens */}
        <div className="preview-header-actions-mobile" ref={moreMenuRef}>
          <button
            type="button"
            className={`preview-header-icon-btn ${isRefreshing ? "is-spinning" : ""}`}
            onClick={handleRefresh}
            aria-label={isUk ? "Оновити Live Preview" : "Reload Live Preview"}
            title={isUk ? "Оновити Live Preview" : "Reload Live Preview"}
          >
            <RefreshCw size={19} strokeWidth={1.9} aria-hidden="true" />
          </button>

          <button
            type="button"
            className="preview-header-icon-btn"
            onClick={() => setMoreMenuOpen((v) => !v)}
            aria-label={isUk ? "Більше дій" : "More actions"}
            title={isUk ? "Більше дій" : "More actions"}
            aria-haspopup="true"
            aria-expanded={moreMenuOpen}
          >
            <MoreHorizontal size={19} strokeWidth={1.9} aria-hidden="true" />
          </button>

          {moreMenuOpen && (
            <div className="preview-header-dropdown-menu" role="menu">
              <button
                type="button"
                className={`preview-header-menu-item ${deviceMode === "desktop" ? "active" : ""}`}
                role="menuitem"
                onClick={() => {
                  setDeviceMode("desktop");
                  setMoreMenuOpen(false);
                }}
              >
                <Monitor size={16} aria-hidden="true" />
                <span>Desktop (100%)</span>
              </button>
              <button
                type="button"
                className={`preview-header-menu-item ${deviceMode === "tablet" ? "active" : ""}`}
                role="menuitem"
                onClick={() => {
                  setDeviceMode("tablet");
                  setMoreMenuOpen(false);
                }}
              >
                <Tablet size={16} aria-hidden="true" />
                <span>Tablet (768px)</span>
              </button>
              <button
                type="button"
                className={`preview-header-menu-item ${deviceMode === "mobile" ? "active" : ""}`}
                role="menuitem"
                onClick={() => {
                  setDeviceMode("mobile");
                  setMoreMenuOpen(false);
                }}
              >
                <Smartphone size={16} aria-hidden="true" />
                <span>Mobile (375px)</span>
              </button>
              <hr className="preview-header-menu-hr" />
              {codeWorkspaceUrl && (
                <button
                  type="button"
                  className="preview-header-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    handleOpenCode();
                  }}
                >
                  <Code2 size={16} aria-hidden="true" />
                  <span>{isUk ? "Відкрити код" : "Open code"}</span>
                </button>
              )}
              {terminalUrl && (
                <button
                  type="button"
                  className="preview-header-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    handleOpenTerminal();
                  }}
                >
                  <SquareTerminal size={16} aria-hidden="true" />
                  <span>{isUk ? "Відкрити термінал" : "Open terminal"}</span>
                </button>
              )}
              {previewUrl && (
                <button
                  type="button"
                  className="preview-header-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    void handleCopy();
                  }}
                >
                  {copiedUrl ? <Check size={16} className="preview-icon-success" /> : <Copy size={16} />}
                  <span>{copiedUrl ? (isUk ? "Скопійовано!" : "Copied!") : (isUk ? "Скопіювати посилання" : "Copy preview link")}</span>
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            className="preview-header-icon-btn"
            onClick={() => setIsFullscreen((f) => !f)}
            aria-label={isFullscreen ? (isUk ? "Згорнути" : "Restore size") : (isUk ? "На весь екран" : "Maximize")}
            title={isFullscreen ? (isUk ? "Згорнути" : "Restore size") : (isUk ? "На весь екран" : "Maximize")}
            aria-pressed={isFullscreen}
          >
            {isFullscreen ? (
              <Minimize2 size={19} strokeWidth={1.9} aria-hidden="true" />
            ) : (
              <Maximize2 size={19} strokeWidth={1.9} aria-hidden="true" />
            )}
          </button>
        </div>

        {/* 7. Close X Button (always present) */}
        <button
          type="button"
          className="preview-header-icon-btn preview-header-close-btn"
          onClick={onClose}
          aria-label={isUk ? "Закрити перегляд" : "Close preview"}
          title={isUk ? "Закрити" : "Close"}
        >
          <X size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

