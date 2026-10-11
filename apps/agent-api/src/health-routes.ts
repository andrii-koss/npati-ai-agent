
import type { FastifyInstance } from "fastify";
import { defaultSkillRegistry } from "@npati/skills";
import type { HealthResponse, ServiceHealth, ServiceStatus } from "@npati/shared";
import { createHubClient } from "@npati/hub-connector";
import { createWebResearch } from "@npati/web-research";
import { buildInfo } from "./build-info";
import type { ObjectStorage } from "./object-storage";
import { createProductionResilientAIEngine } from "./production-resilient-ai-engine";
import type { WorkspaceStore } from "@npati/workspace";

export interface HealthRouteDeps {
  aiEngine: ReturnType<typeof createProductionResilientAIEngine>;
  hub: ReturnType<typeof createHubClient>;
  store: WorkspaceStore;
  researchBundle?: ReturnType<typeof createWebResearch>;
  objectStorage?: ObjectStorage;
  redisHealthCheck: () => Promise<ServiceHealth>;
  coreBackendHealthCheck: () => Promise<ServiceHealth>;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  const { aiEngine, hub, store, researchBundle, objectStorage, redisHealthCheck, coreBackendHealthCheck } = deps;

  app.get("/health/live", async () => ({
    status: "ok" as const,
    timestamp: new Date().toISOString(),
    build: buildInfo,
  }));

  app.get("/health", async (): Promise<HealthResponse> => {
    const [omniroute, hubHealth, databaseStatus, crawlerStatus, storageStatus, redisHealth, coreBackendHealth] = await Promise.all([
      aiEngine.healthCheck(),
      hub.healthCheck(),
      store.health(),
      researchBundle?.crawler?.healthCheck() ?? Promise.resolve("not_configured" as const),
      objectStorage?.health() ?? Promise.resolve("not_configured" as const),
      redisHealthCheck(),
      coreBackendHealthCheck(),
    ]);
    const requiredStatuses: ServiceStatus[] = [
      omniroute.status,
      databaseStatus,
      crawlerStatus,
      storageStatus,
      redisHealth.status,
      coreBackendHealth.status,
    ];
    const degraded = requiredStatuses.some((status) => status === "degraded" || status === "unavailable");
    return {
      status: degraded ? "degraded" : "ok",
      timestamp: new Date().toISOString(),
      services: {
        agent: "ok",
        database: databaseStatus,
        omniroute: omniroute.status,
        redis: redisHealth.status,
        crawler: crawlerStatus,
        hub: hubHealth.status,
        storage: storageStatus,
        coreBackend: coreBackendHealth.status,
      },
      details: {
        omniroute,
        redis: redisHealth,
        crawler: { status: crawlerStatus },
        database: { status: databaseStatus },
        hub: hubHealth,
        storage: { status: storageStatus },
        coreBackend: coreBackendHealth,
      },
    };
  });

  app.get("/skills", async () => defaultSkillRegistry.list());
}
