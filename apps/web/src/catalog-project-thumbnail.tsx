import { useEffect, useRef, useState } from "react";
import { Camera, RefreshCw } from "lucide-react";
import { getStoredAuthToken, getStoredAuthUser } from "./AuthContext";
import { apiFetch } from "./website-builder-cache";
import { openableProjectPreview, projectPreviewRoot } from "./catalog-project-preview";

interface Thumbnail { dataUrl: string; capturedAt: string }
const cache = new Map<string, { thumbnail: Thumbnail | null; time: number }>();
let identity = "";

export function CatalogProjectThumbnail({ companyId, projectId, name, language, onPreview }: { companyId: string; projectId: string; name: string; language: string; onPreview(): void }) {
  const authIdentity = JSON.stringify([getStoredAuthToken(), getStoredAuthUser()?.id]);
  if (identity !== authIdentity) { cache.clear(); identity = authIdentity; }
  const key = JSON.stringify([authIdentity, companyId, projectId]);
  const root = projectPreviewRoot(companyId, projectId);
  const uk = language === "uk";
  const refreshLabel = uk ? "Оновити знімок" : "Refresh screenshot";
  const container = useRef<HTMLDivElement>(null);
  const [thumbnail, setThumbnail] = useState<Thumbnail | null>(() => cache.get(key)?.thumbnail ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function remember(value: Thumbnail | null) {
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, { thumbnail: value, time: Date.now() });
    setThumbnail(value);
  }
  useEffect(() => {
    const controller = new AbortController();
    let started = false;
    const load = () => {
      if (started) return;
      started = true;
      const previous = cache.get(key);
      if (previous && Date.now() - previous.time < 60_000) return;
      void apiFetch<{ thumbnail: Thumbnail | null }>(root + "/qa/thumbnail", { signal: controller.signal }).then(result => {
        if (!controller.signal.aborted) remember(result.thumbnail);
      }).catch(() => {});
    };
    if (!globalThis.IntersectionObserver) load();
    const observer = globalThis.IntersectionObserver ? new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { load(); observer?.disconnect(); } }, { rootMargin: "150px" }) : null;
    if (container.current) observer?.observe(container.current);
    return () => { controller.abort(); observer?.disconnect(); };
  }, [key, root]);
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
  return <div ref={container}>
    <div className="website-preview-viewport" style={{ position: "relative", width: "100%", aspectRatio: "16 / 10", borderRadius: 14, overflow: "hidden", background: "#f8fafc", border: "1px solid #eaecf0" }}>
      <a href={`/settings/projects/${encodeURIComponent(companyId)}/${encodeURIComponent(projectId)}`} aria-label={`Preview ${name}`} onClick={event => { event.preventDefault(); onPreview(); }} style={{ position: "absolute", inset: 0, display: "block", cursor: "pointer" }}>
        {thumbnail ? <img src={thumbnail.dataUrl} alt={uk ? `Вигляд проєкту ${name}` : `${name} project screenshot`} loading="lazy" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
          : <div className="website-card-placeholder" style={{ display: "grid", placeItems: "center", height: "100%", color: "#667085" }}><Camera size={32} /></div>}
      </a>
      <button type="button" className="button-secondary website-thumbnail-refresh" title={refreshLabel} aria-label={refreshLabel} aria-busy={busy} disabled={busy} onClick={() => void capture()} style={{ position: "absolute", bottom: 10, right: 10, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, background: "#fff" }}><RefreshCw size={14} aria-hidden="true" style={busy ? { animation: "website-preview-spin 0.8s linear infinite" } : undefined} /></button>
    </div>
    {error && <p role="alert" className="project-error">{error}</p>}
  </div>;
}
