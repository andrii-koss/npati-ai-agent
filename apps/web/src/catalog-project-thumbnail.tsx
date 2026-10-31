import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getStoredAuthToken, getStoredAuthUser } from "./AuthContext";
import { apiFetch } from "./website-builder-cache";
import { openableProjectPreview, projectPreviewRoot } from "./catalog-project-preview";
import { ProjectPreviewPlaceholder, type PreviewPlaceholderStatus } from "./ProjectPreviewPlaceholder";

interface Thumbnail { dataUrl: string; capturedAt: string }
const cache = new Map<string, { thumbnail: Thumbnail | null; time: number }>();
let identity = "";

function storageKey(companyId: string, projectId: string) {
  return `npati_thumb_${companyId}_${projectId}`;
}

export function getStoredThumbnail(companyId: string, projectId: string): Thumbnail | null {
  try {
    const raw = sessionStorage.getItem(storageKey(companyId, projectId)) ||
                localStorage.getItem(storageKey(companyId, projectId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.dataUrl && typeof parsed.dataUrl === "string") return parsed;
    }
  } catch {}
  return null;
}

export function setStoredThumbnail(companyId: string, projectId: string, value: Thumbnail | null) {
  try {
    const key = storageKey(companyId, projectId);
    if (value?.dataUrl) {
      sessionStorage.setItem(key, JSON.stringify(value));
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    } else {
      sessionStorage.removeItem(key);
      try { localStorage.removeItem(key); } catch {}
    }
  } catch {}
}

export function prefetchProjectThumbnail(companyId: string, projectId: string) {
  const stored = getStoredThumbnail(companyId, projectId);
  if (stored) return;
  const root = projectPreviewRoot(companyId, projectId);
  void apiFetch<{ thumbnail: Thumbnail | null }>(root + "/qa/thumbnail").then(result => {
    if (result?.thumbnail) {
      setStoredThumbnail(companyId, projectId, result.thumbnail);
    }
  }).catch(() => {});
}

export interface CatalogProjectThumbnailProps {
  companyId: string;
  projectId: string;
  name: string;
  language: string;
  kind?: string | null;
  type?: string | null;
  framework?: string | null;
  projectStatus?: string | null;
  hasThumbnail?: boolean;
  onPreview(): void;
}

export function CatalogProjectThumbnail({
  companyId,
  projectId,
  name,
  language,
  kind,
  type,
  framework,
  projectStatus,
  hasThumbnail,
  onPreview,
}: CatalogProjectThumbnailProps) {
  const authIdentity = JSON.stringify([getStoredAuthToken(), getStoredAuthUser()?.id]);
  if (identity !== authIdentity) { cache.clear(); identity = authIdentity; }
  const key = JSON.stringify([authIdentity, companyId, projectId]);
  const root = projectPreviewRoot(companyId, projectId);
  const uk = language === "uk";
  const refreshLabel = uk ? "Оновити знімок" : "Refresh screenshot";
  const container = useRef<HTMLDivElement>(null);

  // Synchronously initialize from memory cache or persistent storage to avoid any placeholder flash on frame 0
  const [thumbnail, setThumbnail] = useState<Thumbnail | null>(() => {
    const fromMem = cache.get(key)?.thumbnail;
    if (fromMem !== undefined) return fromMem;
    const stored = getStoredThumbnail(companyId, projectId);
    if (stored) {
      cache.set(key, { thumbnail: stored, time: Date.now() });
      return stored;
    }
    return null;
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function remember(value: Thumbnail | null) {
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { thumbnail: value, time: Date.now() });
    setStoredThumbnail(companyId, projectId, value);
    setThumbnail(value);
  }

  useEffect(() => {
    const controller = new AbortController();
    let started = false;
    const load = () => {
      if (started) return;
      started = true;
      const previous = cache.get(key);
      if (previous?.thumbnail && Date.now() - previous.time < 300_000) return;
      if (hasThumbnail === false && !previous?.thumbnail) return;
      void apiFetch<{ thumbnail: Thumbnail | null }>(root + "/qa/thumbnail", { signal: controller.signal }).then(result => {
        if (!controller.signal.aborted) remember(result.thumbnail);
      }).catch(() => { });
    };

    // If project has thumbnail or is already cached, load immediately without waiting for IntersectionObserver
    if (hasThumbnail || thumbnail) {
      load();
    } else if (!globalThis.IntersectionObserver) {
      load();
    } else {
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          load();
          observer?.disconnect();
        }
      }, { rootMargin: "250px" });
      if (container.current) observer.observe(container.current);
      return () => { controller.abort(); observer.disconnect(); };
    }
    return () => { controller.abort(); };
  }, [key, root, hasThumbnail, thumbnail]);

  async function capture() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await openableProjectPreview(companyId, projectId);
      const result = await apiFetch<{ thumbnail: Thumbnail }>(root + "/qa/thumbnail", { method: "POST", body: "{}" });
      remember(result.thumbnail);
    } catch (cause) { setError(cause instanceof Error ? cause.message : uk ? "Не вдалося створити знімок" : "Could not capture screenshot"); }
    finally { setBusy(false); }
  }

  const placeholderStatus: PreviewPlaceholderStatus = busy
    ? "loading"
    : error
      ? "error"
      : projectStatus === "building" || projectStatus === "provisioning"
        ? "coming_soon"
        : "empty";
  const previewHref = "/settings/projects/" + encodeURIComponent(companyId) + "/" + encodeURIComponent(projectId);

  const isImageReady = Boolean(thumbnail && !busy);
  const isImagePending = Boolean(hasThumbnail && !thumbnail && !error);

  return <div ref={container} style={{ width: "100%" }}>
    <div className="website-preview-viewport" style={{ position: "relative", width: "100%", aspectRatio: "16 / 10", overflow: "hidden", background: "#f8fafc" }}>
      <a href={previewHref} aria-label={`Preview ${name}`} onClick={event => { event.preventDefault(); onPreview(); }} style={{ position: "absolute", inset: 0, display: "block", cursor: "pointer", textDecoration: "none" }}>
        {isImageReady ? (
          <img
            src={thumbnail!.dataUrl}
            alt={uk ? `Вигляд проєкту ${name}` : `${name} project screenshot`}
            loading="eager"
            onError={() => remember(null)}
            style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }}
          />
        ) : isImagePending ? (
          <div
            className="website-thumbnail-skeleton"
            style={{
              width: "100%",
              height: "100%",
              background: "#f1f5f9",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                border: "2.5px solid #e2e8f0",
                borderTopColor: "#dc2626",
                animation: "website-preview-spin 0.8s linear infinite"
              }}
            />
          </div>
        ) : (
          <ProjectPreviewPlaceholder
            kind={kind}
            type={type}
            framework={framework}
            status={placeholderStatus}
            language={language}
            errorMessage={error}
          />
        )}
      </a>
      <button type="button" className="button-secondary website-thumbnail-refresh" title={refreshLabel} aria-label={refreshLabel} aria-busy={busy} disabled={busy} onClick={() => void capture()} style={{ position: "absolute", bottom: 10, right: 10, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}><RefreshCw size={14} aria-hidden="true" style={busy ? { animation: "website-preview-spin 0.8s linear infinite" } : undefined} /></button>
    </div>
    {error && <p role="alert" className="project-error" style={{ margin: "6px 12px 0" }}>{error}</p>}
  </div>;
}
