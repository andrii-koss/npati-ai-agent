/* Data-backend, provisioning and project-auth services, extracted from app.ts
 * (step 2b-3 of docs/refactoring/PLAN.md).
 *
 * Shared vs external Postgres provisioners, the quota/promote/backup services, the Project
 * Auth service and the scheduled backup tick. The code is moved verbatim; the edits are the
 * closure locals that became parameters: workspaceStore -> store, app.log -> log, and the lazy
 * project lookup, which is passed in because projectService is created later in buildApp.
 */
import type { AppConfig } from "./app";
import { ProjectAuthService } from "./data-studio/auth-service";
import { MockEmailProvider, UnconfiguredEmailProvider } from "./data-studio/email-provider";
import { BackupService } from "./data-studio/backup-service";
import { PostgresDataProvider } from "./data-studio/data-provider";
import { ExternalPostgresProvisioner } from "./data-studio/external-provisioner";
import { ProjectMigrationEngine } from "./data-studio/migration-engine";
import { PromoteService } from "./data-studio/promote-service";
import { ProvisionerRouter, SharedPostgresProvisioner } from "./data-studio/provisioner";
import { QuotaService } from "./data-studio/quota-service";
import { ProjectRedirectRepository } from "./data-studio/redirect-repository";
import { DataBackendRepository } from "./data-studio/repository";
import { DataBackendService } from "./data-studio/service";
import type { WorkspaceStore } from "@npati/workspace";
import path from "node:path";

/** The pino-compatible slice of Fastify's logger that this domain uses. */
export interface DataBackendLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface DataBackendServicesInput {
  config: AppConfig;
  store: WorkspaceStore;
  log: DataBackendLogger;
  /** Lazy: projectService is declared after this factory runs and is only ever called later. */
  getProject: ConstructorParameters<typeof ProjectRedirectRepository>[0]["get"];
}

export function createDataBackendServices(input: DataBackendServicesInput) {
  const { config, store, log, getProject } = input;
  const dataBackendRepository = config.databaseUrl ? new DataBackendRepository(config.databaseUrl) : undefined;
  const projectsAdminPassword = process.env.NPATI_PROJECTS_POSTGRES_ADMIN_PASSWORD;
  const snapshotDirectory = process.env.NPATI_PROJECTS_SNAPSHOT_DIR || path.join(config.dataDirectory ?? ".data", "data-backend-snapshots");
  const sharedPostgresProvisioner = dataBackendRepository && projectsAdminPassword
    ? new SharedPostgresProvisioner({
        host: process.env.NPATI_PROJECTS_POSTGRES_HOST || "postgres-projects",
        port: Number(process.env.NPATI_PROJECTS_POSTGRES_PORT) || 5432,
        adminUser: process.env.NPATI_PROJECTS_POSTGRES_ADMIN_USER || "npati_projects_admin",
        adminPassword: projectsAdminPassword,
        maintenanceDatabase: process.env.NPATI_PROJECTS_POSTGRES_ADMIN_DB || "postgres",
        snapshotDirectory,
      }, dataBackendRepository)
    : undefined;
  // D7: DataBackends may live on the shared cluster or on an external Postgres the owner provides.
  const externalPostgresProvisioner = dataBackendRepository ? new ExternalPostgresProvisioner(dataBackendRepository, { snapshotDirectory }) : undefined;
  const databaseProvisioner = dataBackendRepository && (sharedPostgresProvisioner || externalPostgresProvisioner)
    ? new ProvisionerRouter(sharedPostgresProvisioner, externalPostgresProvisioner)
    : undefined;
  const dataProvider = databaseProvisioner ? new PostgresDataProvider({
    maxCollections: Number(process.env.NPATI_DATA_MAX_COLLECTIONS) || 50,
    maxFields: Number(process.env.NPATI_DATA_MAX_FIELDS) || 100,
    maxRows: Number(process.env.NPATI_DATA_MAX_ROWS) || 100,
    maxQueriesPerMinute: Number(process.env.NPATI_DATA_MAX_QUERIES_PER_MINUTE) || 600,
    maxDatabaseBytes: Number(process.env.NPATI_DATA_MAX_DATABASE_BYTES) || 1_000_000_000,
  }, databaseProvisioner) : undefined;
  const dataBackendService = dataBackendRepository ? new DataBackendService(store, dataBackendRepository, databaseProvisioner, dataProvider) : undefined;
  const projectMigrationEngine = dataBackendRepository && databaseProvisioner && dataProvider
    ? new ProjectMigrationEngine(databaseProvisioner, dataProvider, dataBackendRepository)
    : undefined;
  const quotaService = dataBackendRepository && databaseProvisioner
    ? new QuotaService(dataBackendRepository, databaseProvisioner)
    : undefined;
  const promoteService = dataBackendRepository && databaseProvisioner && projectMigrationEngine && dataProvider
    ? new PromoteService(dataBackendRepository, databaseProvisioner, projectMigrationEngine, dataProvider)
    : undefined;
  const backupService = dataBackendRepository && databaseProvisioner
    ? new BackupService(dataBackendRepository, databaseProvisioner, dataProvider)
    : undefined;
  const projectRedirectRepository = new ProjectRedirectRepository({ get: getProject }, config.databaseUrl ? (store as any)?.pool : undefined);
  const emailProvider = process.env.NODE_ENV === "production"
    ? new UnconfiguredEmailProvider()
    : new MockEmailProvider();
  const projectAuthService = dataBackendRepository && databaseProvisioner
    ? new ProjectAuthService({
        store: store,
        repository: dataBackendRepository,
        provisioner: databaseProvisioner,
        redirects: projectRedirectRepository,
        emailProvider,
      })
    : undefined;

  const backupTimer = backupService && (process.env.NPATI_DATA_BACKUP_DISABLED !== "true")
    ? setInterval(() => { void backupService.runScheduled().catch((error) => { log.error({ err: error }, "data_backup_tick_failed"); }); }, Math.max(60_000, (Number(process.env.NPATI_DATA_BACKUP_TICK_SECONDS) || 300) * 1000))
    : undefined;
  backupTimer?.unref();

  return {
    dataBackendRepository,
    projectsAdminPassword,
    snapshotDirectory,
    sharedPostgresProvisioner,
    externalPostgresProvisioner,
    databaseProvisioner,
    dataProvider,
    dataBackendService,
    projectMigrationEngine,
    quotaService,
    promoteService,
    backupService,
    projectRedirectRepository,
    projectAuthService,
    backupTimer,
  };
}
