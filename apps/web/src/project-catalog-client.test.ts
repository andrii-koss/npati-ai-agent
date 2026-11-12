// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
let token = "one";
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => token, getStoredAuthUser: () => ({ id: token }) }));
import { cachedCatalog, mergeCatalogRefresh, requestCatalog } from "./project-catalog-client";
const filters = { companyId: "", search: "", status: "all", framework: "all", kind: "all" };
beforeEach(() => { token = crypto.randomUUID(); });
describe("catalog request cache", () => {
  it("keeps prefetched pages during a background refresh", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ projects: [], pagination: { nextCursor: "next" } })));
    vi.stubGlobal("fetch", fetch);
    const warm = requestCatalog(filters, "next"); await warm.promise; warm.release();
    const refresh = requestCatalog(filters, undefined, true); await refresh.promise; refresh.release();
    const next = requestCatalog(filters, "next"); await next.promise; next.release();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("retains older rows and stable objects while removing missing rows in the refreshed range", () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({ id: `p${index}`, companyId: "c", name: `Site ${index}`, type: "website" as const, status: "ready", revision: 1,
      createdAt: new Date(Date.UTC(2026, 10, 12) - index * 1000).toISOString(), updatedAt: "2026-11-12" }));
    const unchanged = { projects: rows.slice(0, 6).map(row => ({ ...row })), pagination: { nextCursor: "page2" } };
    expect(mergeCatalogRefresh(rows, unchanged)).toBe(rows);
    const inserted = { ...rows[0]!, id: "new", createdAt: "2026-11-13T00:00:00.000Z" };
    expect(mergeCatalogRefresh(rows, { projects: [inserted, ...rows.slice(0, 5)], pagination: { nextCursor: "new-head" } })).toEqual([inserted, ...rows]);
    expect(mergeCatalogRefresh(rows, { projects: rows.slice(1, 7), pagination: { nextCursor: "changed-head" } })).toEqual(rows.slice(1));
    expect(mergeCatalogRefresh(rows, { projects: rows.slice(0, 2), pagination: { nextCursor: null } })).toEqual(rows.slice(0, 2));
  });
  it("reuses the prefetched next page and discards it when the first page refreshes", async () => {
    const page = { projects: [], pagination: { nextCursor: null } };
    const fetch = vi.fn(async () => new Response(JSON.stringify(page)));
    vi.stubGlobal("fetch", fetch);
    const warm = requestCatalog(filters, "next"); await warm.promise; warm.release();
    const visible = requestCatalog(filters, "next"); await visible.promise; visible.release();
    expect(fetch).toHaveBeenCalledTimes(1);
    const refresh = requestCatalog(filters); await refresh.promise; refresh.release();
    const next = requestCatalog(filters, "next"); await next.promise; next.release();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("deduplicates subscribers and aborts only when the last subscriber leaves", async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
    vi.stubGlobal("fetch", fetch);
    const a = requestCatalog(filters), b = requestCatalog(filters);
    const caught = a.promise.catch(error => error.name);
    expect(fetch).toHaveBeenCalledTimes(1);
    a.release(); await Promise.resolve(); expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(false);
    b.release(); expect(await caught).toBe("AbortError");
  });
  it("keeps cached first-page results while refreshing and separates identities and filters", async () => {
    const old = { projects: [{ id: "old" }], pagination: { nextCursor: null } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(old))));
    const a = requestCatalog(filters); await a.promise; a.release();
    expect(cachedCatalog(filters)).toEqual(old);
    expect(cachedCatalog({ ...filters, companyId: "other" })).toBeUndefined();
    let complete!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
    const refresh = requestCatalog(filters);
    expect(cachedCatalog(filters)).toEqual(old);
    complete(new Response(JSON.stringify({ ...old, projects: [] }))); await refresh.promise; refresh.release();
    expect(cachedCatalog(filters)?.projects).toEqual([]);
    token = "other-user"; expect(cachedCatalog(filters)).toBeUndefined();
  });
  it("does not prefetch thumbnail images when catalog data arrives", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ projects: [{ id: "site", companyId: "company", hasThumbnail: true }], pagination: { nextCursor: null } })));
    vi.stubGlobal("fetch", fetch);
    const request = requestCatalog(filters);
    await request.promise; request.release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
