
import type { FastifyInstance } from "fastify";
import { defaultSkillRegistry } from "@npati/skills";
import type { HealthResponse, ServiceHealth, ServiceStatus } from "@npati/shared";
import { createHubClient } from "@npati/hub-connector";
import { createWebResearch } from "@npati/web-research";
import { buildInfo } from "./build-info";
import type { ObjectStorage } from "./object-storage";
import { createProductionResilientAIEngine } from "./production-resilient-ai-engine";
import type { WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import { isAdministrator } from "./admin-access";

export interface HealthRouteDeps {
  aiEngine: ReturnType<typeof createProductionResilientAIEngine>;
  hub: ReturnType<typeof createHubClient>;
  store: WorkspaceStore;
  researchBundle?: ReturnType<typeof createWebResearch>;
  objectStorage?: ObjectStorage;
  redisHealthCheck: () => Promise<ServiceHealth>;
  coreBackendHealthCheck: () => Promise<ServiceHealth>;
  /** Decides who sees the component report. Without it (tests, tools) the full report is public as before. */
  authProvider?: AuthProvider;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  const { aiEngine, hub, store, researchBundle, objectStorage, redisHealthCheck, coreBackendHealthCheck, authProvider } = deps;

  app.get("/health/live", async () => ({
    status: "ok" as const,
    timestamp: new Date().toISOString(),
    build: buildInfo,
  }));

  // Anyone (load balancers, uptime monitors) may learn whether the service is up; which components run, their versions
  // and endpoints are shown only to administrators.
  app.get("/health", async (request): Promise<HealthResponse | Pick<HealthResponse, "status" | "timestamp">> => {
    const full = !authProvider || await authProvider.authenticate(request).then(isAdministrator, () => false);
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
    if (!full) return { status: degraded ? "degraded" : "ok", timestamp: new Date().toISOString() };
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

  app.get("/skills", async (request) => {
    await authProvider?.authenticate(request);
    return defaultSkillRegistry.list();
  });
}
