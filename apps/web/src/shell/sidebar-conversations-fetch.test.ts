import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllSidebarConversations } from "./sidebar-cache";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const businesses = Array.from({ length: 30 }, (_, index) => ({ id: `b${index}`, name: `Business ${index}` }));

afterEach(() => vi.unstubAllGlobals());

describe("sidebar conversations", () => {
  it("loads every Business conversation with one request instead of one per Business", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url === "/api/conversations") return json([{ id: "n1", title: "Neutral", updatedAt: "2026-10-29T10:00:00Z" }]);
      if (url === "/api/business-conversations") return json([
        { id: "c1", title: "Bakery chat", updatedAt: "2026-10-29T11:00:00Z", businessId: "b3", businessName: "stale" },
        { id: "c2", title: "Foreign", updatedAt: "2026-10-29T12:00:00Z", businessId: "unknown", businessName: "Other" },
      ]);
      return json([]);
    }));
    const rows = await fetchAllSidebarConversations(businesses);
    expect(urls.sort()).toEqual(["/api/business-conversations", "/api/conversations"]);
    expect(rows.map((row) => [row.id, row.businessId, row.businessName])).toEqual([["c1", "b3", "Business 3"], ["n1", null, ""]]);
  });

  it("falls back to per-Business requests when the server has no combined route", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url === "/api/business-conversations") return json({ error: "Not Found" }, 404);
      return json([]);
    }));
    await fetchAllSidebarConversations(businesses.slice(0, 3));
    expect(urls).toContain("/api/businesses/b2/conversations");
  });
});
