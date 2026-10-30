import React, { useState } from "react";
import { Link } from "react-router-dom";
import { MessageSquare, ExternalLink, Code2, Copy, Pencil, Trash2 } from "lucide-react";
import { openableProjectPreview } from "./catalog-project-preview";
import { CatalogProjectThumbnail } from "./catalog-project-thumbnail";
import type { WebsiteProject } from "./website-builder-cache";
import { PROJECT_KIND_LABELS, type websiteBuilderCopy } from "./website-builder-constants";
import { projectKindOf } from "@npati/shared";
export interface WebsiteProjectCardProps {
  site: WebsiteProject;
  companyId: string;
  language: string;
  t: (typeof websiteBuilderCopy)["en"];
  handleDuplicate: (site: WebsiteProject) => void | Promise<void>;
  handleRename: (site: WebsiteProject) => void | Promise<void>;
  handleDelete: (site: WebsiteProject) => void | Promise<void>;
}


export const WebsiteProjectCard = React.memo(function WebsiteProjectCard({
  site,
  companyId,
  language,
  t,
  handleDuplicate,
  handleRename,
  handleDelete,
}: WebsiteProjectCardProps) {
  const editorUrl = `/chat?company=${encodeURIComponent(companyId)}&project=${encodeURIComponent(site.id)}`;
  const codeUrl = `/settings/code/${encodeURIComponent(companyId)}/${encodeURIComponent(site.id)}`;
  const [opening, setOpening] = useState(false);
  const [previewError, setPreviewError] = useState("");
  async function handleOpenPreview() {
    if (opening) return;
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setOpening(true); setPreviewError("");
    try {
      const url = await openableProjectPreview(companyId, site.id);
      if (popup) popup.location.replace(url);
      else setPreviewError(language === "uk" ? "Дозвольте спливаючі вікна для відкриття Preview" : "Allow pop-ups to open Preview");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Preview unavailable";
      setPreviewError(message);
      if (popup) popup.document.body.textContent = message;
    } finally { setOpening(false); }
  }

  return (
    <article
      className="website-project-card"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#ffffff",
        borderRadius: "18px",
        padding: "16px",
        border: "1px solid #eaecf0",
        boxShadow: "0 2px 10px rgba(0,0,0,0.03)",
        transition: "all 0.2s ease",
        boxSizing: "border-box",
      }}
    >
      {/* 1. Main visual preview of the project */}
      <CatalogProjectThumbnail companyId={companyId} projectId={site.id} name={site.name} language={language} kind={site.kind ?? projectKindOf(site)} type={site.type} framework={site.framework} projectStatus={site.status} hasThumbnail={site.hasThumbnail} onPreview={() => void handleOpenPreview()} />
      {previewError && <p role="alert" className="project-error">{previewError}</p>}

      {/* 2. Project Title */}
      <div style={{ marginTop: "14px", marginBottom: "12px" }}>
        <h3
          style={{
            fontSize: "17px",
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
        <small className="website-card-kind" style={{ display: "block", marginTop: "4px", color: "#667085", fontSize: "12.5px" }}>
          {PROJECT_KIND_LABELS[projectKindOf(site)][language === "uk" ? "uk" : "en"]}
          {site.framework ? ` · ${site.framework}` : ""}{site.deploymentUrl && !site.deploymentUrl.includes(".preview.npati.com") ? ` · ${site.deploymentUrl.replace(/^https?:\/\//, "")}` : ""}
        </small>
      </div>

      {/* 3. Action Buttons Row */}
      <div
        className="website-card-actions"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
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
            padding: "8px 16px",
            borderRadius: "10px",
            fontSize: "13.5px",
            fontWeight: 600,
            textDecoration: "none",
            border: "none",
            cursor: "pointer",
            boxShadow: "0 1px 2px rgba(220, 38, 38, 0.2)",
            transition: "all 0.15s ease",
          }}
          title={language === "uk" ? "Редагувати в чаті" : "Edit in chat"}
        >
          <MessageSquare size={16} />
          <span>{t.openBuilder}</span>
        </Link>

        <button type="button" className="website-icon-btn" disabled={opening} onClick={() => void handleOpenPreview()} title={language === "uk" ? "Відкрити Preview" : "Open Live Preview"} aria-label={language === "uk" ? "Відкрити Preview" : "Open Live Preview"}><ExternalLink size={16} /></button>
        {/* Code workspace */}
        <Link
          to={codeUrl}
          className="website-icon-btn"
          title={language === "uk" ? "Код" : "Code"}
          aria-label={language === "uk" ? "Код" : "Code"}
        >
          <Code2 size={16} />
        </Link>

        {/* Duplicate */}
        <button
          type="button"
          className="website-icon-btn"
          onClick={() => void handleDuplicate(site)}
          title={t.duplicate}
          aria-label={t.duplicate}
        >
          <Copy size={16} />
        </button>

        {/* Rename */}
        <button
          type="button"
          className="website-icon-btn"
          onClick={() => void handleRename(site)}
          title={t.rename}
          aria-label={t.rename}
        >
          <Pencil size={16} />
        </button>

        {/* Delete */}
        <button
          type="button"
          className="website-icon-btn website-delete-btn"
          onClick={() => void handleDelete(site)}
          title={t.delete}
          aria-label={t.delete}
        >
          <Trash2 size={16} color="#dc2626" />
        </button>
      </div>
    </article>
  );
});
