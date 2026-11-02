
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { withHealthTimeout } from "./backend-health-probe";
import { InMemoryActiveSessionRegistry, RedisActiveSessionRegistry } from "./distributed-session-registry";
import { ServiceHealth } from "@npati/shared";
import { createClient } from "redis";
import { setCompactionSummaryStore } from "./context-compactor";

export interface CreateRedisHealthWiringDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  app: FastifyInstance;
}

export function createRedisHealthWiring(deps: CreateRedisHealthWiringDeps) {
  const { config, log, app } = deps;
  const activeChatStreams=new Map<string,{controller:AbortController;workspaceId:string;userId:string;onUserStop?:()=>void}>();
  const activeSessionRegistry = config.activeSessionRegistry ?? (config.redisUrl ? new RedisActiveSessionRegistry(config.redisUrl) : new InMemoryActiveSessionRegistry());
  let redisHealthClient: ReturnType<typeof createClient> | undefined;
  let redisHealthConnecting: Promise<ReturnType<typeof createClient>> | undefined;
  const getRedisHealthClient = async () => {
    if (redisHealthClient?.isReady) return redisHealthClient;
    if (!config.redisUrl) throw new Error("Redis URL is not configured");
    if (!redisHealthConnecting) redisHealthConnecting = (async () => {
      const client = createClient({ url: config.redisUrl, socket: { connectTimeout: 2_500 } });
      client.on("error", () => undefined);
      redisHealthClient = client;
      await client.connect();
      return client;
    })().finally(() => { redisHealthConnecting = undefined; });
    return redisHealthConnecting;
  };
  const defaultRedisHealthCheck = async (): Promise<ServiceHealth> => {
    if (!config.redisUrl) return { status: "not_configured", detail: "Redis URL is not configured" };
    try {
      const client = await withHealthTimeout(getRedisHealthClient(), 4_000);
      const pong = await withHealthTimeout(client.ping(), 2_000);
      return pong === "PONG"
        ? { status: "ok", detail: "Redis PING succeeded" }
        : { status: "degraded", detail: `Unexpected Redis response: ${pong}` };
    } catch (error) {
      if (redisHealthClient?.isOpen) redisHealthClient.destroy();
      redisHealthClient = undefined;
      return { status: "unavailable", detail: error instanceof Error ? error.message : "Redis PING failed" };
    }
  };
  const redisHealthCheck = config.redisHealthCheck ?? defaultRedisHealthCheck;
  // Chat compaction block summaries survive API restarts; keys are content hashes and expire after 7 days.
  if (config.redisUrl) setCompactionSummaryStore({
    get: async (key) => (await withHealthTimeout(getRedisHealthClient(), 2_500)).get("npati:compaction:v1:" + key),
    set: async (key, summary) => (await withHealthTimeout(getRedisHealthClient(), 2_500)).set("npati:compaction:v1:" + key, summary, { EX: 7 * 24 * 3600 }),
  });
  app.addHook("onClose", async () => {
    setCompactionSummaryStore(undefined);
    await activeSessionRegistry.close();
    if (redisHealthClient?.isOpen) await redisHealthClient.quit().catch(() => redisHealthClient?.destroy());
  });

  return {
    activeChatStreams,
    activeSessionRegistry,
    redisHealthCheck,
  };
}
