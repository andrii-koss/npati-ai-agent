import type { MemoryItem } from "./types";
import { decodeBusinessCursor, encodeBusinessCursor } from "./pagination";

export const MEMORY_PAGE_SIZE = 10;
export const MEMORY_CATEGORIES = {
  facts: ["business_fact"],
  audience: ["audience", "channel"],
  brand: ["brand", "preference"],
  decisions: ["decision", "experiment", "result"],
  product: ["product"],
  other: ["other"],
} as const;

export type MemoryCategory = keyof typeof MEMORY_CATEGORIES;
export type MemoryCounts = Record<"all" | MemoryCategory, number>;
export type MemoryPageQuery = {
  businessId?: string;
  category?: MemoryCategory;
  search?: string;
  searchTypes?: readonly string[];
  after?: { updatedAt: string; id: string };
};
export type MemoryPageData = {
  items: MemoryItem[];
  counts: MemoryCounts | null;
  nextCursor: string | null;
};

export function memoryPageCursor(item: Pick<MemoryItem, "updatedAt" | "id">) {
  return encodeBusinessCursor({ createdAt: new Date(item.updatedAt).toISOString(), id: item.id });
}

export function decodeMemoryPageCursor(cursor: string) {
  try {
    const decoded = decodeBusinessCursor(cursor);
    if (decoded) return { updatedAt: decoded.createdAt, id: decoded.id };
  } catch { /* Report the invalid cursor through the memory route. */ }
  throw new Error("Invalid memory cursor");
}

export function countMemoryTypes(byType: ReadonlyMap<string, number>): MemoryCounts {
  const count = (types: readonly string[]) => types.reduce((total, type) => total + (byType.get(type) ?? 0), 0);
  return {
    all: [...byType.values()].reduce((total, size) => total + size, 0),
    facts: count(MEMORY_CATEGORIES.facts),
    audience: count(MEMORY_CATEGORIES.audience),
    brand: count(MEMORY_CATEGORIES.brand),
    decisions: count(MEMORY_CATEGORIES.decisions),
    product: count(MEMORY_CATEGORIES.product),
    other: count(MEMORY_CATEGORIES.other),
  };
}
