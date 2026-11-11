import React, { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Archive, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Maximize2, Minimize2, Square, Trash2, type LucideIcon } from "lucide-react";
import { promptModal } from "../ConfirmDialog";
import { codeErrorMessage } from "./labels";

export type RecordsApi = <T>(path: string, init?: RequestInit) => Promise<T>;
export function RecordIconButton({ label, icon: Icon, danger, ...props }: {
  label: string; icon: LucideIcon; danger?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return <button type="button" className={`code-record-icon${danger ? " danger" : ""}`}
    title={label} aria-label={label} {...props}><Icon size={16} strokeWidth={1.7} aria-hidden="true" /></button>;
}

type RecordItem = { id: string; revision?: number; status?: string };
type TableState<T> = {
  rows: T[]; selected: Set<string>; busy: boolean; allVisible: boolean; someVisible: boolean;
  toggle(id: string): void; togglePage(): void; remove(item: T): void;
};
export interface CodeRecordsPanelProps<T extends RecordItem> {
  items: T[];
  kind: "projects" | "sessions";
  companyId: string;
  isUk: boolean;
  readOnly: boolean;
  busyId: string | null;
  api: RecordsApi;
  onChanged(): void;
  children(state: TableState<T>): ReactNode;
}

export function CodeRecordsPanel<T extends RecordItem>({ items, kind, companyId, isUk, readOnly, busyId, api, onChanged, children }: CodeRecordsPanelProps<T>) {
  const [page, setPage] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const lock = useRef(false), alive = useRef(true);
  const panel = useRef<HTMLElement>(null);
  const contentId = useId();
  const label = kind === "projects" ? (isUk ? "Проєкти" : "Projects") : (isUk ? "Сесії" : "Sessions");
  const pages = Math.max(1, Math.ceil(items.length / 5));
  const currentPage = Math.min(page, pages - 1);
  const rows = items.slice(currentPage * 5, currentPage * 5 + 5);
  const blocked = busy || busyId !== null;
  const allVisible = rows.length > 0 && rows.every(item => selected.has(item.id));
  const someVisible = rows.some(item => selected.has(item.id));
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const ids = new Set(items.map(item => item.id));
    setSelected(previous => [...previous].every(id => ids.has(id)) ? previous : new Set([...previous].filter(id => ids.has(id))));
  }, [items]);
  useEffect(() => {
    if (!fullscreen) return;
    const overflow = document.body.style.overflow;
    const focused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = overflow; window.removeEventListener("keydown", escape); focused?.focus(); };
  }, [fullscreen]);
  const toggle = (id: string) => setSelected(previous => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const togglePage = () => setSelected(previous => {
    const next = new Set(previous);
    rows.forEach(item => { if (allVisible) next.delete(item.id); else next.add(item.id); });
    return next;
  });
  const execute = async (action: "delete" | "archive", targets: T[]) => {
    if (readOnly || blocked || lock.current || !targets.length) return;
    lock.current = true; setBusy(true); setNotice("");
    try {
      const answer = await promptModal({
        title: `${action === "delete" ? (isUk ? "Видалити" : "Delete") : (isUk ? "Архівувати" : "Archive")} ${label.toLowerCase()}: ${targets.length}`,
        message: action === "delete"
          ? (isUk
            ? `${kind === "projects" ? "Буде видалено вибрані проєкти та їхні сесії." : "Буде видалено вибрані сесії та їхню історію. Файли проєктів залишаться."} Введіть delete для підтвердження:`
            : `${kind === "projects" ? "Selected projects and their sessions will be deleted." : "Selected sessions and their history will be deleted. Project files will remain."} Type delete to confirm:`)
          : (isUk ? "Вибрані записи залишаться в історії. Введіть archive для підтвердження:" : "Selected records will remain in history. Type archive to confirm:"),
        confirmText: action === "delete" ? (isUk ? "Видалити" : "Delete") : (isUk ? "Архівувати" : "Archive"),
        isDanger: true,
      });
      if (!alive.current || answer?.trim().toLowerCase() !== action) return;
      const succeeded = new Set<string>();
      let firstError = "";
      for (const item of targets) {
        if (!alive.current) return;
        const base = `/companies/${encodeURIComponent(companyId)}`;
        const path = action === "archive"
          ? kind === "projects" ? `${base}/projects/${encodeURIComponent(item.id)}/archive` : `${base}/code/sessions/${encodeURIComponent(item.id)}/archive`
          : `${base}/code/${kind}/${encodeURIComponent(item.id)}${kind === "sessions" ? "/data" : ""}`;
        try {
          const result = await api<{ status?: string; verified?: boolean; failures?: unknown[] }>(path, {
            method: action === "archive" ? "POST" : "DELETE",
            body: JSON.stringify(action === "delete" ? { confirm: true } : kind === "projects" ? { expectedRevision: item.revision } : {}),
          });
          if (result?.status === "partial" || result?.verified === false || result?.failures?.length) {
            throw new Error(isUk ? "Операція виконана лише частково. Перевірте запис перед повтором." : "Operation only partially completed. Review the record before retrying.");
          }
          succeeded.add(item.id);
        } catch (error) { firstError ||= codeErrorMessage(error, isUk); }
      }
      if (!alive.current) return;
      setSelected(previous => new Set([...previous].filter(id => !succeeded.has(id))));
      setNotice(`${isUk ? "Виконано" : "Completed"}: ${succeeded.size} / ${targets.length}.${firstError ? ` ${firstError}` : ""}`);
      onChanged();
    } catch (error) {
      if (alive.current) setNotice(codeErrorMessage(error, isUk));
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const targets = items.filter(item => selected.has(item.id));
  return <section ref={panel} tabIndex={-1} className={`code-records-panel${fullscreen ? " is-fullscreen" : ""}`}
    aria-label={label} role={fullscreen ? "dialog" : undefined} aria-modal={fullscreen || undefined}>
    <div className="code-records-toolbar">
      <span className="code-records-count">{selected.size ? `${selected.size} / ` : ""}{items.length}</span>
      <RecordIconButton label={isUk ? "Вибрати всі записи" : "Select all records"} icon={CheckSquare} disabled={blocked || !items.length} onClick={() => setSelected(new Set(items.map(item => item.id)))} />
      <RecordIconButton label={isUk ? "Скасувати вибір" : "Clear selection"} icon={Square} disabled={blocked || !selected.size} onClick={() => setSelected(new Set())} />
      <span className="code-records-toolbar-spacer" />
      <RecordIconButton label={isUk ? "Архівувати вибрані" : "Archive selected"} icon={Archive} disabled={blocked || readOnly || !targets.some(item => item.status !== "archived")} onClick={() => void execute("archive", targets.filter(item => item.status !== "archived"))} />
      <RecordIconButton label={isUk ? "Видалити вибрані" : "Delete selected"} icon={Trash2} danger disabled={blocked || readOnly || !targets.length} onClick={() => void execute("delete", targets)} />
      <RecordIconButton label={collapsed ? (isUk ? "Розгорнути таблицю" : "Expand table") : (isUk ? "Згорнути таблицю" : "Collapse table")} icon={collapsed ? ChevronDown : ChevronUp} aria-expanded={!collapsed} aria-controls={contentId} onClick={() => setCollapsed(value => !value)} />
      <RecordIconButton label={fullscreen ? (isUk ? "Вийти з повного екрана" : "Exit fullscreen") : (isUk ? "На весь екран" : "Fullscreen")} icon={fullscreen ? Minimize2 : Maximize2} aria-pressed={fullscreen} onClick={() => { setCollapsed(false); setFullscreen(value => !value); }} />
    </div>
    {notice && <p className="code-records-notice" role="status">{notice}</p>}
    <div id={contentId} hidden={collapsed} className="code-records-content" aria-busy={busy}>
      <div className="automations-table-container">
        {children({ rows, selected, allVisible, someVisible, busy: blocked, toggle, togglePage, remove: item => void execute("delete", [item]) })}
      </div>
      <div className="code-records-pagination">
        <span>{items.length ? currentPage * 5 + 1 : 0}-{Math.min((currentPage + 1) * 5, items.length)} / {items.length}</span>
        <RecordIconButton label={isUk ? "Попередня сторінка" : "Previous page"} icon={ChevronLeft} disabled={blocked || currentPage === 0} onClick={() => setPage(currentPage - 1)} />
        <RecordIconButton label={isUk ? "Наступна сторінка" : "Next page"} icon={ChevronRight} disabled={blocked || currentPage === pages - 1} onClick={() => setPage(currentPage + 1)} />
      </div>
    </div>
  </section>;
}

export function RecordSelection({ label, checked, mixed, disabled, onChange }: {
  label: string; checked: boolean; mixed?: boolean; disabled: boolean; onChange(): void;
}) {
  return <input type="checkbox" aria-label={label} checked={checked} disabled={disabled}
    ref={input => { if (input) input.indeterminate = !!mixed; }} onChange={onChange} />;
}
