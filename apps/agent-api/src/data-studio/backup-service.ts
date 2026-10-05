import { stat, unlink } from "node:fs/promises";
import type { AuthContext } from "@npati/workspace";
import { DataStudioError } from "./identifier";
import type { DataBackendRepository } from "./repository";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataProvider } from "./data-provider";
import type { DataBackend, DataEnvironmentName, ProjectSnapshot, SnapshotKind } from "./types";

/**
 * Snapshot storage boundary (D7).
 *
 * The default implementation keeps dumps in the provisioner snapshot directory, which is a
 * dedicated volume in the shipped compose files. A deployment that wants off-host backups can
 * implement this interface (S3-compatible storage) without touching backup logic.
 */
export interface SnapshotStorage {
  readonly name: string;
  store(snapshot: ProjectSnapshot): Promise<string>;
  remove(snapshot: ProjectSnapshot): Promise<void>;
  exists(snapshot: ProjectSnapshot): Promise<boolean>;
}

export class LocalSnapshotStorage implements SnapshotStorage {
  readonly name = "local_volume";

  async store(snapshot: ProjectSnapshot): Promise<string> {
    return snapshot.path;
  }

  async remove(snapshot: ProjectSnapshot): Promise<void> {
    await unlink(snapshot.path).catch(() => undefined);
  }

  async exists(snapshot: ProjectSnapshot): Promise<boolean> {
    return stat(snapshot.path).then(() => true).catch(() => false);
  }
}

export interface BackupPolicyResolved {
  environment: DataEnvironmentName;
  intervalMinutes: number;
  keep: number;
  retentionDays: number;
}

function policyFromEnv(environment: DataEnvironmentName, override?: { intervalMinutes?: number; keep?: number } | null): BackupPolicyResolved {
  const interval = Number(override?.intervalMinutes ?? process.env.NPATI_DATA_BACKUP_INTERVAL_MINUTES);
  const keep = Number(override?.keep ?? process.env.NPATI_DATA_BACKUP_KEEP);
  const retention = Number(process.env.NPATI_PROJECTS_SNAPSHOT_RETENTION_DAYS);
  return {
    environment,
    intervalMinutes: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : environment === "prod" ? 1440 : 0,
    keep: Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 7,
    retentionDays: Number.isFinite(retention) && retention > 0 ? Math.floor(retention) : 30,
  };
}

/**
 * D7 backups: scheduled and manual snapshots, retention pruning, approved restore, and the
 * two-phase purge of DataBackends whose retention window elapsed.
 */
export class BackupService {
  private readonly storage: SnapshotStorage;

  constructor(
    private readonly repository: DataBackendRepository,
    private readonly provisioner: DatabaseProvisioner,
    private readonly provider?: DataProvider,
    storage?: SnapshotStorage,
  ) {
    this.storage = storage ?? new LocalSnapshotStorage();
  }

  async policy(ctx: AuthContext, companyId: string, backendId: string, environment: DataEnvironmentName): Promise<BackupPolicyResolved> {
    const env = await this.repository.environment(ctx, companyId, backendId, environment);
    return policyFromEnv(environment, env.backupPolicy ?? null);
  }

  async updatePolicy(
    ctx: AuthContext,
    companyId: string,
    backendId: string,
    environment: DataEnvironmentName,
    patch: { intervalMinutes?: number; keep?: number },
  ): Promise<BackupPolicyResolved> {
    const current = await this.policy(ctx, companyId, backendId, environment);
    const next = {
      intervalMinutes: patch.intervalMinutes !== undefined ? Math.max(0, Math.floor(patch.intervalMinutes)) : current.intervalMinutes,
      keep: patch.keep !== undefined ? Math.max(1, Math.floor(patch.keep)) : current.keep,
    };
    await this.repository.setEnvironment(ctx, companyId, backendId, environment, { backupPolicy: next });
    return { ...current, ...next };
  }

  async list(ctx: AuthContext, companyId: string, backendId: string, environment: DataEnvironmentName, limit = 50): Promise<ProjectSnapshot[]> {
    await this.repository.get(ctx, companyId, backendId);
    return this.repository.listSnapshots(backendId, environment, limit);
  }

  async create(
    ctx: AuthContext,
    companyId: string,
    backendId: string,
    environment: DataEnvironmentName,
    options: { kind?: SnapshotKind; reason?: string } = {},
  ): Promise<ProjectSnapshot> {
    const backend = await this.repository.get(ctx, companyId, backendId);
    return this.snapshot(backend, environment, options.kind ?? "manual", options.reason, ctx.userId);
  }

  /** Takes and records a snapshot, resolving the storage location through the storage boundary. */
  async snapshot(backend: DataBackend, environment: DataEnvironmentName, kind: SnapshotKind, reason?: string, createdBy?: string): Promise<ProjectSnapshot> {
    const policy = policyFromEnv(environment, (await this.repository.environment({
      workspaceId: backend.workspaceId, userId: backend.createdBy, permissions: ["workspace:read"],
    }, backend.companyId, backend.id, environment)).backupPolicy ?? null);
    const snapshot = await this.provisioner.snapshot(backend, environment);
    const storedPath = await this.storage.store(snapshot);
    const size = await stat(storedPath).then((info) => info.size).catch(() => undefined);
    await this.repository.insertSnapshot(backend.id, environment, {
      id: snapshot.id,
      path: storedPath,
      kind,
      reason,
      sizeBytes: size,
      createdBy,
      retentionDays: policy.retentionDays,
    });
    return { ...snapshot, path: storedPath, kind, reason: reason ?? null, sizeBytes: size ?? null };
  }

