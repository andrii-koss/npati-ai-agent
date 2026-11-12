import { useCallback, useEffect, useRef, useState } from "react";
import { getStoredAuthToken } from "../AuthContext";
import { apiFetch } from "./helpers";
import type { DataStudioCatalog, DatabaseFilter } from "./types";

const cache = new Map<string, { value: DataStudioCatalog; at: number }>();
const inFlight = new Map<string, Promise<DataStudioCatalog>>();
let cacheToken: string | null | undefined;
const merge = (current: DataStudioCatalog, page: DataStudioCatalog): DataStudioCatalog => ({ ...page,
  items: [...new Map([...current.items, ...page.items].map(item => [item.id, item])).values()] });

export function useDataStudioCatalog(company: string, search: string, status: DatabaseFilter, reload: number) {
  const token = getStoredAuthToken();
  if (token !== cacheToken) { cache.clear(); inFlight.clear(); cacheToken = token; }
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => { const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const query = new URLSearchParams({ limit: "10", status, ...(company !== "all" ? { companyId: company } : {}), ...(debouncedSearch ? { search: debouncedSearch } : {}) }).toString();
  const key = JSON.stringify([token, query]);
  // Summary cards cover the company, regardless of the list's search/status filter.
  const summaryScope = JSON.stringify([token, company]);
  const [state, setState] = useState<{ key: string; data: DataStudioCatalog | null }>({ key, data: cache.get(key)?.value ?? null });
  const [summaryState, setSummaryState] = useState<{ scope: string; data: Pick<DataStudioCatalog, "companies" | "stats"> } | null>(() =>
    state.data ? { scope: summaryScope, data: { companies: state.data.companies, stats: state.data.stats } } : null);
  const [loading, setLoading] = useState(() => !cache.has(key) || Date.now() - cache.get(key)!.at >= 30_000), [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null), [moreError, setMoreError] = useState<unknown>(null);
  const epoch = useRef(0), locked = useRef(false), previousReload = useRef(reload);
  const current = useRef(state); current.current = state;
  const remember = useCallback((value: DataStudioCatalog) => {
    cache.set(key, { value, at: Date.now() });
    if (cache.size > 20) cache.delete(cache.keys().next().value!);
    current.current = { key, data: value }; setState(current.current);
    setSummaryState({ scope: summaryScope, data: { companies: value.companies, stats: value.stats } });
  }, [key, summaryScope]);
  const request = useCallback((cursor?: string, limit = 10) => {
    const params = new URLSearchParams(query); params.set("limit", String(limit)); if (cursor) params.set("cursor", cursor);
    const url = `/data-studio/catalog?${params}`;
    const requestKey = JSON.stringify([token, url]);
    let pending = inFlight.get(requestKey);
    if (!pending) {
      pending = apiFetch<DataStudioCatalog>(url).finally(() => inFlight.delete(requestKey));
      inFlight.set(requestKey, pending);
    }
    return pending;
  }, [query, token]);
  useEffect(() => {
    const version = ++epoch.current;
    const refreshed = previousReload.current !== reload; previousReload.current = reload;
    const previous = current.current.key === key ? current.current.data : null;
    if (refreshed) cache.clear();
    const cached = cache.get(key);
    setError(null); setMoreError(null); setLoadingMore(false); locked.current = false;
    if (cached && Date.now() - cached.at < 30_000) { remember(cached.value); setLoading(false); return; }
    setLoading(true);
    if (!previous) setState({ key, data: null });
    void (async () => {
      try {
        let value = await request();
        if (version !== epoch.current) return;
        // Preserve the loaded portion after a mutation, rather than jumping back to ten rows.
        const target = refreshed ? previous?.items.length ?? 10 : 10;
        while (value.items.length < target && value.pagination.nextCursor) {
          const page = await request(value.pagination.nextCursor, Math.min(50, target - value.items.length));
          if (version !== epoch.current) return;
          const next = merge(value, page);
          if (next.pagination.nextCursor && (next.pagination.nextCursor === value.pagination.nextCursor || next.items.length === value.items.length)) throw new Error("Catalog pagination did not advance");
          value = next;
        }
        if (version === epoch.current) remember(value);
      } catch (reason) { if (version === epoch.current) setError(reason); }
      finally { if (version === epoch.current) setLoading(false); }
    })();
    return () => { if (epoch.current === version) ++epoch.current; };
  }, [key, reload, request, remember]);

  const loadMore = useCallback(async (all = false) => {
    const data = current.current.key === key ? current.current.data : null;
    if (!data?.pagination.nextCursor || loading || locked.current) return data?.items ?? [];
    locked.current = true; setLoadingMore(true); setMoreError(null);
    const version = epoch.current;
    let value = data;
    try {
      do {
        const page = await request(value.pagination.nextCursor!, all ? 50 : 10);
        const next = merge(value, page);
        if (next.pagination.nextCursor && (next.pagination.nextCursor === value.pagination.nextCursor || next.items.length === value.items.length)) throw new Error("Catalog pagination did not advance");
        value = next;
        if (version !== epoch.current) return [];
        remember(value);
      } while (all && value.pagination.nextCursor);
      return value.items;
    } catch (reason) { if (version === epoch.current) setMoreError(reason); if (all) throw reason; return value.items; }
    finally { if (version === epoch.current) { locked.current = false; setLoadingMore(false); } }
  }, [key, loading, request, remember]);
  const data = state.key === key ? state.data : null;
  const summary = data ?? (summaryState?.scope === summaryScope ? summaryState.data : null);
  return { data, summary, loading: loading || state.key !== key, loadingMore, error, moreError, loadMore, queryKey: key, settlingSearch: search.trim() !== debouncedSearch };
}
