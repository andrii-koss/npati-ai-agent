import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Maximize2, Minimize2, RefreshCw, Save, X } from "lucide-react";
import { api } from "./business-workspace-shared";
import { I18nContextRef } from "./i18n";
import { LivePreviewSplitResizer } from "./LivePreviewSplitResizer";
import { PreviewSideButton } from "./PreviewSideButton";
import { HighlightedCode, codeLanguage, codeWindow } from "./code-highlight";

export type ChatFileTarget = { companyId: string; projectId: string; path: string };
type FileContent = { content: string; revision: string; binary?: boolean };

/** Opens a project file in the side panel; null where the chat has no panel. */
export const ChatFileViewerContext = createContext<((target: ChatFileTarget) => void) | null>(null);

const fileUrl = ({ companyId, projectId }: ChatFileTarget, action: string) =>
  `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/files/${action}`;

/** Above this size a file is edited as plain text. */
const MAX_COLORED_CHARS = 400_000;
const PRELOAD_MS = 30_000;
type Preloaded = { at: number; promise: Promise<FileContent | null>; value?: FileContent };
const preloaded = new Map<string, Preloaded>();
const fileKey = (target: ChatFileTarget) => `${target.projectId}:${target.path}`;

/** Fetches a file when the pointer reaches its block, so the click can show it at once. */
export function preloadChatFile(target: ChatFileTarget): void {
  const key = fileKey(target);
  const existing = preloaded.get(key);
  if (existing && Date.now() - existing.at < PRELOAD_MS) return;
  if (preloaded.size >= 30) preloaded.clear();
  const entry: Preloaded = { at: Date.now(), promise: api<FileContent>(`${fileUrl(target, "read")}?path=${encodeURIComponent(target.path)}`).then(file => { entry.value = file; return file; }).catch(() => null) };
  preloaded.set(key, entry);
}
function recentPreload(target: ChatFileTarget): Preloaded | undefined {
  const entry = preloaded.get(fileKey(target));
  return entry && Date.now() - entry.at < PRELOAD_MS ? entry : undefined;
}

