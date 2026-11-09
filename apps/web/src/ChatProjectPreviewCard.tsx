import React, { useState, useEffect, useRef, useContext, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate, Link } from "react-router-dom";
import { ExternalLink, ChevronDown, RefreshCw, MessageSquare, GitCommit, Terminal, Eye, ExternalLink as ExtIcon } from "lucide-react";
import type { ProjectCardData } from "@npati/shared";
import { getStoredAuthToken } from "./AuthContext";
import { readProjectFile } from "./project-files-client";
import { I18nContextRef } from "./i18n";
import { persistedModeLabel } from "./code-workspace/actions";
import { LivePreviewHeader, type DeviceMode } from "./LivePreviewHeader";
import { LivePreviewSplitResizer } from "./LivePreviewSplitResizer";

export type ProjectVariantType = "website" | "mobile_app" | "game" | "other";
export type PreviewRuntimeStatus = "running" | "starting" | "stopped" | "failed" | "unavailable";

/**
 * Projects whose Preview the user has open in this chat. A project's card moves to the agent's newest reply, which
 * mounts a new card; it reopens the Preview instead of closing it while the agent edits the project.
 */
export const ChatPreviewOpenContext = React.createContext<Set<string> | null>(null);

export interface ChatProjectPreviewCardProps {
  card: ProjectCardData;
  onActivate?: (card: ProjectCardData) => void;
  className?: string;
  showDropdown?: boolean;
  showPreviewTrigger?: boolean;
}

export function resolveChatProjectType(card: ProjectCardData): ProjectVariantType {
  const kind = (card.kind ?? "").toLowerCase().trim();
  const fw = (card.framework ?? "").toLowerCase().trim();
  const name = (card.name ?? "").toLowerCase().trim();

  if (kind === "mobile_app" || /expo|react\s*native|flutter|ios|android|mobile/.test(fw) || /mobile\s*app/.test(name)) {
    return "mobile_app";
  }
  if (kind === "game" || /game|canvas|phaser|pixi|three|godot|unity|arcade/.test(fw) || /game|tic-tac-toe|tictactoe/.test(name)) {
    return "game";
  }
  if (kind === "api" || /express|fastify|nestjs|fastapi|django|flask/.test(fw)) {
    return "other";
  }
  if (kind === "website" || kind === "website_project" || /next|vite|react|astro|html|css|vue|svelte|nuxt|angular|tailwind/.test(fw)) {
    return "website";
  }
  if (kind === "code_project") {
    if (/expo|react\s*native|flutter/.test(fw)) return "mobile_app";
    if (/phaser|pixi|three|game/.test(fw)) return "game";
    if (/next|vite|react|astro|vue|svelte|nuxt|angular|html/.test(fw)) return "website";
  }
  return "website";
}

function WebsiteSvgThumbnail() {
  return (
    <svg className="chat-preview-card-svg" viewBox="0 0 96 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="webGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#C4B5FD" />
          <stop offset="50%" stopColor="#A5B4FC" />
          <stop offset="100%" stopColor="#93C5FD" />
        </linearGradient>
      </defs>
      {/* Browser top bar */}
      <rect x="0" y="0" width="96" height="12" fill="#FFFFFF" />
      <line x1="0" y1="12" x2="96" y2="12" stroke="rgba(0,0,0,0.06)" strokeWidth="1" />
      {/* Window dots */}
      <circle cx="8" cy="6" r="1.75" fill="#FF5F56" />
      <circle cx="14" cy="6" r="1.75" fill="#FFBD2E" />
      <circle cx="20" cy="6" r="1.75" fill="#27C93F" />
      {/* Canvas gradient */}
      <rect x="0" y="12" width="96" height="48" fill="url(#webGrad)" />
      {/* Soft central bar */}
      <rect x="38" y="19" width="20" height="2.5" rx="1.25" fill="#FFFFFF" fillOpacity="0.8" />
      {/* Bottom UI card */}
      <rect x="12" y="28" width="64" height="26" rx="4" fill="#FFFFFF" fillOpacity="0.95" />
      <rect x="16" y="34" width="24" height="2" rx="1" fill="#CBD5E1" />
      <rect x="16" y="39" width="48" height="2" rx="1" fill="#E2E8F0" />
      <rect x="16" y="44" width="36" height="2" rx="1" fill="#E2E8F0" />
    </svg>
  );
}

