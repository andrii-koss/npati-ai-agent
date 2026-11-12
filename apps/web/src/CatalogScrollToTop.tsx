import { useEffect, useState, type RefObject } from "react";
import { useTranslation } from "./i18n";

export function CatalogScrollToTop({ gridRef, items, anchorSelector, enabled = true }: {
  gridRef?: RefObject<HTMLDivElement | null>;
  items?: readonly unknown[];
  anchorSelector?: string;
  enabled?: boolean;
}) {
  const { language } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled) { setVisible(false); return; }
    const update = () => {
      if (anchorSelector) {
        const anchor = document.querySelector(anchorSelector);
        setVisible(Boolean(anchor && window.scrollY > 0 && anchor.getBoundingClientRect().top <= window.innerHeight * 0.75));
        return;
      }
      let rows = 0;
      let previousTop: number | undefined;
      for (const card of Array.from(gridRef?.current?.children ?? [])) {
        const rect = card.getBoundingClientRect();
        if (previousTop === undefined || Math.abs(rect.top - previousTop) > 1) {
          rows++;
          previousTop = rect.top;
        }
        if (rows === 3) {
          setVisible(window.scrollY > 0 && rect.top <= window.innerHeight - Math.min(rect.height, window.innerHeight) / 2);
          return;
        }
      }
      setVisible(false);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer = globalThis.ResizeObserver ? new ResizeObserver(update) : null;
    const observedElement = anchorSelector ? document.querySelector(anchorSelector) : gridRef?.current;
    if (observedElement) observer?.observe(observedElement);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [gridRef, items, anchorSelector, enabled]);

  if (!visible || !enabled) return null;
  const label = language === "uk" ? "Повернутися нагору" : "Back to top";
  return <button type="button" className="marketplace-scroll-top" aria-label={label} title={label}
    onClick={() => window.scrollTo({ top: 0, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth" })}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 12 6-6 6 6M12 6v12" />
    </svg>
  </button>;
}
