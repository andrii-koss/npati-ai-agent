import type { Pool } from "pg";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { ProjectAuthSettings } from "@npati/shared";
import type { DataBackendRepository } from "./repository";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataBackend, DataEnvironmentName } from "./types";
import type { AuthRateLimiter, ProjectKeyBundle } from "./auth-crypto";
import type { EmailProvider } from "./email-provider";
import type { ProjectRedirectRepository } from "./redirect-repository";

export interface ProjectAuthHost {
  store: WorkspaceStore;
  repository: DataBackendRepository;
  provisioner: DatabaseProvisioner;
  emailProvider: EmailProvider;
  rateLimiter: AuthRateLimiter;
  poolFactory?: (backend: DataBackend, environment: DataEnvironmentName, role: "migrator" | "runtime") => Promise<Pool> | Pool;
  redirects?: ProjectRedirectRepository;

  ownerContext(backend: DataBackend): AuthContext;
  resolveAuthRedirect(
    backend: DataBackend,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    redirectTo?: string,
  ): Promise<string | null>;
  authLink(redirectTo: string | null, token: string): string | undefined;
  getBackend(ctx: AuthContext, companyId: string, projectId: string): Promise<DataBackend>;
  getPool(backend: DataBackend, environment: DataEnvironmentName, role: "migrator" | "runtime"): Promise<Pool>;
  ensureInitialized(ctx: AuthContext, backend: DataBackend, environment: DataEnvironmentName): Promise<ProjectKeyBundle>;
  getAuthSettings(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName): Promise<ProjectAuthSettings>;
  expectedIss(backendId: string, environment: DataEnvironmentName): string;
  expectedAud(backendId: string, environment: DataEnvironmentName): string;
}
