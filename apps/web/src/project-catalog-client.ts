import { getStoredAuthToken, getStoredAuthUser } from "./AuthContext";
import { apiFetch, type WebsiteProject } from "./website-builder-cache";
export interface CatalogPage { projects: WebsiteProject[]; pagination: { nextCursor: string | null } }
export interface CatalogFilters { companyId: string; search: string; status: string; framework: string; kind: string }
const cache = new Map<string, CatalogPage>();
const pending = new Map<string, { controller: AbortController; promise: Promise<CatalogPage>; users: number }>();
let identity: string | null | undefined;
function key(filters: CatalogFilters, cursor?: string) {
  const token = JSON.stringify([getStoredAuthToken(), getStoredAuthUser()?.id ?? null]);
  if (identity !== token) { cache.clear(); for (const entry of pending.values()) entry.controller.abort(); pending.clear(); identity = token; }
  return new URLSearchParams({ ...filters, ...(cursor ? { cursor } : {}) }).toString();
}
export function cachedCatalog(filters: CatalogFilters) { return cache.get(key(filters)); }
export function invalidateProjectCatalog() { cache.clear(); }
/** Refresh the head without unmounting older pages already being read. */
export function mergeCatalogRefresh(previous: WebsiteProject[], page: CatalogPage): WebsiteProject[] {
  const known = new Map(previous.map(item => [item.id, item]));
  const fresh = page.projects.map(item => {
    const old = known.get(item.id);
    return old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
  });
  const ids = new Set(fresh.map(item => item.id));
  const boundary = fresh.at(-1);
  const time = boundary?.createdAt ?? boundary?.updatedAt;
  const tail = page.pagination?.nextCursor && boundary ? previous.filter(item => {
    if (ids.has(item.id)) return false;
    const at = item.createdAt ?? item.updatedAt;
    // The server sorts by creation time descending and id ascending.
    return at < time! || at === time && item.id > boundary.id;
  }) : [];
  const merged = [...fresh, ...tail];
  return merged.length === previous.length && merged.every((item, index) => item === previous[index]) ? previous : merged;
}

export function requestCatalog(filters: CatalogFilters, cursor?: string, preservePages = false) {
  const query = key(filters, cursor);
  const saved = cursor ? cache.get(query) : undefined;
  if (saved) return { promise: Promise.resolve(saved), release() {} };
  if (!cursor && !preservePages) for (const pageKey of cache.keys()) if (pageKey.startsWith(query + "&cursor=")) cache.delete(pageKey);
  let entry = pending.get(query);
  if (!entry) {
    const controller = new AbortController();
    const params = new URLSearchParams(query);
    if (!filters.companyId) params.delete("companyId");
    const promise = apiFetch<CatalogPage>(`/projects/catalog?${params}`, { signal: controller.signal }).then(page => {
      if (!controller.signal.aborted) {
        if (cache.size >= 40) cache.delete(cache.keys().next().value!);
        cache.set(query, page);
      }
      return page;
    }).finally(() => { if (pending.get(query)?.controller === controller) pending.delete(query); });
    entry = { controller, promise, users: 0 }; pending.set(query, entry);
  }
  entry.users++;
  const shared = entry;
  let released = false;
  return { promise: shared.promise, release() {
    if (released) return; released = true; shared.users--;
    // A StrictMode remount or another subscriber may acquire the same request.
    queueMicrotask(() => { if (!shared.users && pending.get(query) === shared) { pending.delete(query); shared.controller.abort(); } });
  } };
}
export function prefetchProjectCatalog() {
  void import("./WebsiteBuilderDashboard");
  const initialFilters: CatalogFilters = { companyId: "", search: "", status: "all", framework: "all", kind: "all" };
  const req = requestCatalog(initialFilters);
  void req.promise.catch(() => {}).finally(() => req.release());
}