function MobileSvgThumbnail() {
  return (
    <svg className="chat-preview-card-svg" viewBox="0 0 96 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="mobGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6366F1" />
          <stop offset="60%" stopColor="#8B5CF6" />
          <stop offset="100%" stopColor="#EC4899" />
        </linearGradient>
      </defs>
      {/* Backdrop */}
      <rect width="96" height="60" fill="#F1F5F9" />
      {/* Phone container */}
      <rect x="29" y="3" width="38" height="54" rx="7" fill="#0F172A" />
      {/* Phone screen */}
      <rect x="31" y="5" width="34" height="50" rx="5" fill="url(#mobGrad)" />
      {/* Dynamic island / notch */}
      <rect x="43" y="7" width="10" height="2" rx="1" fill="#0F172A" />
      {/* Header wireframe */}
      <rect x="35" y="14" width="26" height="3" rx="1.5" fill="#FFFFFF" fillOpacity="0.85" />
      {/* Two cards */}
      <rect x="35" y="21" width="11" height="11" rx="2.5" fill="#FFFFFF" fillOpacity="0.9" />
      <rect x="50" y="21" width="11" height="11" rx="2.5" fill="#FFFFFF" fillOpacity="0.9" />
      {/* Bottom list card */}
      <rect x="35" y="36" width="26" height="11" rx="2.5" fill="#FFFFFF" fillOpacity="0.9" />
      <rect x="38" y="39" width="14" height="2" rx="1" fill="#CBD5E1" />
      <rect x="38" y="42" width="20" height="1.5" rx="0.75" fill="#E2E8F0" />
    </svg>
  );
}

function GameSvgThumbnail() {
  return (
    <svg className="chat-preview-card-svg" viewBox="0 0 96 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="gameGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1E1B4B" />
          <stop offset="50%" stopColor="#312E81" />
          <stop offset="100%" stopColor="#4C1D95" />
        </linearGradient>
      </defs>
      {/* Top bar */}
      <rect width="96" height="12" fill="#0F172A" />
      <circle cx="8" cy="6" r="2" fill="#EF4444" />
      <circle cx="15" cy="6" r="2" fill="#F59E0B" />
      <circle cx="22" cy="6" r="2" fill="#10B981" />
      {/* Game canvas */}
      <rect y="12" width="96" height="48" fill="url(#gameGrad)" />
      {/* Retro stars / particles */}
      <circle cx="20" cy="22" r="1" fill="#FFFFFF" fillOpacity="0.6" />
      <circle cx="78" cy="24" r="1.5" fill="#FDE047" fillOpacity="0.8" />
      <circle cx="85" cy="45" r="1" fill="#FFFFFF" fillOpacity="0.5" />
      <circle cx="16" cy="48" r="1" fill="#38BDF8" fillOpacity="0.7" />
      {/* Controller D-pad */}
      <rect x="22" y="32" width="4" height="14" rx="1" fill="#F43F5E" />
      <rect x="17" y="37" width="14" height="4" rx="1" fill="#F43F5E" />
      {/* Center canvas hero / pixel craft */}
      <rect x="42" y="26" width="12" height="12" rx="2" fill="#38BDF8" />
      <rect x="45" y="29" width="6" height="6" rx="1" fill="#FFFFFF" />
      {/* Action buttons */}
      <circle cx="70" cy="42" r="3" fill="#10B981" />
      <circle cx="78" cy="35" r="3" fill="#F59E0B" />
    </svg>
  );
}

