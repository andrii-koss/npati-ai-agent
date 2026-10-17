import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  MessageSquare,
  ExternalLink,
  Code2,
  Copy,
  Pencil,
  Trash2,
} from "lucide-react";
import { apiFetch, type WebsiteProject } from "./website-builder-cache";
import type { websiteBuilderCopy } from "./website-builder-constants";

export interface WebsiteProjectCardProps {
  site: WebsiteProject;
  companyId: string;
  language: string;
  t: (typeof websiteBuilderCopy)["en"];
  handleDuplicate: (site: WebsiteProject) => void | Promise<void>;
  handleRename: (site: WebsiteProject) => void | Promise<void>;
  handleDelete: (site: WebsiteProject) => void | Promise<void>;
}

export function WebsiteCardPreview({
  site,
  companyId,
  language,
  editorUrl,
  onLiveUrlChange,
  onStaticHtmlChange,
}: {
  site: WebsiteProject;
  companyId: string;
  language: string;
  editorUrl: string;
  onLiveUrlChange?: (url: string) => void;
  onStaticHtmlChange?: (html: string) => void;
}) {
  const [liveUrl, setLiveUrl] = useState<string>("");
  const [staticHtml, setStaticHtml] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [iframeKey, setIframeKey] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: 600,
    height: 375,
  });

  // Track container width and height for responsive desktop viewport scaling
  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setDimensions({ width: rect.width, height: rect.height });
        }
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const fetchPreviewState = async () => {
    if (!companyId || !site.id) return;
    setLoading(true);
    try {
      // 1. Check sandbox preview status
      let runningUrl = "";
      try {
        const status = await apiFetch<{
          isRunning?: boolean;
          previewUrl?: string | null;
        }>(`/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/preview/status`);

        if (status?.isRunning) {
          const tokenRes = await apiFetch<{ token?: string }>(
            `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/preview/token`
          );
          if (tokenRes?.token) {
            runningUrl = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/preview/proxy/?token=${encodeURIComponent(tokenRes.token)}`;
          } else if (status.previewUrl) {
            runningUrl = status.previewUrl;
          }
        }
      } catch {}

      if (runningUrl) {
        setLiveUrl(runningUrl);
        setStaticHtml("");
        onLiveUrlChange?.(runningUrl);
        setLoading(false);
        return;
      }

      // 2. Check for index.html in project files (instant visual view for static / web projects)
      let htmlContent = "";
      try {
        const fileRes = await apiFetch<{ content?: string }>(
          `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/files/read?path=index.html`
        );
        if (fileRes?.content) {
          htmlContent = fileRes.content;

          // Attempt to inline style.css or styles.css if present for pixel-perfect static render
          for (const cssPath of ["style.css", "styles.css", "src/index.css", "src/App.css"]) {
            try {
              const cssRes = await apiFetch<{ content?: string }>(
                `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/files/read?path=${encodeURIComponent(cssPath)}`
              );
              if (cssRes?.content && !htmlContent.includes(cssRes.content)) {
                const styleTag = `<style>\n${cssRes.content}\n</style>`;
                htmlContent = htmlContent.includes("</head>")
                  ? htmlContent.replace("</head>", `${styleTag}</head>`)
                  : `${styleTag}${htmlContent}`;
                break;
              }
            } catch {}
          }
        }
      } catch {}

      if (htmlContent) {
        setStaticHtml(htmlContent);
        setLiveUrl("");
        onStaticHtmlChange?.(htmlContent);
        setLoading(false);

        // If it's a dynamic project (e.g. Vite, Next.js), start sandbox preview dev server in background
        if (site.framework !== "HTML/CSS") {
          void apiFetch<{ previewUrl?: string }>(
            `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/preview/start`,
            { method: "POST", body: "{}" }
          ).then((startRes) => {
            if (startRes?.previewUrl) {
              setLiveUrl(startRes.previewUrl);
              setStaticHtml("");
              onLiveUrlChange?.(startRes.previewUrl);
            }
          }).catch(() => {});
        }
        return;
      }

      // 3. If no HTML file yet and dynamic framework, attempt /preview/start
      if (site.framework !== "HTML/CSS") {
        try {
          const startRes = await apiFetch<{ previewUrl?: string }>(
            `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/preview/start`,
            { method: "POST", body: "{}" }
          );
          if (startRes?.previewUrl) {
            setLiveUrl(startRes.previewUrl);
            setStaticHtml("");
            onLiveUrlChange?.(startRes.previewUrl);
            setLoading(false);
            return;
          }
        } catch {}
      }

      // 4. Fallback to site previewUrl or deploymentUrl (skip stale proxy URLs)
      if (site.deploymentUrl && !site.deploymentUrl.includes("/preview/proxy")) {
        setLiveUrl(site.deploymentUrl);
        setStaticHtml("");
        onLiveUrlChange?.(site.deploymentUrl);
        setLoading(false);
        return;
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchPreviewState();

    // Auto-update preview when project is modified by Coding Agent or changes in workspace
    const onProjectUpdate = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === site.id) {
        setIframeKey((k) => k + 1);
        void fetchPreviewState();
      }
    };

    const onCompanyChange = () => {
      setIframeKey((k) => k + 1);
      void fetchPreviewState();
    };

    const onFocus = () => {
      setIframeKey((k) => k + 1);
      void fetchPreviewState();
    };

    window.addEventListener("npati-code-project-updated", onProjectUpdate);
    window.addEventListener("npati:company-changed", onCompanyChange);
    window.addEventListener("focus", onFocus);

    return () => {
      window.removeEventListener("npati-code-project-updated", onProjectUpdate);
      window.removeEventListener("npati:company-changed", onCompanyChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [companyId, site.id, site.updatedAt, site.revision]);

  const VIRTUAL_WIDTH = 1200;
  const scale = Math.max(0.15, Math.min(1, dimensions.width / VIRTUAL_WIDTH));
  const virtualHeight = dimensions.height / scale;

  return (
    <div
      ref={containerRef}
      className="website-preview-viewport"
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "16 / 10",
        borderRadius: "14px",
        overflow: "hidden",
        background: "#f8fafc",
        border: "1px solid #eaecf0",
        boxSizing: "border-box",
      }}
    >
      <Link
        to={editorUrl}
        tabIndex={-1}
        aria-label={`Open ${site.name} in chat`}
        style={{
          display: "block",
          position: "absolute",
          inset: 0,
          zIndex: 2,
          cursor: "pointer",
        }}
      />

      {liveUrl ? (
        <iframe
          key={`live-${iframeKey}`}
          src={liveUrl}
          title={`${site.name} Live Preview`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: `${VIRTUAL_WIDTH}px`,
            height: `${Math.round(virtualHeight)}px`,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            border: "none",
            pointerEvents: "none",
            background: "#ffffff",
          }}
        />
      ) : staticHtml ? (
        <iframe
          key={`static-${iframeKey}`}
          srcDoc={staticHtml}
          title={`${site.name} Live Preview`}
          sandbox="allow-scripts allow-same-origin"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: `${VIRTUAL_WIDTH}px`,
            height: `${Math.round(virtualHeight)}px`,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            border: "none",
            pointerEvents: "none",
            background: "#ffffff",
          }}
        />
      ) : loading ? (
        <div
          className="website-preview-skeleton"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
            background: "linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)",
            color: "#64748b",
            fontSize: "13px",
            fontWeight: 500,
          }}
        >
          <div
            className="website-preview-spinner"
            style={{
              width: "28px",
              height: "28px",
              borderRadius: "50%",
              border: "3px solid #e2e8f0",
              borderTopColor: "var(--npati-red, #dc2626)",
              animation: "website-preview-spin 0.8s linear infinite",
            }}
          />
          <span>{language === "uk" ? "Завантаження Live Preview..." : "Loading Live Preview..."}</span>
        </div>
      ) : (
        <div
          className="website-preview-empty"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            background: "#f8fafc",
            color: "#64748b",
            fontSize: "13px",
          }}
        >
          <span style={{ fontSize: "28px" }}>🌐</span>
          <span>{language === "uk" ? "Live Preview готовий до запуску" : "Live Preview ready to start"}</span>
        </div>
      )}
    </div>
  );
}

export function WebsiteProjectCard({
  site,
  companyId,
  language,
  t,
  handleDuplicate,
  handleRename,
  handleDelete,
}: WebsiteProjectCardProps) {
  const [activePreviewUrl, setActivePreviewUrl] = useState<string>("");
  const [staticHtmlContent, setStaticHtmlContent] = useState<string>("");
  const [opening, setOpening] = useState<boolean>(false);
  const editorUrl = `/chat?company=${encodeURIComponent(companyId)}&project=${encodeURIComponent(site.id)}`;
  const codeUrl = `/settings/code/${encodeURIComponent(companyId)}/${encodeURIComponent(site.id)}`;

  const handleOpenPreview = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const endpoint = `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/preview`;

      // 1. Check if sandbox dev server is actively running and request a fresh token
      try {
        const statusRes = await apiFetch<{ isRunning?: boolean }>(`${endpoint}/status`).catch(() => null);
        if (statusRes?.isRunning) {
          const freshTokenRes = await apiFetch<{ token: string }>(`${endpoint}/token`).catch(() => null);
          if (freshTokenRes?.token) {
            const freshUrl = `/api${endpoint}/proxy/?token=${encodeURIComponent(freshTokenRes.token)}`;
            window.open(freshUrl, "_blank", "noopener,noreferrer");
            return;
          }
        }
      } catch {}

      // 2. If it's a dynamic project (e.g. Vite, Next.js), attempt to start preview dev server
      if (site.framework !== "HTML/CSS") {
        try {
          const startRes = await apiFetch<{ previewUrl?: string; token?: string }>(`${endpoint}/start`, {
            method: "POST",
            body: "{}",
          }).catch(() => null);
          if (startRes?.token) {
            const freshUrl = `/api${endpoint}/proxy/?token=${encodeURIComponent(startRes.token)}`;
            window.open(freshUrl, "_blank", "noopener,noreferrer");
            return;
          }
        } catch {}
      }

      // 3. For static HTML or projects with static preview available, open in a new tab via Blob
      const currentHtml = staticHtmlContent;
      if (currentHtml) {
        const blob = new Blob([currentHtml], { type: "text/html;charset=utf-8" });
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, "_blank");
        return;
      }

      // 4. Try reading index.html directly from project files
      try {
        const fileRes = await apiFetch<{ content?: string }>(
          `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/files/read?path=index.html`
        );
        if (fileRes?.content) {
          let html = fileRes.content;
          for (const cssPath of ["style.css", "styles.css", "src/index.css", "src/App.css"]) {
            try {
              const cssRes = await apiFetch<{ content?: string }>(
                `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/files/read?path=${encodeURIComponent(cssPath)}`
              );
              if (cssRes?.content && !html.includes(cssRes.content)) {
                html = html.includes("</head>")
                  ? html.replace("</head>", `<style>\n${cssRes.content}\n</style></head>`)
                  : `<style>\n${cssRes.content}\n</style>${html}`;
                break;
              }
            } catch {}
          }
          const blob = new Blob([html], { type: "text/html;charset=utf-8" });
          const blobUrl = URL.createObjectURL(blob);
          window.open(blobUrl, "_blank");
          return;
        }
      } catch {}

      // 5. If genuine external deploymentUrl (not an internal proxy url)
      if (site.deploymentUrl && !site.deploymentUrl.includes("/preview/proxy")) {
        window.open(site.deploymentUrl, "_blank", "noopener,noreferrer");
        return;
      }

      // 6. Otherwise navigate to chat editor
      window.open(editorUrl, "_blank", "noopener,noreferrer");
    } finally {
      setOpening(false);
    }
  };

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
      <WebsiteCardPreview
        site={site}
        companyId={companyId}
        language={language}
        editorUrl={editorUrl}
        onLiveUrlChange={setActivePreviewUrl}
        onStaticHtmlChange={setStaticHtmlContent}
      />

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

        {/* Open Live Preview in new tab */}
        <button
          type="button"
          className="website-icon-btn"
          onClick={handleOpenPreview}
          title={language === "uk" ? "Відкрити Preview" : "Open Live Preview"}
          aria-label={language === "uk" ? "Відкрити Preview" : "Open Live Preview"}
        >
          <ExternalLink size={16} />
        </button>

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
}
