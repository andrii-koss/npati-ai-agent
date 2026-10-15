import type { FastifyInstance } from "fastify";
import { registerPlatformBaseRoutes } from "./platform-base-routes";
import { registerPlatformRoutes } from "./platform-routes";

export type RegisterPlatformBaseRoutesDeps = Parameters<typeof registerPlatformBaseRoutes>[1];
export type RegisterPlatformRoutesDeps = Parameters<typeof registerPlatformRoutes>[1];

export interface AppPlatformRoutesWiringDeps {
  app: FastifyInstance;
  baseDeps: RegisterPlatformBaseRoutesDeps;
  platformDeps: RegisterPlatformRoutesDeps;
}

export function registerAppPlatformRoutes(deps: AppPlatformRoutesWiringDeps) {
  const { app, baseDeps, platformDeps } = deps;
  registerPlatformBaseRoutes(app, baseDeps);
  return registerPlatformRoutes(app, platformDeps);
}