  /** Restore is destructive: it needs explicit approval and snapshots the current state first. */
  async restore(
    ctx: AuthContext,
    companyId: string,
    backendId: string,
    environment: DataEnvironmentName,
    snapshotId: string,
    options: { approved?: boolean } = {},
  ): Promise<{ restoredSnapshotId: string; safetySnapshotId?: string; fingerprint?: string }> {
    const backend = await this.repository.get(ctx, companyId, backendId);
    const snapshot = await this.repository.getSnapshot(backend.id, environment, snapshotId);
    if (!snapshot) throw new DataStudioError(404, "restore", "Snapshot not found for this environment", false, "SNAPSHOT_NOT_FOUND");
    if (!options.approved) {
      throw new DataStudioError(
        409,
        "restore",
        `APPROVAL_REQUIRED: restoring ${environment} from snapshot ${snapshotId} replaces the current schema and data.`,
        false,
        "APPROVAL_REQUIRED",
      );
    }
    if (!await this.storage.exists(snapshot)) {
      throw new DataStudioError(410, "restore", "Snapshot file is no longer available", false, "SNAPSHOT_MISSING");
    }
    const safety = await this.snapshot(backend, environment, "pre_restore", `Automatic snapshot before restoring ${snapshotId}`, ctx.userId);
    await this.provisioner.restoreSnapshot(backend, environment, snapshot);

    let fingerprint: string | undefined;
    if (this.provider) {
      const schema = await this.provider.introspectSchema(backend, environment);
      fingerprint = this.provider.schemaFingerprint(schema);
      await this.repository.setExpectedSchema(ctx, companyId, backend.id, environment, schema, fingerprint);
    }
    return { restoredSnapshotId: snapshot.id, safetySnapshotId: safety.id, fingerprint };
  }

  /** Deletes snapshots past their retention window (files and metadata). */
  async prune(limit = 100): Promise<{ deleted: number; files: number }> {
    const expired = await this.repository.expiredSnapshots(limit);
    let files = 0;
    for (const snapshot of expired) {
      if (await this.storage.exists(snapshot)) { await this.storage.remove(snapshot); files += 1; }
      await this.repository.deleteSnapshotRecord(snapshot.id);
    }
    return { deleted: expired.length, files };
  }

  /**
   * Scheduler tick: automatic snapshots for due environments, retention pruning, and the
   * purge of DataBackends whose removal deadline passed.
   */
  async runScheduled(now = new Date()): Promise<{ created: number; pruned: number; purged: number }> {
    let created = 0;
    const backends = await this.repository.allBackends();
    for (const { backend, environments } of backends) {
      if (backend.status !== "ready") continue;
      for (const environment of environments) {
        if (environment.status !== "ready") continue;
        const policy = policyFromEnv(environment.environment, environment.backupPolicy ?? null);
        if (!policy.intervalMinutes) continue;
        const snapshots = await this.repository.listSnapshots(backend.id, environment.environment, 200);
        const lastScheduled = snapshots.filter((snapshot) => snapshot.kind === "scheduled")[0];
        const dueAt = lastScheduled ? Date.parse(lastScheduled.createdAt) + policy.intervalMinutes * 60_000 : 0;
        if (!lastScheduled || dueAt <= now.getTime()) {
          await this.snapshot(backend, environment.environment, "scheduled", "Scheduled backup", backend.createdBy);
          created += 1;
        }
        const surplus = await this.repository.surplusScheduledSnapshots(backend.id, environment.environment, policy.keep);
        for (const snapshot of surplus) {
          if (await this.storage.exists(snapshot)) await this.storage.remove(snapshot);
          await this.repository.deleteSnapshotRecord(snapshot.id);
        }
      }
    }
    const pruned = (await this.prune()).deleted;
    const purged = await this.purgeDueBackends();
    return { created, pruned, purged };
  }

  /**
   * Two-phase removal: a backend marked `deleting` is purged only after its retention deadline,
   * which keeps snapshots (and therefore rollback) available for the configured window.
   */
  async purgeDueBackends(): Promise<number> {
    const due = await this.repository.dueRemovals();
    let purged = 0;
    for (const backend of due) {
      const ctx: AuthContext = { workspaceId: backend.workspaceId, userId: backend.createdBy, permissions: ["workspace:read", "business:manage"] };
      for (const environment of ["dev", "prod"] as const) {
        await this.provisioner.deprovisionDatabase(backend, environment).catch(() => undefined);
      }
      const snapshots = await this.repository.deleteSnapshots(backend.id);
      for (const snapshot of snapshots) await this.storage.remove(snapshot);
      await this.repository.deleteSecrets(backend.id);
      await this.repository.remove(ctx, backend.companyId, backend.id).catch(() => undefined);
      purged += 1;
    }
    return purged;
  }
}
