import { createHash } from "node:crypto";

export interface CacheEntry<T = unknown> {
  key: string;
  normalizedQuery: string;
  data: T;
  expiresAt: number;
  hits: number;
}

export interface SemanticCacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRatio: number;
}

export class SemanticCache<T = unknown> {
  private cache = new Map<string, CacheEntry<T>>();
  private totalHits = 0;
  private totalMisses = 0;

  constructor(
    private readonly defaultTtlMs = 3600_000, // 1 hour
    private readonly maxEntries = 1000
  ) {}

  private normalize(query: string): string {
    return query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private hashKey(normalized: string, scopeKey = ""): string {
    return createHash("sha256").update(`${scopeKey}:${normalized}`).digest("hex");
  }

  get(query: string, scopeKey = ""): T | null {
    const normalized = this.normalize(query);
    if (!normalized) return null;

    const key = this.hashKey(normalized, scopeKey);
    const entry = this.cache.get(key);

    if (!entry) {
      this.totalMisses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.totalMisses++;
      return null;
    }

    entry.hits++;
    this.totalHits++;
    return entry.data;
  }

  set(query: string, data: T, scopeKey = "", ttlMs = this.defaultTtlMs): void {
    const normalized = this.normalize(query);
    if (!normalized) return;

    // Prune if cache is full
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    const key = this.hashKey(normalized, scopeKey);
    this.cache.set(key, {
      key,
      normalizedQuery: normalized,
      data,
      expiresAt: Date.now() + ttlMs,
      hits: 0,
    });
  }

  invalidate(scopeKey = ""): number {
    let deleted = 0;
    if (!scopeKey) {
      deleted = this.cache.size;
      this.cache.clear();
      return deleted;
    }

    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(createHash("sha256").update(`${scopeKey}:`).digest("hex").slice(0, 8))) {
        this.cache.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  stats(): SemanticCacheStats {
    const total = this.totalHits + this.totalMisses;
    return {
      hits: this.totalHits,
      misses: this.totalMisses,
      size: this.cache.size,
      hitRatio: total > 0 ? Number((this.totalHits / total).toFixed(3)) : 0,
    };
  }

  clear(): void {
    this.cache.clear();
    this.totalHits = 0;
    this.totalMisses = 0;
  }
}
