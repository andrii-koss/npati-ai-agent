import { createHash, randomUUID } from "node:crypto";
import { createClient } from "redis";

export type ActiveSessionLease = { sessionId: string; connectionId: string; expiresAt: string };
export interface ActiveSessionRegistry {
  acquire(workspaceId: string, userId: string, sessionId: string, ttlSeconds: number): Promise<ActiveSessionLease | undefined>;
  renew(workspaceId: string, userId: string, lease: ActiveSessionLease, ttlSeconds: number): Promise<boolean>;
  release(workspaceId: string, userId: string, lease: ActiveSessionLease): Promise<boolean>;
  count(workspaceId: string, userId: string): Promise<number>;
  close(): Promise<void>;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class RedisActiveSessionRegistry implements ActiveSessionRegistry {
  private client?: ReturnType<typeof createClient>;
  private connecting?: Promise<ReturnType<typeof createClient>>;
  constructor(private readonly redisUrl: string, private readonly prefix = "npati:active-sessions") {}
  private async getClient() {
    if (this.client?.isReady) return this.client;
    if (!this.connecting) this.connecting = (async () => {
      const client = createClient({ url: this.redisUrl });
      client.on("error", () => undefined);
      await client.connect();
      this.client = client;
      return client;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private keys(workspaceId: string, userId: string, sessionId: string) {
    const scope = digest(`${workspaceId}\0${userId}`);
    const member = digest(sessionId);
    return { leaseKey: `${this.prefix}:lease:${scope}:${member}`, indexKey: `${this.prefix}:index:${scope}`, member };
  }
  async acquire(workspaceId: string, userId: string, sessionId: string, ttlSeconds: number) {
    const client = await this.getClient();
    const connectionId = randomUUID();
    const { leaseKey, indexKey, member } = this.keys(workspaceId, userId, sessionId);
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    const result = await client.eval(
      "if redis.call('EXISTS',KEYS[1])==1 then return 0 end redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]) redis.call('ZADD',KEYS[2],ARGV[3],ARGV[4]) redis.call('EXPIRE',KEYS[2],ARGV[2]+60) return 1",
      { keys: [leaseKey, indexKey], arguments: [connectionId, String(ttlSeconds), String(expiresAtMs), member] },
    );
    return Number(result) === 1 ? { sessionId, connectionId, expiresAt: new Date(expiresAtMs).toISOString() } : undefined;
  }
  async renew(workspaceId: string, userId: string, lease: ActiveSessionLease, ttlSeconds: number) {
    const client = await this.getClient();
    const { leaseKey, indexKey, member } = this.keys(workspaceId, userId, lease.sessionId);
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    const result = await client.eval(
      "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('EXPIRE',KEYS[1],ARGV[2]) redis.call('ZADD',KEYS[2],ARGV[3],ARGV[4]) redis.call('EXPIRE',KEYS[2],ARGV[2]+60) return 1",
      { keys: [leaseKey, indexKey], arguments: [lease.connectionId, String(ttlSeconds), String(expiresAtMs), member] },
    );
    if (Number(result) === 1) lease.expiresAt = new Date(expiresAtMs).toISOString();
    return Number(result) === 1;
  }
  async release(workspaceId: string, userId: string, lease: ActiveSessionLease) {
    const client = await this.getClient();
    const { leaseKey, indexKey, member } = this.keys(workspaceId, userId, lease.sessionId);
    const result = await client.eval(
      "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('DEL',KEYS[1]) redis.call('ZREM',KEYS[2],ARGV[2]) return 1",
      { keys: [leaseKey, indexKey], arguments: [lease.connectionId, member] },
    );
    return Number(result) === 1;
  }
  async count(workspaceId: string, userId: string) {
    const client = await this.getClient();
    const indexKey = `${this.prefix}:index:${digest(`${workspaceId}\0${userId}`)}`;
    await client.zRemRangeByScore(indexKey, "-inf", Date.now());
    return client.zCard(indexKey);
  }
  async close() {
    const client = this.client;
    this.client = undefined;
    if (client?.isOpen) await client.quit().catch(() => client.destroy());
  }
}

export class InMemoryActiveSessionRegistry implements ActiveSessionRegistry {
  private readonly leases = new Map<string, ActiveSessionLease>();
  private nextPruneAt = 0;
  private key(w: string, u: string, s: string) { return `${w}\0${u}\0${s}`; }
  private prune() {
    const now = Date.now();
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = now + 1_000;
    for (const [key, lease] of this.leases) if (Date.parse(lease.expiresAt) <= now) this.leases.delete(key);
  }
  async acquire(w: string, u: string, s: string, ttl: number) { this.prune(); const key = this.key(w, u, s); if (this.leases.has(key)) return undefined; const lease = { sessionId: s, connectionId: randomUUID(), expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; this.leases.set(key, lease); return lease; }
  async renew(w: string, u: string, lease: ActiveSessionLease, ttl: number) { const key = this.key(w, u, lease.sessionId); if (this.leases.get(key)?.connectionId !== lease.connectionId) return false; lease.expiresAt = new Date(Date.now() + ttl * 1000).toISOString(); this.leases.set(key, lease); return true; }
  async release(w: string, u: string, lease: ActiveSessionLease) { const key = this.key(w, u, lease.sessionId); if (this.leases.get(key)?.connectionId !== lease.connectionId) return false; return this.leases.delete(key); }
  async count(w: string, u: string) { this.prune(); const prefix = `${w}\0${u}\0`; return [...this.leases.keys()].filter((key) => key.startsWith(prefix)).length; }
  async close() { this.leases.clear(); }
}
