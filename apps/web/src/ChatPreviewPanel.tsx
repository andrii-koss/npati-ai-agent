import { isolatedPreviewUrl } from "./preview-origin";
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";
import { LivePreviewHeader, type DeviceMode } from "./LivePreviewHeader";
import { LivePreviewSplitResizer } from "./LivePreviewSplitResizer";

export type PreviewPanelCard = { id: string; projectId?: string; companyId: string; name: string; framework?: string; sessionId?: string };
export interface ChatPreviewPanelApi {
  open(card: PreviewPanelCard, thumbnail?: string | null): void;
  warm(card: PreviewPanelCard, thumbnail?: string | null): void;
  leave(): void;
}
/** The page's one Preview panel. It outlives the message cards, which are replaced when a reply arrives. */
export const ChatPreviewPanelContext = createContext<ChatPreviewPanelApi | null>(null);

const OPEN_KEY = "npati_open_preview";
const openValue = (projectId: string) => window.location.pathname + "|" + projectId;
export function wasPreviewPanelOpen(projectId: string) {
  try { return sessionStorage.getItem(OPEN_KEY) === openValue(projectId); } catch { return false; }
}
function rememberOpen(projectId: string, open: boolean) {
  try {
    if (open) sessionStorage.setItem(OPEN_KEY, openValue(projectId));
    else if (sessionStorage.getItem(OPEN_KEY) === openValue(projectId)) sessionStorage.removeItem(OPEN_KEY);
  } catch { /* The panel simply stays closed after a reload. */ }
}

const authHeaders = (): Record<string, string> => { const token = getStoredAuthToken(); return token ? { authorization: `Bearer ${token}` } : {}; };
const projectOf = (card: PreviewPanelCard) => card.projectId ?? card.id;
const endpointOf = (card: PreviewPanelCard) => `/api/companies/${encodeURIComponent(card.companyId)}/projects/${encodeURIComponent(projectOf(card))}/preview`;

/** The address of the running site, or null when it is not running. Never starts anything. */
async function runningUrl(card: PreviewPanelCard): Promise<string | null> {
  const endpoint = endpointOf(card);
  const status = await fetch(`${endpoint}/status`, { headers: authHeaders() }).then(response => response.ok ? response.json() as Promise<{ isRunning?: boolean; previewUrl?: string }> : null).catch(() => null);
  if (!status?.isRunning) return null;
  if (status.previewUrl) return status.previewUrl;
  const value = await fetch(`${endpoint}/token`, { headers: authHeaders() }).then(response => response.ok ? response.json() as Promise<{ token?: string }> : null).catch(() => null);
  return value?.token ? `${endpoint}/proxy/?token=${encodeURIComponent(value.token)}` : null;
}

async function startedUrl(card: PreviewPanelCard): Promise<string> {
  const response = await fetch(`${endpointOf(card)}/start`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: "{}" });
  const payload = await response.json().catch(() => null) as { previewUrl?: string; error?: string | { message?: string } } | null;
  if (!response.ok || !payload?.previewUrl) throw new Error((typeof payload?.error === "string" ? payload.error : payload?.error?.message) || "Preview is unavailable.");
  return payload.previewUrl;
}

type Frame = { id: number; url: string };

