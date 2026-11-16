import { useEffect, useRef, useState } from "react";

/** Mount the first screen now; more cards mount only after scroll intent. */
export function useProgressiveSettingsItems<T>(items: T[], key: string, pageSize = 12) {
  const [window, setWindow] = useState({ key, count: pageSize });
  const count = window.key === key ? window.count : pageSize;
  const target = useRef<HTMLDivElement>(null);
  const hasMore = count < items.length;
  const more = () => setWindow(previous => ({ key, count: (previous.key === key ? previous.count : pageSize) + pageSize }));
  const moreRef = useRef(more); moreRef.current = more;
  const armed = useRef(false);
  useEffect(() => { armed.current = false; }, [key]);
  useEffect(() => {
    if (!hasMore || !target.current || !globalThis.IntersectionObserver) return;
    let observer: IntersectionObserver | undefined;
    const observe = () => {
      if (observer || !target.current) return;
      armed.current = true;
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); moreRef.current(); }
      }, { rootMargin: "0px 0px 400px 0px" });
      observer.observe(target.current);
    };
    const onKey = (event: KeyboardEvent) => { if (["PageDown", "End", "ArrowDown", " "].includes(event.key)) observe(); };
    document.addEventListener("wheel", observe, { passive: true });
    document.addEventListener("touchmove", observe, { passive: true });
    document.addEventListener("keydown", onKey);
    if (armed.current) observe();
    return () => { observer?.disconnect(); document.removeEventListener("wheel", observe); document.removeEventListener("touchmove", observe); document.removeEventListener("keydown", onKey); };
  }, [hasMore, count, key]);
  return { items: items.slice(0, count), hasMore, target, more };
}

export function SettingsListMore({ state, label }: { state: ReturnType<typeof useProgressiveSettingsItems>; label: string }) {
  return state.hasMore ? <div ref={state.target} style={{ display: "flex", justifyContent: "center", paddingBlock: 16 }}>
    <button type="button" className="button-secondary" onClick={state.more}>{label}</button>
  </div> : null;
}
