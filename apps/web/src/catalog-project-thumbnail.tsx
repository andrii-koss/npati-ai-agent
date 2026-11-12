import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getStoredAuthToken, getStoredAuthUser } from "./AuthContext";
import { apiFetch } from "./website-builder-cache";
import { openableProjectPreview, projectPreviewRoot } from "./catalog-project-preview";
import { ProjectPreviewPlaceholder, type PreviewPlaceholderStatus } from "./ProjectPreviewPlaceholder";

interface Thumbnail { dataUrl: string; capturedAt: string }
const cache = new Map<string, { thumbnail: Thumbnail | null; time: number }>();
const pending = new Map<string, Promise<Thumbnail | null>>();
let identity = "";

function thumbnailKey(companyId: string, projectId: string) {
  const auth = JSON.stringify([getStoredAuthToken(), getStoredAuthUser()?.id]);
  if (identity !== auth) { cache.clear(); pending.clear(); identity = auth; }
  return JSON.stringify([auth, companyId, projectId]);
}

function rememberThumbnail(key: string, thumbnail: Thumbnail | null) {
  cache.delete(key);
  cache.set(key, { thumbnail, time: Date.now() });
  let size = [...cache.values()].reduce((sum, entry) => sum + (entry.thumbnail?.dataUrl.length ?? 0), 0);
  while (cache.size > 32 || size > 16 * 1024 * 1024) {
    const oldest = cache.keys().next().value!;
    size -= cache.get(oldest)?.thumbnail?.dataUrl.length ?? 0;
    cache.delete(oldest);
  }
}

function requestThumbnail(key: string, root: string) {
  const previous = cache.get(key);
  if (previous && Date.now() - previous.time < 300_000) return Promise.resolve(previous.thumbnail);
  const existing = pending.get(key);
  if (existing) return existing;
  const auth = identity;
  const request = apiFetch<{ thumbnail: Thumbnail | null }>(root + "/qa/thumbnail", { signal: AbortSignal.timeout(15_000) }).then(result => {
    if (identity === auth && pending.get(key) === request) rememberThumbnail(key, result.thumbnail);
    return cache.get(key)?.thumbnail ?? result.thumbnail;
  }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}

export function preloadCatalogThumbnails(projects: ReadonlyArray<{ companyId: string; id: string; hasThumbnail?: boolean }>) {
  for (const project of projects.slice(0, 6)) if (project.hasThumbnail)
    void requestThumbnail(thumbnailKey(project.companyId, project.id), projectPreviewRoot(project.companyId, project.id)).catch(() => {});
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
  const key = thumbnailKey(companyId, projectId);
  const root = projectPreviewRoot(companyId, projectId);
  const uk = language === "uk";
  const refreshLabel = uk ? "Оновити знімок" : "Refresh screenshot";
  const container = useRef<HTMLDivElement>(null);

  const [image, setImage] = useState(() => ({ key, thumbnail: cache.get(key)?.thumbnail ?? null, settled: hasThumbnail === false || cache.has(key) }));
  const thumbnail = image.key === key ? image.thumbnail : cache.get(key)?.thumbnail ?? null;
  const settled = image.key === key ? image.settled : hasThumbnail === false || cache.has(key);
  const [decodedImage, setDecodedImage] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function remember(value: Thumbnail | null) {
    pending.delete(key);
    rememberThumbnail(key, value);
    setImage({ key, thumbnail: value, settled: true });
  }

  useEffect(() => {
    let active = true;
    let started = false;
    setImage(current => current.key === key && current.thumbnail ? current : { key, thumbnail: cache.get(key)?.thumbnail ?? null, settled: hasThumbnail === false || cache.has(key) });
    const load = () => {
      if (started) return;
      started = true;
      const previous = cache.get(key);
      if (previous && Date.now() - previous.time < 300_000) {
        setImage({ key, thumbnail: previous.thumbnail, settled: true });
        return;
      }
      if (hasThumbnail === false && !previous?.thumbnail) return;
      void requestThumbnail(key, root).then(value => {
        if (active) setImage({ key, thumbnail: value, settled: true });
      }).catch(() => { if (active) setImage(current => current.key === key ? { ...current, settled: true } : current); });
    };

    if (!globalThis.IntersectionObserver) {
      load();
    } else {
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          load();
          observer?.disconnect();
        }
      }, { rootMargin: "250px" });
      if (container.current) observer.observe(container.current);
      return () => { active = false; observer.disconnect(); };
    }
    return () => { active = false; };
  }, [key, root, hasThumbnail]);

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

  const isImageReady = Boolean(thumbnail && decodedImage === thumbnail.dataUrl);
  const isImagePending = Boolean(thumbnail || !settled);

  return <div ref={container} style={{ width: "100%" }}>
    <div className="website-preview-viewport" style={{ position: "relative", width: "100%", aspectRatio: "16 / 10", overflow: "hidden", background: "#f8fafc" }}>
      <a href={previewHref} aria-label={`Preview ${name}`} onClick={event => { event.preventDefault(); onPreview(); }} style={{ position: "absolute", inset: 0, display: "block", cursor: "pointer", textDecoration: "none" }}>
        {thumbnail && (
          <img
            src={thumbnail!.dataUrl}
            alt={uk ? `Вигляд проєкту ${name}` : `${name} project screenshot`}
            loading="lazy"
            decoding="async"
            onLoad={event => {
              const element = event.currentTarget;
              const source = thumbnail.dataUrl;
              const ready = () => { if (container.current?.contains(element) && element.getAttribute("src") === source) setDecodedImage(source); };
              if (element.decode) void element.decode().then(ready).catch(() => { if (container.current?.contains(element) && element.getAttribute("src") === source) remember(null); });
              else ready();
            }}
            onError={() => remember(null)}
            style={{ display: "block", position: "absolute", inset: 0, opacity: isImageReady ? 1 : 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }}
          />
        )}
        {!isImageReady && (isImagePending ? (
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
        ))}
      </a>
      <button type="button" className="button-secondary website-thumbnail-refresh" title={refreshLabel} aria-label={refreshLabel} aria-busy={busy} disabled={busy} onClick={() => void capture()} style={{ position: "absolute", bottom: 10, right: 10, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}><RefreshCw size={14} aria-hidden="true" style={busy ? { animation: "website-preview-spin 0.8s linear infinite" } : undefined} /></button>
    </div>
    {error && <p role="alert" className="project-error" style={{ margin: "6px 12px 0" }}>{error}</p>}
  </div>;
}