function PreviewPanel({ card, open, busy, thumbnail, onClose }: { card: PreviewPanelCard; open: boolean; busy: boolean; thumbnail?: string | null; onClose(): void }) {
  const { language } = useTranslation();
  const isUk = language === "uk";
  const [frames, setFrames] = useState<Frame[]>([]);
  const [shown, setShown] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const nextId = useRef(1);
  const refs = useRef(new Map<number, HTMLIFrameElement>());
  const urlRef = useRef("");
  const shownRef = useRef<number | null>(null);
  const busyRef = useRef(busy); busyRef.current = busy;
  const timer = useRef<number | undefined>(undefined);

  const addFrame = useCallback((url: string) => {
    urlRef.current = url;
    // The frame on screen stays until its replacement has loaded.
    setFrames(list => [...list.filter(frame => frame.id === shownRef.current), { id: nextId.current++, url }]);
  }, []);

  /** Replaces the page with the current version of the site, without showing an empty frame. */
  const reload = useCallback(async () => {
    const url = await runningUrl(card) ?? urlRef.current;
    if (url) addFrame(url);
  }, [addFrame, card]);
  const scheduleReload = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload(), 400);
  }, [reload]);

  useEffect(() => {
    // Opening a panel already readied on hover reveals that page; it must not load it again.
    if (urlRef.current) return;
    let cancelled = false;
    void (async () => {
      const url = await runningUrl(card);
      if (cancelled) return;
      if (url) { addFrame(url); return; }
      if (!open) return;
      try { const started = await startedUrl(card); if (!cancelled) addFrame(started); }
      catch (failure) { if (!cancelled) setError(failure instanceof Error ? failure.message : "Preview is unavailable."); }
    })();
    return () => { cancelled = true; };
    // A panel readied on hover starts the site only once it is really opened.
  }, [card, open, addFrame]);

  // A change is visible when the work that made it has ended: one reload for the whole run.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) scheduleReload();
    wasBusy.current = busy;
  }, [busy, scheduleReload]);
  useEffect(() => {
    const projectId = projectOf(card);
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!busyRef.current && (!detail?.projectId || detail.projectId === projectId)) scheduleReload();
    };
    window.addEventListener("npati-code-project-updated", onUpdate);
    return () => { window.removeEventListener("npati-code-project-updated", onUpdate); window.clearTimeout(timer.current); };
  }, [card, scheduleReload]);

  function frameLoaded(id: number) {
    const previous = shownRef.current === null ? undefined : refs.current.get(shownRef.current);
    try { const y = previous?.contentWindow?.scrollY; if (y) refs.current.get(id)?.contentWindow?.scrollTo(0, y); } catch { /* The new page keeps its own position. */ }
    shownRef.current = id;
    setShown(id);
    window.setTimeout(() => setFrames(list => list.filter(frame => frame.id >= id)), 260);
  }

  function refresh() {
    if (/^(?:HTML\/CSS|static)$/.test(card.framework ?? "")) {
      void fetch(`${endpointOf(card)}/apply-file-changes`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: "{}" }).catch(() => undefined).finally(() => void reload());
    } else void reload();
  }

  const code = `/settings/code/${encodeURIComponent(card.companyId)}/${encodeURIComponent(projectOf(card))}${card.sessionId ? `?session=${encodeURIComponent(card.sessionId)}` : ""}`;
  const status = error ? "failed" : shown === null ? "starting" : "running";
  return createPortal(
    <div className={open ? `project-chat-preview-layer ${isFullscreen ? "is-fullscreen" : ""}` : "project-chat-preview-warm"} aria-hidden={!open}>
      <aside className={`project-chat-preview-drawer ${isFullscreen ? "is-fullscreen" : ""}`} role="complementary" aria-label={`Preview of ${card.name}`}>
        {open && !isFullscreen && <LivePreviewSplitResizer />}
        <LivePreviewHeader projectName={card.name} runtimeStatus={status} previewUrl={urlRef.current || null} isUk={isUk} codeWorkspaceUrl={code} terminalUrl={`${code}${code.includes("?") ? "&" : "?"}tab=terminal`} deviceMode={deviceMode} setDeviceMode={setDeviceMode} isFullscreen={isFullscreen} setIsFullscreen={setIsFullscreen} onRefresh={refresh} onClose={onClose} />
        <div className="project-chat-preview-body" data-device-mode={deviceMode}>
          <div className="project-chat-preview-viewport" data-device-mode={deviceMode}>
            {shown === null && !error && thumbnail && <img className="project-chat-preview-placeholder" src={thumbnail} alt="" />}
            {error ? <div className="project-chat-preview-empty" role="status">{error}</div> : frames.map(frame => (
              <iframe key={frame.id} ref={element => { if (element) refs.current.set(frame.id, element); else refs.current.delete(frame.id); }} title={`${card.name} preview`} src={isolatedPreviewUrl(frame.url)} onLoad={() => frameLoaded(frame.id)} className={`project-chat-preview-frame chat-preview-panel-frame ${shown === null || frame.id > shown ? "is-entering" : ""}`} />
            ))}
          </div>
        </div>
      </aside>
    </div>, document.body);
}

export function ChatPreviewPanelProvider({ busy, conversationId, children }: { busy: boolean; conversationId: string | null; children: React.ReactNode }) {
  const [state, setState] = useState<{ card: PreviewPanelCard; open: boolean; thumbnail?: string | null } | null>(null);
  const [hovering, setHovering] = useState(false);
  const api = useMemo<ChatPreviewPanelApi>(() => ({
    open: (card, thumbnail) => { rememberOpen(projectOf(card), true); setState(current => current && projectOf(current.card) === projectOf(card) ? { ...current, open: true, thumbnail: thumbnail ?? current.thumbnail } : { card, open: true, thumbnail }); },
    warm: (card, thumbnail) => { setHovering(true); setState(current => current?.open || (current && projectOf(current.card) === projectOf(card)) ? current : { card, open: false, thumbnail }); },
    leave: () => setHovering(false),
  }), []);
  const close = useCallback(() => {
    setState(current => { if (current) rememberOpen(projectOf(current.card), false); return current ? { ...current, open: false } : current; });
    setHovering(false);
  }, []);
  // A site readied but not looked at does not keep running hidden.
  useEffect(() => {
    if (!state || state.open || hovering) return;
    const timer = window.setTimeout(() => setState(null), 60_000);
    return () => window.clearTimeout(timer);
  }, [state, hovering]);
  useEffect(() => {
    if (!state?.open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state?.open, close]);
  // Another chat has its own site; a chat receiving its first id is still the same chat.
  const previousChat = useRef(conversationId);
  useEffect(() => {
    if (previousChat.current && conversationId !== previousChat.current) setState(null);
    previousChat.current = conversationId;
  }, [conversationId]);
  return <ChatPreviewPanelContext.Provider value={api}>
    {children}
    {state && <PreviewPanel key={projectOf(state.card)} card={state.card} open={state.open} busy={busy} thumbnail={state.thumbnail} onClose={close} />}
  </ChatPreviewPanelContext.Provider>;
}