/** Same layer, drawer, resizer and header classes as Live Preview, so the panel has its size, motion and style. */
function ChatFileDrawer({ target, busy, dirtyRef, onClose }: { target: ChatFileTarget; busy: boolean; dirtyRef: React.MutableRefObject<boolean>; onClose(): void }) {
  const isUk = useContext(I18nContextRef)?.language === "uk";
  const [opened] = useState(() => recentPreload(target));
  const [text, setText] = useState(opened?.value?.content ?? "");
  const [saved, setSaved] = useState(opened?.value?.content ?? "");
  const [revision, setRevision] = useState(opened?.value?.revision ?? "");
  const [state, setState] = useState<"loading" | "ready" | "saving">(opened?.value ? "ready" : "loading");
  const [error, setError] = useState("");
  const [binary, setBinary] = useState(opened?.value?.binary === true);
  const language = useMemo(() => codeLanguage(target.path), [target.path]);
  const overlay = useRef<HTMLPreElement>(null);
  const [firstLine, setFirstLine] = useState(0);
  const [copied, setCopied] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const gutter = useRef<HTMLPreElement>(null);
  const dirty = text !== saved;
  dirtyRef.current = dirty;
  const lines = useMemo(() => text.split("\n").length, [text]);
  const numbers = useMemo(() => Array.from({ length: lines }, (_, index) => index + 1).join("\n"), [lines]);

  const load = useCallback(async () => {
    setState("loading"); setError("");
    try {
      const file = await api<FileContent>(`${fileUrl(target, "read")}?path=${encodeURIComponent(target.path)}`);
      setBinary(file.binary === true); setText(file.content); setSaved(file.content); setRevision(file.revision);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not open the file"); }
    setState("ready");
  }, [target]);
  useEffect(() => {
    let cancelled = false;
    const apply = (file: FileContent) => { setBinary(file.binary === true); setText(file.content); setSaved(file.content); setRevision(file.revision); setState("ready"); };
    if (opened?.value) {
      // Shown from the preload at once; a newer version replaces it unless the user has already started editing.
      void api<FileContent>(`${fileUrl(target, "read")}?path=${encodeURIComponent(target.path)}`).then(file => { if (!cancelled && !dirtyRef.current && file.revision !== opened.value!.revision) apply(file); }).catch(() => undefined);
    } else if (opened) {
      void opened.promise.then(file => { if (cancelled) return; if (file) apply(file); else void load(); });
    } else void load();
    return () => { cancelled = true; };
  }, [load, opened, target, dirtyRef]);

  /** The saved file stays saved whatever happens here: this only brings it to the running Preview. */
  async function applyToPreview() {
    setPublishing(true);
    try {
      await api(`/companies/${encodeURIComponent(target.companyId)}/projects/${encodeURIComponent(target.projectId)}/preview/apply-file-changes`, { method: "POST", body: "{}" });
      window.dispatchEvent(new CustomEvent("npati-code-project-updated", { detail: { projectId: target.projectId } }));
    } catch (failure) {
      setError(`${isUk ? "Файл збережено, але Preview не оновився" : "The file is saved, but Preview was not updated"}: ${failure instanceof Error ? failure.message : ""}`);
    }
    setPublishing(false);
  }
  const canSave = dirty && !busy && !binary && state === "ready" && !!revision;
  async function save() {
    if (!canSave) return;
    setState("saving"); setError("");
    try {
      const file = await api<FileContent>(fileUrl(target, "write"), { method: "POST", body: JSON.stringify({ path: target.path, content: text, expectedRevision: revision }) });
      preloaded.delete(fileKey(target));
      setSaved(text); setRevision(file.revision); setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2000);
      void applyToPreview();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "";
      setError(/revision/i.test(message) ? (isUk ? "Файл змінився після відкриття. Оновіть його, щоб не перезаписати нову версію." : "The file changed after you opened it. Reload it so a newer version is not overwritten.") : message || (isUk ? "Не вдалося зберегти файл" : "Could not save the file"));
    }
    setState("ready");
  }
  const reload = () => { if (!dirty || window.confirm(isUk ? "Скасувати незбережені зміни?" : "Discard unsaved changes?")) void load(); };
  const close = () => { if (!dirty || window.confirm(isUk ? "Закрити без збереження?" : "Close without saving?")) onClose(); };
  async function copy() {
    await navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(true); window.setTimeout(() => setCopied(false), 2000);
  }
  const fullscreen = isUk ? (isFullscreen ? "Згорнути" : "На весь екран") : (isFullscreen ? "Restore size" : "Maximize");
  const colored = Boolean(language) && text.length <= MAX_COLORED_CHARS;
  const status = state === "loading" ? "starting" : error ? "failed" : dirty ? "stopped" : "running";

  return createPortal(
    <div className={`project-chat-preview-layer ${isFullscreen ? "is-fullscreen" : ""}`}>
      <aside className={`project-chat-preview-drawer ${isFullscreen ? "is-fullscreen" : ""}`} role="complementary" aria-label={target.path}>
        {!isFullscreen && <LivePreviewSplitResizer />}
        <header className="project-chat-preview-header" role="toolbar" aria-label={target.path}>
          <div className="preview-header-left">
            <span className={`preview-header-status-dot status-${status}`} role="status" aria-label={dirty ? (isUk ? "Є незбережені зміни" : "Unsaved changes") : (isUk ? "Збережено" : "Saved")} />
            <h3 className="preview-header-project-name" title={target.path}>{target.path}{dirty ? " *" : ""}</h3>
          </div>
          <div className="preview-header-right">
            <PreviewSideButton isUk={isUk} />
            <button type="button" className="preview-header-icon-btn" onClick={reload} aria-label={isUk ? "Оновити файл" : "Reload file"} title={isUk ? "Оновити файл" : "Reload file"}><RefreshCw size={19} strokeWidth={1.9} aria-hidden="true" /></button>
            <button type="button" className="preview-header-icon-btn" onClick={() => void save()} disabled={!canSave} aria-label={isUk ? "Зберегти" : "Save"} title={busy ? (isUk ? "Агент зараз змінює проєкт" : "The agent is changing this project") : `${isUk ? "Зберегти" : "Save"} (Ctrl+S)`}>{justSaved ? <Check size={19} strokeWidth={2.2} className="preview-icon-success" aria-hidden="true" /> : <Save size={19} strokeWidth={1.9} aria-hidden="true" />}</button>
            <div className="preview-header-divider" aria-hidden="true" />
            <button type="button" className="preview-header-icon-btn" onClick={() => void copy()} disabled={binary} aria-label={isUk ? "Скопіювати код" : "Copy code"} title={isUk ? "Скопіювати код" : "Copy code"}>{copied ? <Check size={19} strokeWidth={2.2} className="preview-icon-success" aria-hidden="true" /> : <Copy size={19} strokeWidth={1.9} aria-hidden="true" />}</button>
            <button type="button" className="preview-header-icon-btn" onClick={() => setIsFullscreen(value => !value)} aria-label={fullscreen} title={fullscreen} aria-pressed={isFullscreen}>{isFullscreen ? <Minimize2 size={19} strokeWidth={1.9} aria-hidden="true" /> : <Maximize2 size={19} strokeWidth={1.9} aria-hidden="true" />}</button>
            <div className="preview-header-divider" aria-hidden="true" />
            <button type="button" className="preview-header-icon-btn preview-header-close-btn" onClick={close} aria-label={isUk ? "Закрити" : "Close"} title={isUk ? "Закрити" : "Close"}><X size={20} strokeWidth={2} aria-hidden="true" /></button>
          </div>
        </header>
        {error && <p className="chat-file-error" role="alert">{error}</p>}
        {busy && !error && <p className="chat-file-note">{isUk ? "Агент зараз змінює проєкт. Зберегти можна після завершення." : "The agent is changing this project. You can save when it finishes."}</p>}
        {publishing && <p className="chat-file-note" role="status">{isUk ? "Оновлюю сайт у Preview…" : "Updating the site in Preview…"}</p>}
        <div className="chat-file-editor">
          {binary ? <p className="chat-file-note">{isUk ? "Це не текстовий файл." : "This is not a text file."}</p> : state !== "loading" && <>
            <pre ref={gutter} className="chat-file-gutter" aria-hidden="true">{numbers}</pre>
            <div className="chat-file-code">
              {colored && <pre ref={overlay} className="chat-file-highlight" aria-hidden="true"><HighlightedCode text={text} language={language} firstLine={firstLine} /></pre>}
              <textarea className={`chat-file-text ${colored ? "is-colored" : ""}`} aria-label={target.path} spellCheck={false} wrap="off" value={text} readOnly={busy || Boolean(error && !revision)}
                onChange={event => setText(event.target.value)}
                onScroll={event => { setFirstLine(codeWindow(event.currentTarget.scrollTop)); if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop; if (overlay.current) { overlay.current.scrollTop = event.currentTarget.scrollTop; overlay.current.scrollLeft = event.currentTarget.scrollLeft; } }}
                onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } }} />
            </div>
          </>}
        </div>
      </aside>
    </div>, document.body);
}

export function ChatFileViewerProvider({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  const language = useContext(I18nContextRef)?.language;
  const [target, setTarget] = useState<ChatFileTarget | null>(null);
  const dirtyRef = useRef(false);
  const languageRef = useRef(language); languageRef.current = language;
  const open = useCallback((next: ChatFileTarget) => {
    if (dirtyRef.current && !window.confirm(languageRef.current === "uk" ? "Відкрити інший файл без збереження?" : "Open another file without saving?")) return;
    dirtyRef.current = false;
    setTarget(next);
  }, []);
  return <ChatFileViewerContext.Provider value={open}>
    {children}
    {target && <ChatFileDrawer key={`${target.projectId}:${target.path}`} target={target} busy={busy} dirtyRef={dirtyRef} onClose={() => { dirtyRef.current = false; setTarget(null); }} />}
  </ChatFileViewerContext.Provider>;
}
