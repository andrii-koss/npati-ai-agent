import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Building2, Check, ChevronDown, Search, UserRound } from "lucide-react";
import { useTranslation } from "./i18n";

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> & {
  value: string;
  onValueChange: (value: string) => void;
  includeAll?: boolean;
  entity?: "company" | "business";
};
type Option = { value: string; label: string; disabled?: boolean };

function optionText(node: ReactNode): string {
  return Children.toArray(node).map((child) => isValidElement<{ children?: ReactNode }>(child)
    ? optionText(child.props.children) : String(child)).join("");
}

/** Shared company scope picker; option values and scope callbacks belong to each page. */
export function CompanyScopeSelect({ children, value, onValueChange, includeAll = true, entity = "company", className, style, id, disabled, title, "aria-label": ariaLabel, "aria-labelledby": labelledBy, "aria-busy": busy }: Props) {
  const { language } = useTranslation();
  const isUk = language === "uk";
  const uid = useId();
  const listId = `${uid}-companies`;
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 488 });
  const options: Option[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ value: string; children?: ReactNode; title?: string; disabled?: boolean }>(child) || child.type !== "option") return;
    options.push({ value: String(child.props.value), label: child.props.title || optionText(child.props.children), disabled: child.props.disabled });
  });
  if (includeAll && !options.some(option => option.value === "all" || option.value === "")) {
    options.unshift({ value: "all", label: isUk ? "Усі компанії" : "All companies" });
  }
  const filtered = options.filter((option) => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = options.find((option) => option.value === value);
  const companyCount = options.filter((option) => option.value && !["all", "__all__", "personal", "none"].includes(option.value)).length;
  const heading = entity === "business" ? (isUk ? "Виберіть бізнес" : "Select business") : (isUk ? "Виберіть компанію" : "Select company");
  const searchLabel = entity === "business" ? (isUk ? "Пошук бізнесів" : "Search businesses") : (isUk ? "Пошук компаній" : "Search companies");
  const countLabel = entity === "business" ? (isUk ? "бізнесів" : "businesses") : (isUk ? "компаній" : "companies");

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const choose = (option: Option) => {
    if (option.disabled) return;
    onValueChange(option.value);
    close(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(440, window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const upward = below < 300 && above > below;
      const height = Math.min(488, upward ? above : below);
      const panelHeight = Math.min(height, panel.current?.getBoundingClientRect().height || height);
      setPosition({
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        top: upward ? Math.max(12, rect.top - panelHeight - 6) : rect.bottom + 6,
        maxHeight: Math.max(140, height),
      });
    };
    place();
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(true); }
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, query, options.length]);

  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, listId]);

  return <>
    <button ref={trigger} type="button" id={id} disabled={disabled}
      className={`company-scope-trigger ${className || ""}`} style={style}
      title={title || selected?.label} aria-label={ariaLabel} aria-labelledby={labelledBy} aria-busy={busy}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${uid}-panel` : undefined}
      onClick={() => { setQuery(""); setActive(-1); setOpen(!open); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setQuery(""); setActive(-1); setOpen(true);
        }
      }}>
      <span>{selected?.label || ariaLabel || heading}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panel} id={`${uid}-panel`} className="company-scope-popover"
      role="dialog" aria-label={heading} style={position}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          let next = active < 0 && step < 0 ? 0 : active;
          for (let i = 0; i < filtered.length; i++) {
            next = (next + step + filtered.length) % filtered.length;
            if (!filtered[next]?.disabled) { setActive(next); break; }
          }
        } else if (event.key === "Enter" && filtered[active]) {
          event.preventDefault(); choose(filtered[active]);
        } else if (event.key === "Tab") {
          close(true);
        }
      }}>
      <div className="company-scope-heading">
        <Building2 size={22} aria-hidden="true" /><strong>{heading}</strong>
        <span>{companyCount} {countLabel}</span>
      </div>
      <div className="company-scope-search">
        <Search size={20} aria-hidden="true" />
        <input ref={search} type="text" role="combobox" autoComplete="off" spellCheck={false}
          aria-label={searchLabel}
          placeholder={`${searchLabel}${isUk ? "…" : "..."}`}
          value={query} onChange={(event) => { setQuery(event.target.value); setActive(-1); }}
          aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} />
      </div>
      <div className="company-scope-options" role="listbox" id={listId} aria-label={heading}>
        {filtered.map((option, index) => {
          const Icon = option.value === "personal" ? UserRound : Building2;
          return <div key={option.value} id={`${listId}-${index}`} role="option"
            aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
            className={`company-scope-option${index === active ? " is-active" : ""}`}
            title={option.label} onPointerDown={(event) => event.preventDefault()}
            onClick={() => choose(option)}>
            <Icon size={19} aria-hidden="true" /><span>{option.label}</span>
            {option.value === value && <Check size={23} className="company-scope-check" aria-hidden="true" />}
          </div>;
        })}
        {filtered.length === 0 && <p className="company-scope-empty" role="status">{isUk ? "Компаній не знайдено" : "No companies found"}</p>}
      </div>
    </div>, document.body)}
  </>;
}
