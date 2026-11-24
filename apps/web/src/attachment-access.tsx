import { useEffect, useRef, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";

/**
 * Security audit 2026-11-24, L6: the session token no longer goes into URLs. An image is fetched with the Authorization
 * header (only once it scrolls into view, as `loading="lazy"` did), and a download asks the API for a 60-second ticket
 * bound to that one file at the moment it is clicked.
 */
function authHeaders(): HeadersInit {
  const token = getStoredAuthToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** A one-path, short-lived URL for elements that cannot send headers (downloads, media, event streams). */
export async function ticketedUrl(apiPath: string): Promise<string> {
  const response = await fetch("/api/stream-tickets", {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ path: apiPath }),
  });
  if (!response.ok) throw new Error(`Could not open the file (HTTP ${response.status})`);
  const { url } = await response.json() as { url: string };
  return url;
}

export async function downloadAttachment(id: string, name: string): Promise<void> {
  const link = document.createElement("a");
  link.href = await ticketedUrl(`/api/attachments/${encodeURIComponent(id)}`);
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function AttachmentImage({ id, name, onLoad }: { id: string; name: string; onLoad?: () => void }) {
  const holder = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (visible || !holder.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "400px" });
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    fetch(`/api/attachments/${encodeURIComponent(id)}`, { headers: authHeaders() })
      .then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.blob(); })
      .then((blob) => { if (cancelled) return; objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, visible]);

  if (src) return <img src={src} alt={name} decoding="async" onLoad={onLoad} />;
  return <span ref={holder} className="chat-attachment-image-placeholder" role="img" aria-label={failed ? `${name} (unavailable)` : name} aria-busy={!failed} />;
}
