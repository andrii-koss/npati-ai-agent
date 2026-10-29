// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
let token = "one";
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => token, getStoredAuthUser: () => ({ id: token }) }));
import { cachedCatalog, requestCatalog } from "./project-catalog-client";
const filters = { companyId: "", search: "", status: "all", framework: "all", kind: "all" };
beforeEach(() => { token = crypto.randomUUID(); });
describe("catalog request cache", () => {
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
});