function OtherSvgThumbnail() {
  return (
    <svg className="chat-preview-card-svg" viewBox="0 0 96 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="codeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0F172A" />
          <stop offset="100%" stopColor="#1E293B" />
        </linearGradient>
      </defs>
      {/* Top bar */}
      <rect width="96" height="12" fill="#1E293B" />
      <line x1="0" y1="12" x2="96" y2="12" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
      <circle cx="8" cy="6" r="2" fill="#EF4444" />
      <circle cx="15" cy="6" r="2" fill="#F59E0B" />
      <circle cx="22" cy="6" r="2" fill="#10B981" />
      {/* Terminal canvas */}
      <rect y="12" width="96" height="48" fill="url(#codeGrad)" />
      {/* Code prompt */}
      <text x="12" y="26" fill="#22C55E" fontSize="9" fontFamily="monospace" fontWeight="bold">&gt;</text>
      <rect x="22" y="20" width="30" height="2" rx="1" fill="#38BDF8" />
      {/* Syntax lines */}
      <rect x="12" y="31" width="46" height="2" rx="1" fill="#94A3B8" />
      <rect x="18" y="37" width="54" height="2" rx="1" fill="#CBD5E1" fillOpacity="0.8" />
      <rect x="24" y="43" width="32" height="2" rx="1" fill="#818CF8" />
      <rect x="12" y="49" width="20" height="2" rx="1" fill="#F43F5E" />
    </svg>
  );
}

