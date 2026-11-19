import { useEffect, useRef, useState } from "react";
import type { GoalPageQuery } from "@npati/workspace";
import { fetchGoalsPage, goalsPageKey, openGoalsPage, type GoalsPageData } from "./goals-page-read";
import { readSettingsSnapshot, writeSettingsSnapshot } from "./settings-page-cache";

type Filters = Omit<GoalPageQuery, "after">;

export function useGoalsPage(filters: Filters, onError: (message: string) => void) {
  const { businessId, status, priority, search } = filters;
  const scope = goalsPageKey(businessId);
  const key = JSON.stringify([scope, status, priority, search]);
  const unfiltered = !status && !priority && !search;
  const [result, setResult] = useState<{ scope: string; key: string; version: number; data: GoalsPageData }>();
  const [failedKey, setFailedKey] = useState<string>();
  const version = useRef(0);
  const appendRequest = useRef<number | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);
  const cached = readSettingsSnapshot<GoalsPageData>(scope);
  const page = result?.key === key ? result.data : unfiltered ? cached : undefined;
  const counts = page?.counts ?? (result?.scope === scope ? result.data.counts : null) ?? cached?.counts;
  const nextCursor = page?.nextCursor;
  const reload = useRef<(fresh?: boolean) => Promise<void>>(async () => {});
  const reportError = useRef(onError);
  reportError.current = onError;

  reload.current = async (fresh = true) => {
    const requestVersion = ++version.current;
    setFailedKey(undefined);
    try {
      const data = unfiltered && !fresh ? await openGoalsPage(businessId) : await fetchGoalsPage(filters);
      if (version.current !== requestVersion) return;
      if (unfiltered && fresh) writeSettingsSnapshot(scope, data);
      setResult({ key, scope, version: requestVersion, data });
    } catch (reason) {
      if (version.current !== requestVersion) return;
      setFailedKey(key);
      reportError.current(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    void reload.current(false);
    const reloadCurrent = () => { void reload.current(); };
    window.addEventListener("npati:goals-changed", reloadCurrent);
    window.addEventListener("npati:business-changed", reloadCurrent);
    return () => {
      ++version.current;
      window.removeEventListener("npati:goals-changed", reloadCurrent);
      window.removeEventListener("npati:business-changed", reloadCurrent);
    };
  }, [key]);

  useEffect(() => {
    if (!nextCursor) return;
    const loadMoreOnScroll = (event: Event) => {
      const target = bottom.current;
      if (!target || !(event.target instanceof Node) || !event.target.contains(target)
          || target.getBoundingClientRect().top > window.innerHeight + 150) return;
      const requestVersion = version.current;
      if (result?.key !== key || result.version !== requestVersion || appendRequest.current === requestVersion) return;
      appendRequest.current = requestVersion;
      void fetchGoalsPage({ businessId, status, priority, search }, nextCursor).then(data => {
        if (version.current !== requestVersion) return;
        setResult(previous => {
          const current = previous?.key === key && previous.version === requestVersion ? previous.data : undefined;
          if (!current || current.nextCursor !== nextCursor) return previous;
          return { key, scope, version: requestVersion, data: { ...current, goals: [...current.goals, ...data.goals], nextCursor: data.nextCursor } };
        });
      }).catch(reason => {
        if (version.current === requestVersion) reportError.current(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => {
        if (appendRequest.current === requestVersion) appendRequest.current = undefined;
      });
    };
    document.addEventListener("scroll", loadMoreOnScroll, { passive: true, capture: true });
    return () => document.removeEventListener("scroll", loadMoreOnScroll, true);
  }, [businessId, status, priority, search, nextCursor, key, scope, result?.key, result?.version]);

  return { page, counts, failed: failedKey === key, bottom, reload: () => reload.current() };
}
