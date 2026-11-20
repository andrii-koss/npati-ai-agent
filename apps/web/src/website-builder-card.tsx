import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { MessageSquare, ExternalLink, Settings, Copy, Pencil, Trash2 } from "lucide-react";
import { openableProjectPreview } from "./catalog-project-preview";
import { CatalogProjectThumbnail } from "./catalog-project-thumbnail";
import type { WebsiteProject } from "./website-builder-cache";
import { PROJECT_KIND_LABELS, type websiteBuilderCopy } from "./website-builder-constants";
import { projectKindOf } from "@npati/shared";
import { useProjectProduction, type ProductionStatus } from "./code-workspace/project-production";

export interface WebsiteProjectCardProps {
  site: WebsiteProject;
  companyId: string;
  language: string;
  t: (typeof websiteBuilderCopy)["en"];
  drawerProductionStatus?: ProductionStatus | null;
  handleDuplicate: (site: WebsiteProject) => void | Promise<void>;
  handleRename: (site: WebsiteProject) => void | Promise<void>;
  handleDelete: (site: WebsiteProject) => void | Promise<void>;
}

export const WebsiteProjectCard = React.memo(function WebsiteProjectCard({
  site,
  companyId,
  language,
  t,
  drawerProductionStatus,
  handleDuplicate,
  handleRename,
  handleDelete,
}: WebsiteProjectCardProps) {
  const editorUrl = `/chat?company=${encodeURIComponent(companyId)}&project=${encodeURIComponent(site.id)}`;
  const codeUrl = `/settings/code/${encodeURIComponent(companyId)}/${encodeURIComponent(site.id)}?view=all`;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const productionEligible = site.status !== "archived" && projectKindOf(site) !== "mobile_app";
  const checkProduction = productionEligible && drawerProductionStatus === undefined;
  const { status: cardProductionStatus } = useProjectProduction(checkProduction ? companyId : "", site.id);
  const currentProductionStatus = drawerProductionStatus === undefined ? cardProductionStatus : drawerProductionStatus;
  const lastConfirmedProduction = useRef<{ scope: string; status: ProductionStatus } | null>(null);
  useEffect(() => {
    if (!productionEligible) {
      lastConfirmedProduction.current = null;
    } else if (currentProductionStatus) {
      lastConfirmedProduction.current = { scope: codeUrl, status: currentProductionStatus };
    }
  }, [productionEligible, codeUrl, currentProductionStatus]);
  const productionStatus = productionEligible ? currentProductionStatus ??
    (lastConfirmedProduction.current?.scope === codeUrl ? lastConfirmedProduction.current.status : null) : null;
  const release = productionStatus?.enabled ? productionStatus.release : null;
  const productionHealthy = release?.runtime === "running" && release.certificate !== "pending";
  const isUk = language === "uk";
  const productionLabel = productionHealthy
    ? (isUk ? "Продакшен працює" : "Production running")
    : (isUk ? "Продакшен недоступний або ще не готовий" : "Production unavailable or not ready");

  // Close popup menu when clicking outside, scrolling, or pressing Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".sidebar-action-menu") || target?.closest(".website-more-btn")) {
        return;
      }
      setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onScroll = () => {
      setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menuOpen]);

  const handleToggleMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const menuWidth = 175;
    const menuHeight = 135;
    let left = rect.right - menuWidth;
    if (left < 10) left = 10;
    if (left + menuWidth > window.innerWidth - 10) left = window.innerWidth - menuWidth - 10;

    let top = rect.bottom + 6;
    if (top + menuHeight > window.innerHeight - 10 && rect.top > menuHeight + 10) {
      top = rect.top - menuHeight - 6;
    }

    setMenuPos({ top, left });
    setMenuOpen(true);
  };

  // The window opens on the click (so no pop-up blocker stops it) and gets a scoped preview token; the user's own
  // access token is sent only in a request header, never in a URL that browser history or server logs keep.
  const opening = useRef(false);
  async function handleOpenPreview() {
    if (opening.current) return;
    opening.current = true;
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const url = await openableProjectPreview(companyId, site.id);
      if (popup) popup.location.replace(url);
    } catch (cause) {
      if (popup) popup.document.body.textContent = cause instanceof Error ? cause.message : "Preview unavailable";
    } finally { opening.current = false; }
  }

  return (
    <article
      className="website-project-card"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#ffffff",
        borderRadius: "18px",
        overflow: "hidden",
        border: "1px solid #eaecf0",
        boxShadow: "0 2px 10px rgba(0,0,0,0.03)",
        transition: "all 0.2s ease",
        boxSizing: "border-box",
        position: "relative",
      }}
    >
      {/* 1. Main visual preview of the project - edge-to-edge for bigger photo */}
      <CatalogProjectThumbnail
        companyId={companyId}
        projectId={site.id}
        name={site.name}
        language={language}
        kind={site.kind ?? projectKindOf(site)}
        type={site.type}
        framework={site.framework}
        projectStatus={site.status}
        hasThumbnail={site.hasThumbnail}
        onPreview={() => void handleOpenPreview()}
      />

      {/* 2. Card Body Content with padding */}
      <div
        style={{
          padding: "14px 16px 16px",
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minWidth: 0,
        }}
      >
        {/* Project Title */}
        <div style={{ marginBottom: "14px" }}>
          <div className="website-card-title-row">
            <h3
              style={{
                fontSize: "16.5px",
                fontWeight: 700,
                margin: 0,
                color: "#111111",
                lineHeight: 1.3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={site.name}
            >
              {site.name}
            </h3>
            {release?.settings.domain && (
              <span className="website-card-production-dot" data-healthy={productionHealthy}
                role="img" aria-label={productionLabel} title={productionLabel} />
            )}
          </div>
          <small className="website-card-kind" style={{ display: "block", marginTop: "4px", color: "#667085", fontSize: "12.5px" }}>
            {PROJECT_KIND_LABELS[projectKindOf(site)][language === "uk" ? "uk" : "en"]}
            {site.framework ? ` · ${site.framework}` : ""}{site.deploymentUrl && !site.deploymentUrl.includes(".preview.npati.com") ? ` · ${site.deploymentUrl.replace(/^https?:\/\//, "")}` : ""}
          </small>
        </div>

        {/* 3. Action Buttons Row: Edit in chat, Preview, Code on left, 3-dots on right */}
        <div
          className="website-card-actions"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginTop: "auto",
          }}
        >
          {/* Primary Edit in chat button */}
          <Link
            to={editorUrl}
            className="website-action-btn-primary"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
              background: "#dc2626",
              color: "#ffffff",
              padding: "8px 14px",
              borderRadius: "10px",
              fontSize: "13px",
              fontWeight: 600,
              textDecoration: "none",
              border: "none",
              cursor: "pointer",
              boxShadow: "0 1px 2px rgba(220, 38, 38, 0.2)",
              transition: "all 0.15s ease",
              whiteSpace: "nowrap",
            }}
            title={language === "uk" ? "Редагувати в чаті" : "Edit in chat"}
          >
            <MessageSquare size={16} />
            <span>{t.openBuilder}</span>
          </Link>

          {/* Preview button */}
          <button
            type="button"
            onClick={() => void handleOpenPreview()}
            className="website-icon-btn"
            title={language === "uk" ? "Відкрити Preview" : "Open Live Preview"}
            aria-label={language === "uk" ? "Відкрити Preview" : "Open Live Preview"}
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}
          >
            <ExternalLink size={16} />
          </button>

          {/* Project workspace settings */}
          <Link
            to={codeUrl}
            className="website-icon-btn"
            title={language === "uk" ? "Налаштування проєкту" : "Project settings"}
            aria-label={language === "uk" ? "Налаштування проєкту" : "Project settings"}
          >
            <Settings size={16} aria-hidden="true" />
          </Link>

          {/* Three dots menu button on the right */}
          <button
            ref={moreButtonRef}
            type="button"
            className={`website-icon-btn website-more-btn ${menuOpen ? "active" : ""}`}
            onClick={handleToggleMenu}
            title={language === "uk" ? "Більше дій" : "More options"}
            aria-label={language === "uk" ? "Більше дій" : "More options"}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            style={{ marginLeft: "auto" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="2.2" />
              <circle cx="12" cy="12" r="2.2" />
              <circle cx="19" cy="12" r="2.2" />
            </svg>
          </button>
        </div>
      </div>

      {/* 4. Three dots Popup menu with Rename, Duplicate, Delete */}
      {menuOpen && createPortal(
        <div
          className="sidebar-action-menu"
          style={{
            position: "fixed",
            top: menuPos.top,
            left: menuPos.left,
            zIndex: 999999,
          }}
        >
          <button
            type="button"
            className="sidebar-action-item"
            onClick={() => {
              setMenuOpen(false);
              void handleRename(site);
            }}
          >
            <Pencil size={15} />
            <span>{t.rename}</span>
          </button>

          <button
            type="button"
            className="sidebar-action-item"
            onClick={() => {
              setMenuOpen(false);
              void handleDuplicate(site);
            }}
          >
            <Copy size={15} />
            <span>{t.duplicate}</span>
          </button>

          <div className="sidebar-action-divider" />

          <button
            type="button"
            className="sidebar-action-item danger"
            onClick={() => {
              setMenuOpen(false);
              void handleDelete(site);
            }}
          >
            <Trash2 size={15} />
            <span>{t.delete}</span>
          </button>
        </div>,
        document.body
      )}
    </article>
  );
});
