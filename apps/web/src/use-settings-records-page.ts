import { useEffect, useRef, useState } from "react";
import { readSettingsSnapshot, writeSettingsSnapshot } from "./settings-page-cache";

type RecordsPage = { counts: unknown; nextCursor: string | null };

export function useSettingsRecordsPage<Data extends RecordsPage, Filters>(
  filters: Filters,
  options: {
    scope: string;
    unfiltered: boolean;
    open: () => Promise<Data>;
    fetch: (filters: Filters, cursor?: string) => Promise<Data>;
    append: (current: Data, next: Data) => Data;
    changedEvent?: string;
    onError: (message: string) => void;
  },
) {
  const { scope, unfiltered, changedEvent } = options;
  const key = JSON.stringify([scope, filters]);
  const [result, setResult] = useState<{ scope: string; key: string; version: number; data: Data }>();
  const [failedKey, setFailedKey] = useState<string>();
  const version = useRef(0);
  const appendRequest = useRef<number | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);
  const cached = readSettingsSnapshot<Data>(scope);
  const page = result?.key === key ? result.data : unfiltered ? cached : undefined;
  const counts = (page?.counts ?? (result?.scope === scope ? result.data.counts : null) ?? cached?.counts) as Data["counts"] | undefined;
  const nextCursor = page?.nextCursor;
  const reload = useRef<(fresh?: boolean) => Promise<void>>(async () => {});
  const latest = useRef({ filters, options });
  latest.current = { filters, options };

  reload.current = async (fresh = true) => {
    const requestVersion = ++version.current;
    setFailedKey(undefined);
    try {
      const data = unfiltered && !fresh ? await options.open() : await options.fetch(filters);
      if (version.current !== requestVersion) return;
      if (unfiltered && fresh) writeSettingsSnapshot(scope, data);
      setResult({ key, scope, version: requestVersion, data });
    } catch (reason) {
      if (version.current !== requestVersion) return;
      setFailedKey(key);
      latest.current.options.onError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    void reload.current(false);
    const reloadCurrent = () => { void reload.current(); };
    if (changedEvent) window.addEventListener(changedEvent, reloadCurrent);
    window.addEventListener("npati:business-changed", reloadCurrent);
    return () => {
      ++version.current;
      if (changedEvent) window.removeEventListener(changedEvent, reloadCurrent);
      window.removeEventListener("npati:business-changed", reloadCurrent);
    };
  }, [key, changedEvent]);

  const loadMore = useRef<() => void>(() => {});
  loadMore.current = () => {
    if (!nextCursor) return;
    const requestVersion = version.current;
    if (result?.key !== key || result.version !== requestVersion || appendRequest.current === requestVersion) return;
    appendRequest.current = requestVersion;
    const { filters: activeFilters, options: activeOptions } = latest.current;
    void activeOptions.fetch(activeFilters, nextCursor).then(data => {
      if (version.current !== requestVersion) return;
      setResult(previous => {
        const current = previous?.key === key && previous.version === requestVersion ? previous.data : undefined;
        if (!current || current.nextCursor !== nextCursor) return previous;
        return { key, scope, version: requestVersion, data: activeOptions.append(current, data) };
      });
    }).catch(reason => {
      if (version.current === requestVersion) latest.current.options.onError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (appendRequest.current === requestVersion) appendRequest.current = undefined;
    });
  };

  useEffect(() => {
    if (!nextCursor) return;
    const loadMoreOnScroll = (event: Event) => {
      const target = bottom.current;
      if (!target || !(event.target instanceof Node) || !event.target.contains(target)
          || target.getBoundingClientRect().top > window.innerHeight + 150) return;
      loadMore.current();
    };
    const loadMoreOnWheel = (event: WheelEvent) => {
      const target = bottom.current;
      if (event.deltaY > 0 && event.target instanceof Node && target?.parentElement?.contains(event.target)
          && target.getBoundingClientRect().top <= window.innerHeight) loadMore.current();
    };
    document.addEventListener("scroll", loadMoreOnScroll, { passive: true, capture: true });
    document.addEventListener("wheel", loadMoreOnWheel, { passive: true });
    return () => {
      document.removeEventListener("scroll", loadMoreOnScroll, true);
      document.removeEventListener("wheel", loadMoreOnWheel);
    };
  }, [nextCursor]);

  return {
    page, counts, failed: failedKey === key, bottom,
    reload: () => reload.current(),
  };
}
