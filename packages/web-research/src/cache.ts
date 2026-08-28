import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export interface ResearchCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export function researchCacheKey(namespace: string, value: unknown) {
  return "npati:web-research:" + namespace + ":" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class MemoryResearchCache implements ResearchCache {
  private readonly values = new Map<string, { value: unknown; expiresAt: number }>();
  async get<T>(key: string) {
    const item = this.values.get(key);
    if (!item) return undefined;
    if (item.expiresAt <= Date.now()) { this.values.delete(key); return undefined; }
    return item.value as T;
  }
  async set<T>(key: string, value: T, ttlSeconds: number) {
    this.values.set(key, { value, expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000 });
  }
  async delete(key: string) { this.values.delete(key); }
}

export class RedisResearchCache implements ResearchCache {
  private client?: RedisClientType;
  private connecting?: Promise<RedisClientType>;
  constructor(private readonly url: string) {}

  private async connection() {
    if (this.client?.isReady) return this.client;
    if (!this.connecting) {
      const client = createClient({ url: this.url });
      client.on("error", () => undefined);
      this.connecting = client.connect().then(() => {
        this.client = client as RedisClientType;
        return this.client;
      }).finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  async get<T>(key: string) {
    try {
      const value = await (await this.connection()).get(key);
      return value === null ? undefined : JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number) {
    try {
      await (await this.connection()).set(key, JSON.stringify(value), { EX: Math.max(1, ttlSeconds) });
    } catch { /* Research still works when Redis is temporarily unavailable. */ }
  }

  async delete(key: string) {
    try { await (await this.connection()).del(key); } catch { /* best effort */ }
  }
}