import { usageQuotasEnabled } from "../usage-quota-policy";
import type { AuthContext } from "@npati/workspace";
import { DataStudioError } from "./identifier";
import type { DataBackendRepository } from "./repository";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataBackend, DataEnvironmentName, ProjectDatabaseUsage } from "./types";

export interface QuotaLimits {
  maxDatabaseBytes: number;
  maxConnections: number;
  maxCollections: number;
  maxFields: number;
  maxQueriesPerMinute: number;
}

export interface QuotaReport {
  usageQuotasEnabled?: boolean;
  environment: DataEnvironmentName;
  usage: ProjectDatabaseUsage;
  limits: QuotaLimits;
  state: "ok" | "warning" | "exceeded";
  /** Percentage of the database size limit that is used (0-100+, rounded). */
  databasePercent: number;
  writesBlocked: boolean;
  message?: string;
}

/** Usage above this share of the limit produces a warning before writes are blocked. */
export const QUOTA_WARNING_RATIO = 0.8;

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * D7 quotas: one place that resolves per-environment limits (environment override → platform
 * default), reports usage state for Data Studio and blocks writes when the hard limit is hit.
 */
export class QuotaService {
  private readonly cache = new Map<string, { usage: ProjectDatabaseUsage; at: number }>();

  constructor(
    private readonly repository: DataBackendRepository,
    private readonly provisioner: DatabaseProvisioner,
    private readonly usageTtlMs = 30_000,
  ) {}

  resolveLimits(environment: DataEnvironmentName, override?: Record<string, number> | null): QuotaLimits {
    const defaults: QuotaLimits = {
      maxDatabaseBytes: envNumber("NPATI_DATA_MAX_DATABASE_BYTES", 1_000_000_000),
      maxConnections: envNumber("NPATI_DATA_MAX_CONNECTIONS", environment === "prod" ? 10 : 10),
      maxCollections: envNumber("NPATI_DATA_MAX_COLLECTIONS", 50),
      maxFields: envNumber("NPATI_DATA_MAX_FIELDS", 100),
      maxQueriesPerMinute: envNumber("NPATI_DATA_MAX_QUERIES_PER_MINUTE", 600),
    };
    const bounded = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);
    return {
      maxDatabaseBytes: bounded(override?.maxDatabaseBytes, defaults.maxDatabaseBytes),
      maxConnections: bounded(override?.maxConnections, defaults.maxConnections),
      maxCollections: bounded(override?.maxCollections, defaults.maxCollections),
      maxFields: bounded(override?.maxFields, defaults.maxFields),
      maxQueriesPerMinute: bounded(override?.maxQueriesPerMinute, defaults.maxQueriesPerMinute),
    };
  }

  async usage(backend: DataBackend, environment: DataEnvironmentName): Promise<ProjectDatabaseUsage> {
    const key = `${backend.id}:${environment}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.usageTtlMs) return cached.usage;
    const usage = await this.provisioner.getUsage(backend, environment).catch(() => ({ bytes: 0, connections: 0 }));
    this.cache.set(key, { usage, at: Date.now() });
    return usage;
  }

  invalidate(backendId: string, environment?: DataEnvironmentName) {
    for (const key of [...this.cache.keys()]) {
      if (environment ? key === `${backendId}:${environment}` : key.startsWith(`${backendId}:`)) this.cache.delete(key);
    }
  }

  async report(ctx: AuthContext, companyId: string, backendId: string, environment: DataEnvironmentName): Promise<QuotaReport> {
    const backend = await this.repository.get(ctx, companyId, backendId);
    const env = await this.repository.environment(ctx, companyId, backendId, environment);
    const limits = this.resolveLimits(environment, env.limits);
    const usage = await this.usage(backend, environment);
    const databasePercent = limits.maxDatabaseBytes > 0 ? Math.round((usage.bytes / limits.maxDatabaseBytes) * 100) : 0;
    const exceeded = usageQuotasEnabled() && usage.bytes >= limits.maxDatabaseBytes;
    const warning = usageQuotasEnabled() && !exceeded && databasePercent >= QUOTA_WARNING_RATIO * 100;
    const connectionExceeded = usage.connections > limits.maxConnections;
    return {
      environment,
      usageQuotasEnabled: usageQuotasEnabled(),
      usage,
      limits,
      state: exceeded || connectionExceeded ? "exceeded" : warning ? "warning" : "ok",
      databasePercent,
      writesBlocked: exceeded,
      message: exceeded
        ? `Database size limit reached (${usage.bytes} of ${limits.maxDatabaseBytes} bytes). Delete data or raise the limit before writing again.`
        : connectionExceeded
          ? `Connection limit reached (${usage.connections} of ${limits.maxConnections}).`
          : warning
            ? `Database is at ${databasePercent}% of its size limit.`
            : undefined,
    };
  }

  /** Throws before a write when the environment exceeded its database quota. */
  async assertWritesAllowed(backend: DataBackend, environment: DataEnvironmentName): Promise<void> {
    if (!usageQuotasEnabled()) return;
    const env = await this.repository.environment({
      workspaceId: backend.workspaceId, userId: backend.createdBy, permissions: ["workspace:read"],
    }, backend.companyId, backend.id, environment);
    const limits = this.resolveLimits(environment, env.limits);
    const usage = await this.usage(backend, environment);
    if (usage.bytes >= limits.maxDatabaseBytes) {
      throw new DataStudioError(
        507,
        "quota",
        `QUOTA_EXCEEDED: database size limit reached (${usage.bytes} of ${limits.maxDatabaseBytes} bytes). Writes are blocked until data is removed or the limit is raised.`,
        false,
        "QUOTA_EXCEEDED",
      );
    }
  }
}