export function ChatProjectPreviewCard({
  card,
  onActivate,
  className = "",
  showDropdown = true,
  showPreviewTrigger = true,
}: ChatProjectPreviewCardProps) {
  const navigate = useNavigate();
  const i18n = useContext(I18nContextRef);
  const isUk = i18n?.language === "uk";

  const openPreviews = useContext(ChatPreviewOpenContext);
  const previewKey = card.projectId ?? card.id;
  const [previewOpen, setPreviewOpenState] = useState(false);
  const setPreviewOpen = (open: boolean) => { if (open) openPreviews?.add(previewKey); else openPreviews?.delete(previewKey); setPreviewOpenState(open); };
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<PreviewRuntimeStatus>(() => {
    if (card.status === "failed") return "failed";
    if (card.status === "running") return "running";
    if (card.status === "starting" || card.status === "building" || card.status === "provisioning") return "starting";
    if (card.status === "stopped") return "stopped";
    return "starting";
  });

  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const isCodeProject = card.kind === "code_project";
  const projectType = resolveChatProjectType(card);

  // URLs for navigation
  const projectIdVal = card.projectId ?? card.id;
  const codeWorkspaceUrl = card.companyId && projectIdVal
    ? `/settings/code/${encodeURIComponent(card.companyId)}/${encodeURIComponent(projectIdVal)}${card.sessionId ? `?session=${encodeURIComponent(card.sessionId)}` : ""}`
    : null;
  const codeChangesUrl = codeWorkspaceUrl
    ? `${codeWorkspaceUrl}${codeWorkspaceUrl.includes("?") ? "&" : "?"}tab=changes`
    : null;
  const terminalUrl = codeWorkspaceUrl
    ? `${codeWorkspaceUrl}${codeWorkspaceUrl.includes("?") ? "&" : "?"}tab=terminal`
    : null;

  // Title: technology/framework or project name
  const title = card.framework || card.name || (projectType === "mobile_app" ? "Expo" : projectType === "game" ? "Game Engine" : "Website");

  // Subtitle: Type · Live Preview
  const typeLabel = projectType === "website"
    ? (isUk ? "Вебсайт" : "Website")
    : projectType === "mobile_app"
      ? (isUk ? "Мобільний застосунок" : "Mobile app")
      : projectType === "game"
        ? (isUk ? "Гра" : "Game")
        : (isUk ? "Проєкт" : "Project");
  const subtitle = `${typeLabel} · Live Preview`;

  // Status text and color
  const statusLabels: Record<PreviewRuntimeStatus, string> = {
    running: isUk ? "Працює" : "Running",
    starting: isUk ? "Запуск..." : "Starting",
    stopped: isUk ? "Зупинено" : "Stopped",
    failed: isUk ? "Помилка" : "Failed",
    unavailable: isUk ? "Прев'ю недоступне" : "Preview unavailable",
  };

  const isStatic = card.framework === "HTML/CSS" && !isCodeProject;

  // Check Sandbox Runtime status
  useEffect(() => {
    let isMounted = true;
    const companyId = card.companyId;
    const projectId = card.projectId ?? card.id;

    if (!companyId || !projectId) {
      if (card.previewUrl) setRuntimeStatus("running");
      else setRuntimeStatus("unavailable");
      return;
    }

    if (card.status === "failed") {
      setRuntimeStatus("failed");
      return;
    }

    async function checkRuntime() {
      try {
        const token = getStoredAuthToken();
        const headers: Record<string, string> = {};
        if (token) headers.authorization = `Bearer ${token}`;

        if (isStatic) {
          const file = await readProjectFile({ companyId, projectId }, "index.html").catch(() => null);
          if (!isMounted) return;
          if (file) {
            setRuntimeStatus("running");
            if (isMounted && file?.content) {
              setPreviewHtml(file.content);
            }
          } else {
            setRuntimeStatus("unavailable");
          }
          return;
        }

        const endpoint = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/preview`;
        const res = await fetch(`${endpoint}/status`, { headers });
        if (!isMounted) return;
        if (!res.ok) {
          if (res.status === 404) {
            setRuntimeStatus("unavailable");
          } else {
            setRuntimeStatus("failed");
          }
          return;
        }
        const data = await res.json().catch(() => null) as { isRunning?: boolean; status?: string; previewUrl?: string } | null;
        if (!isMounted) return;
        if (data?.isRunning) {
          setRuntimeStatus("running");
          if (data.previewUrl) {
            setPreviewUrl((current) => current || data.previewUrl || "");
          }
        } else {
          if (data?.status === "failed") {
            setRuntimeStatus("failed");
          } else if (data?.status === "starting" || card.status === "starting" || card.status === "building" || card.status === "provisioning") {
            setRuntimeStatus("starting");
          } else {
            setRuntimeStatus("stopped");
          }
        }
      } catch {
        if (!isMounted) return;
        setRuntimeStatus(card.status === "failed" ? "failed" : "stopped");
      }
    }

    void checkRuntime();

    const onProjectUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === projectId) {
        void checkRuntime();
      }
    };
    window.addEventListener("npati-code-project-updated", onProjectUpdate);

    return () => {
      isMounted = false;
      window.removeEventListener("npati-code-project-updated", onProjectUpdate);
    };
  }, [card.companyId, card.projectId, card.id, card.status, card.framework, isStatic]);

  // Load project thumbnail screenshot if available
  useEffect(() => {
    let isMounted = true;
    const companyId = card.companyId;
    const projectId = card.projectId ?? card.id;
    if (!companyId || !projectId) return;

    async function loadThumbnail() {
      try {
        const token = getStoredAuthToken();
        const headers: Record<string, string> = {};
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/qa/thumbnail`, { headers });
        if (!isMounted || !res.ok) return;
        const data = await res.json().catch(() => null) as { thumbnail?: { dataUrl?: string } | null } | null;
        if (isMounted && data?.thumbnail?.dataUrl) {
          setThumbnailUrl(data.thumbnail.dataUrl);
        }
      } catch {
        // SVG placeholder fallback
      }
    }

    void loadThumbnail();
    return () => {
      isMounted = false;
    };
  }, [card.companyId, card.projectId, card.id]);

  // Close dropdown on click outside or Escape
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDropdownOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [dropdownOpen]);

  // Escape closes preview modal
  useEffect(() => {
    if (!previewOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewOpen]);

  async function loadStaticPreviewPage(filePath: string) {
    if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.html$/i.test(filePath)) {
      throw new Error("Invalid preview page.");
    }
    const file = await readProjectFile({ companyId: card.companyId, projectId: card.projectId ?? card.id }, filePath);
    if (!file.content) throw new Error(`${filePath} is unavailable.`);
    setPreviewHtml(file.content);
    setRuntimeStatus("running");
  }

  function handleStaticPreviewLoad(event: SyntheticEvent<HTMLIFrameElement>) {
    event.currentTarget.contentDocument?.addEventListener("click", (clickEvent) => {
      const target = clickEvent.target as Element | null;
      const link = typeof target?.closest === "function" ? target.closest("a[href]") : null;
      const href = link?.getAttribute("href");
      if (!href || href.startsWith("#") || /^[a-z]+:\/\//i.test(href)) return;
      const filePath = href.startsWith("/") ? `${href.slice(1).replace(/\/$/, "") || "index"}.html` : href;
      if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.html$/i.test(filePath)) return;
      clickEvent.preventDefault();
      void loadStaticPreviewPage(filePath).catch((error) => {
        setPreviewHtml("");
        setPreviewError(error instanceof Error ? error.message : "Preview page is unavailable.");
      });
    });
  }

  useEffect(() => { if (openPreviews?.has(previewKey)) void openPreview(); }, []);

  async function openPreview() {
    setPreviewOpen(true);
    setPreviewError("");
    if (!card.companyId) {
      setPreviewError("Project company is unavailable.");
      return;
    }

    const endpoint = `/api/companies/${encodeURIComponent(card.companyId)}/projects/${encodeURIComponent(card.projectId ?? card.id)}/preview`;

    if (isStatic) {
      if (!previewHtml) {
        setPreviewLoading(true);
        await loadStaticPreviewPage("index.html").catch((error) => {
          setPreviewError(error instanceof Error ? error.message : "Preview is unavailable.");
          setRuntimeStatus("failed");
        });
        setPreviewLoading(false);
      }
      return;
    }

    setPreviewLoading(true);
    try {
      const token = getStoredAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;

      const statusResponse = await fetch(`${endpoint}/status`, { headers });
      const status = await statusResponse.json().catch(() => null) as { isRunning?: boolean; previewUrl?: string } | null;
      if (statusResponse.ok && status?.isRunning) {
        if (status.previewUrl) {
          setPreviewUrl(status.previewUrl);
          setRuntimeStatus("running");
          return;
        }
        const tokenResponse = await fetch(`${endpoint}/token`, { headers });
        const freshToken = await tokenResponse.json().catch(() => null) as { token?: string } | null;
        if (tokenResponse.ok && freshToken?.token) {
          const freshUrl = `${endpoint}/proxy/?token=${encodeURIComponent(freshToken.token)}`;
          setPreviewUrl(freshUrl);
          setRuntimeStatus("running");
          return;
        }
      }

      const response = await fetch(`${endpoint}/start`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
      const payload = await response.json().catch(() => null) as { previewUrl?: string; error?: string | { message?: string } } | null;
      if (!response.ok || !payload?.previewUrl) {
        const message = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
        throw new Error(message || "Preview is unavailable.");
      }
      setPreviewUrl(payload.previewUrl);
      setIframeKey((prev) => prev + 1);
      setRuntimeStatus("running");
    } catch (error) {
      if (!previewUrl) {
        setPreviewError(error instanceof Error ? error.message : "Preview is unavailable.");
        setRuntimeStatus("failed");
      }
    } finally {
      setPreviewLoading(false);
    }
  }

  async function restartPreview() {
    setDropdownOpen(false);
    await openPreview();
  }

  function handleOpenInNewTab() {
    setDropdownOpen(false);
    if (previewUrl) {
      window.open(previewUrl, "_blank", "noopener,noreferrer");
    } else {
      void openPreview();
    }
  }

  if (!showPreviewTrigger && !previewOpen) return null;

  return (
    <>
      {showPreviewTrigger && (
        <div className={`chat-project-preview-card ${className}`.trim()} data-testid="chat-project-preview-card">
          <div className="chat-preview-card-left">
            {/* Project Thumbnail / SVG Mockup */}
            <div className="chat-preview-card-thumbnail" data-type={projectType}>
              {thumbnailUrl ? (
                <img
                  src={thumbnailUrl}
                  alt={title}
                  className="chat-preview-card-thumbnail-img"
                  onError={() => setThumbnailUrl(null)}
                />
              ) : projectType === "website" ? (
                <WebsiteSvgThumbnail />
              ) : projectType === "mobile_app" ? (
                <MobileSvgThumbnail />
              ) : projectType === "game" ? (
                <GameSvgThumbnail />
              ) : (
                <OtherSvgThumbnail />
              )}
            </div>

            {/* Center Info */}
            <div className="chat-preview-card-info">
              <h4 className="chat-preview-card-title" title={title}>{title}</h4>
              <span className="chat-preview-card-subtitle">{subtitle}</span>
              <div className={`chat-preview-card-status status-${runtimeStatus}`}>
                <span className="chat-preview-status-dot" aria-hidden="true" />
                <span>{statusLabels[runtimeStatus]}</span>
              </div>
            </div>
          </div>

          {/* Right Actions */}
          <div className="chat-preview-card-actions" ref={dropdownRef}>
            <button
              type="button"
              className="chat-preview-open-btn coding-preview-trigger"
              onClick={() => void openPreview()}
              disabled={runtimeStatus === "unavailable"}
              aria-label={isUk ? "Відкрити Live Preview" : "Open Live Preview"}
            >
              <ExternalLink size={15} aria-hidden="true" strokeWidth={2.3} />
              <span>{isUk ? "Open" : "Open"}</span>
              {card.framework && <span className="coding-preview-framework" style={{ display: "none" }}>{card.framework}</span>}
            </button>

            {showDropdown && (
              <button
                type="button"
                className="chat-preview-dropdown-btn"
                onClick={() => setDropdownOpen((open) => !open)}
                aria-label={isUk ? "Додаткові дії" : "Additional actions"}
                aria-haspopup="true"
                aria-expanded={dropdownOpen}
              >
                <ChevronDown size={16} aria-hidden="true" strokeWidth={2.5} />
              </button>
            )}

            {showDropdown && dropdownOpen && (
              <div className="chat-preview-dropdown-menu" role="menu">
                {/* Open in new tab */}
                <button
                  type="button"
                  className="chat-preview-dropdown-item"
                  role="menuitem"
                  onClick={handleOpenInNewTab}
                >
                  <ExtIcon size={14} aria-hidden="true" />
                  <span>{isUk ? "Відкрити в новій вкладці" : "Open in new tab"}</span>
                </button>

                {/* Edit in chat */}
                {onActivate && (
                  <button
                    type="button"
                    className="chat-preview-dropdown-item"
                    role="menuitem"
                    onClick={() => {
                      setDropdownOpen(false);
                      onActivate(card);
                    }}
                  >
                    <MessageSquare size={14} aria-hidden="true" />
                    <span>{isUk ? "Редагувати в чаті" : "Edit in chat"}</span>
                  </button>
                )}

                {/* Changes */}
                {isCodeProject && codeChangesUrl && (
                  <button
                    type="button"
                    className="chat-preview-dropdown-item"
                    role="menuitem"
                    onClick={() => {
                      setDropdownOpen(false);
                      navigate(codeChangesUrl);
                    }}
                  >
                    <GitCommit size={14} aria-hidden="true" />
                    <span>
                      {isUk ? "Зміни" : "Changes"}
                      {typeof card.changesCount === "number" ? ` (${card.changesCount})` : ""}
                    </span>
                  </button>
                )}

                {/* Code Workspace */}
                {isCodeProject && codeWorkspaceUrl && (
                  <button
                    type="button"
                    className="chat-preview-dropdown-item"
                    role="menuitem"
                    onClick={() => {
                      setDropdownOpen(false);
                      navigate(codeWorkspaceUrl);
                    }}
                  >
                    <Terminal size={14} aria-hidden="true" />
                    <span>{isUk ? "Робоча область коду" : "Code Workspace"}</span>
                  </button>
                )}

                {/* Restart preview */}
                <button
                  type="button"
                  className="chat-preview-dropdown-item"
                  role="menuitem"
                  onClick={() => void restartPreview()}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  <span>{isUk ? "Перезапустити preview" : "Restart preview"}</span>
                </button>

                {/* View Run */}
                {card.runId && (
                  <Link
                    to={`/activity?runId=${card.runId}`}
                    className="chat-preview-dropdown-item"
                    role="menuitem"
                    onClick={() => setDropdownOpen(false)}
                  >
                    <Eye size={14} aria-hidden="true" />
                    <span>{isUk ? "Переглянути запуск" : "View Run"}</span>
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Live Preview Modal / Drawer */}
      {previewOpen && createPortal(
        <div className={`project-chat-preview-layer ${isFullscreen ? "is-fullscreen" : ""}`}>
          <aside
            className={`project-chat-preview-drawer ${isFullscreen ? "is-fullscreen" : ""}`}
            role="complementary"
            aria-label={`Preview of ${card.name}`}
          >
            {!isFullscreen && <LivePreviewSplitResizer />}
            <LivePreviewHeader
              projectName={card.name}
              runtimeStatus={runtimeStatus}
              statusLabel={statusLabels[runtimeStatus]}
              previewUrl={previewUrl}
              isUk={isUk}
              codeWorkspaceUrl={codeWorkspaceUrl}
              terminalUrl={terminalUrl}
              deviceMode={deviceMode}
              setDeviceMode={setDeviceMode}
              isFullscreen={isFullscreen}
              setIsFullscreen={setIsFullscreen}
              onRefresh={() => {
                // A plain site is served from the sandbox's copy of its files: bring that copy up to date, then reload.
                if (!isStatic && previewUrl && !previewError && /^(?:HTML\/CSS|static)$/.test(card.framework ?? "")) {
                  const token = getStoredAuthToken();
                  void fetch(`/api/companies/${encodeURIComponent(card.companyId)}/projects/${encodeURIComponent(card.projectId ?? card.id)}/preview/apply-file-changes`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: "{}" })
                    .catch(() => undefined).finally(() => setIframeKey((k) => k + 1));
                  return;
                }
                setIframeKey((k) => k + 1);
                if (isStatic) {
                  void loadStaticPreviewPage("index.html");
                } else if (!previewUrl || previewError) {
                  void openPreview();
                }
              }}
              onClose={() => setPreviewOpen(false)}
            />
            <div className="project-chat-preview-body" data-device-mode={deviceMode}>
              <div className="project-chat-preview-viewport" data-device-mode={deviceMode}>
                {previewHtml ? (
                  <iframe
                    key={iframeKey}
                    title={`${card.name} preview`}
                    srcDoc={previewHtml}
                    sandbox="allow-same-origin"
                    onLoad={handleStaticPreviewLoad}
                    className="project-chat-preview-frame"
                  />
                ) : previewUrl ? (
                  <iframe
                    key={iframeKey}
                    title={`${card.name} preview`}
                    src={previewUrl}
                    className="project-chat-preview-frame"
                  />
                ) : previewError ? (
                  <div className="project-chat-preview-empty" role="status">
                    {previewError}
                  </div>
                ) : (
                  <div className="project-chat-preview-frame" />
                )}
              </div>
            </div>
          </aside>
        </div>,
        document.body
      )}
    </>
  );
}
