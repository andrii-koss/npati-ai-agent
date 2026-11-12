import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bold, Italic, Link2, ChevronDown, Check } from "lucide-react";

type BlockStyle = "text" | "h1" | "h2" | "h3" | "bulleted" | "numbered";
interface SelectionInfo { text: string; left: number; top: number; bold: boolean; italic: boolean; block: BlockStyle }
export function ChatCardSelectionToolbar({ inlineRef, modalRef, fullscreen, language, onEdit, onAsk }: {
  inlineRef: RefObject<HTMLDivElement | null>; modalRef: RefObject<HTMLDivElement | null>; fullscreen: boolean;
  language: string; onEdit(root: HTMLDivElement): void; onAsk(text: string): void;
}) {
  const uk = language === "uk";
  const toolbar = useRef<HTMLDivElement>(null);
  const saved = useRef<{ range: Range; root: HTMLDivElement; text: string } | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [menu, setMenu] = useState<"link" | "list" | null>(null);
  const [url, setUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    const clear = () => { saved.current = null; setSelection(null); setMenu(null); };
    const update = () => {
      if (toolbar.current?.contains(document.activeElement)) return;
      const selected = window.getSelection();
      if (!selected || selected.isCollapsed || !selected.rangeCount || !selected.toString().trim()) { clear(); return; }
      const range = selected.getRangeAt(0);
      const root = (fullscreen ? [modalRef.current] : [inlineRef.current]).find(node => node?.contains(range.startContainer) && node.contains(range.endContainer));
      if (!root) { clear(); return; }
      const rect = range.getBoundingClientRect?.() ?? root.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) { clear(); return; }
      const width = Math.min(toolbar.current?.getBoundingClientRect().width || 470, window.innerWidth - 24);
      const left = Math.max(width / 2 + 12, Math.min(rect.left + rect.width / 2, window.innerWidth - width / 2 - 12));
      saved.current = { range: range.cloneRange(), root, text: selected.toString() };
      const state = (command: string) => Boolean(document.queryCommandState?.(command));
      const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
      const heading = start?.closest("h1,h2,h3");
      const block: BlockStyle = heading && root.contains(heading) ? heading.tagName.toLowerCase() as "h1" | "h2" | "h3" : "text";
      setSelection({ text: selected.toString(), left, top: rect.top >= 64 ? rect.top - 56 : rect.bottom + 10,
        bold: state("bold"), italic: state("italic"), block: state("insertOrderedList") ? "numbered" : state("insertUnorderedList") ? "bulleted" : block });
    };
    refresh.current = update;
    document.addEventListener("selectionchange", update);
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && saved.current) { clear(); event.stopImmediatePropagation(); } };
    document.addEventListener("keydown", escape);
    update();
    return () => {
      document.removeEventListener("selectionchange", update); document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update); document.removeEventListener("keydown", escape);
    };
  }, [inlineRef, modalRef, fullscreen]);

  const command = (name: string, value?: string) => {
    const target = saved.current;
    if (!target || !target.root.isConnected) return;
    target.root.focus({ preventScroll: true });
    const selected = window.getSelection();
    selected?.removeAllRanges(); selected?.addRange(target.range);
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(name, false, value);
    onEdit(target.root);
    setMenu(null); refresh.current();
  };
  if (!selection) return null;
  const formats: ReadonlyArray<readonly [BlockStyle, string]> = [
    ["text", uk ? "Звичайний текст" : "Text"],
    ["h1", uk ? "Заголовок 1" : "Heading 1"],
    ["h2", uk ? "Заголовок 2" : "Heading 2"],
    ["h3", uk ? "Заголовок 3" : "Heading 3"],
    ["numbered", uk ? "Нумерований список" : "Numbered list"],
    ["bulleted", uk ? "Маркований список" : "Bulleted list"],
  ];
  return createPortal(<div ref={toolbar} className="chat-card-selection-toolbar" role="toolbar" aria-label={uk ? "Форматування тексту" : "Text formatting"}
    style={{ left: selection.left, top: selection.top }} onMouseDown={event => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); }}>
    <button type="button" className="chat-card-ask-changes" onClick={() => { const text = saved.current?.text; if (text) onAsk(text); saved.current = null; setSelection(null); setMenu(null); }}>{uk ? "Попросити зміни" : "Ask for changes"}</button>
    <span className="chat-card-toolbar-divider" aria-hidden="true" />
    <button type="button" aria-label={uk ? "Посилання" : "Link"} title={uk ? "Посилання" : "Link"} aria-expanded={menu === "link"} onClick={() => { setMenu(menu === "link" ? null : "link"); setLinkError(""); setUrl(""); }}><Link2 size={18} /></button>
    <button type="button" aria-label={uk ? "Жирний" : "Bold"} title={uk ? "Жирний" : "Bold"} aria-pressed={selection.bold} onClick={() => command("bold")}><Bold size={17} /></button>
    <button type="button" aria-label={uk ? "Курсив" : "Italic"} title={uk ? "Курсив" : "Italic"} aria-pressed={selection.italic} onClick={() => command("italic")}><Italic size={17} /></button>
    <button type="button" aria-label={uk ? "Стиль тексту" : "Text style"} aria-haspopup="menu" aria-expanded={menu === "list"} onClick={() => setMenu(menu === "list" ? null : "list")}>{formats.find(([kind]) => kind === selection.block)?.[1]}<ChevronDown size={16} /></button>
    {menu === "list" && <div className="chat-card-toolbar-popover chat-card-format-menu" role="menu" aria-label={uk ? "Стиль тексту" : "Text style"}
      style={selection.top > window.innerHeight / 2
        ? { top: "auto", bottom: "calc(100% + 8px)", maxHeight: Math.max(80, selection.top - 24) }
        : { maxHeight: Math.max(80, window.innerHeight - selection.top - 80) }}>
      {formats.map(([kind, label]) => <button key={kind} type="button" role="menuitemradio" aria-checked={selection.block === kind} onClick={() => {
        if (kind === "text" || kind === "h1" || kind === "h2" || kind === "h3") {
          if (selection.block === "bulleted" || selection.block === "numbered") command(selection.block === "bulleted" ? "insertUnorderedList" : "insertOrderedList");
          command("formatBlock", kind === "text" ? "p" : kind);
        }
        else command(kind === "bulleted" ? "insertUnorderedList" : "insertOrderedList");
      }}><span>{label}</span>{selection.block === kind && <Check size={16} aria-hidden="true" />}</button>)}
    </div>}
    {menu === "link" && <form className="chat-card-toolbar-popover chat-card-link-editor" onSubmit={event => {
      event.preventDefault(); let href = url.trim();
      try {
        if (href.startsWith("/") && !href.startsWith("//") && !href.includes("\\")) { /* Local destination. */ }
        else { if (!/^[a-z][a-z\d+.-]*:/i.test(href)) href = "https://" + href; const parsed = new URL(href); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); href = parsed.href; }
        command("createLink", href);
      } catch { setLinkError(uk ? "Введіть коректне HTTP або HTTPS посилання" : "Enter a valid HTTP or HTTPS link"); }
    }}>
      <input autoFocus type="text" aria-label={uk ? "Адреса посилання" : "Link URL"} placeholder="https://example.com" value={url} onChange={event => setUrl(event.target.value)} />
      <button type="submit">{uk ? "Додати" : "Apply"}</button><button type="button" onClick={() => command("unlink")}>{uk ? "Видалити посилання" : "Remove link"}</button>
      {linkError && <small role="alert">{linkError}</small>}
    </form>}
  </div>, document.body);
}
